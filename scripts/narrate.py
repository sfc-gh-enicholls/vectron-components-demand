#!/usr/bin/env python3
"""
Add planner-facing rationales to deterministic agent proposals.

The design is intentionally one-way: the deterministic engine in agent.py owns
every figure, and Cortex is allowed to supply prose only. If the model emits,
alters or implies a numeral that does not reconcile to the row we already have,
the narrative is rejected and replaced with a deterministic template built from
the same facts.

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/narrate.py
    ALL_RUNS=1 MAX_PROPOSALS=120 SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/narrate.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import snowflake.connector  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _conn import load_connection  # noqa: E402


PRIMARY_MODEL = "claude-sonnet-4-5"
FALLBACK_MODEL = "llama3.1-70b"
MAX_PROPOSALS_DEFAULT = 60
MIN_TEXT_LENGTH = 40
MAX_TEXT_LENGTH = 700
RELATIVE_TOLERANCE = 0.01
NUMERAL_RE = re.compile(r"(?<!\d)[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?!\d)")
MARKDOWN_RE = re.compile(r"(?m)^\s*(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+)")


@dataclass(frozen=True)
class ProposalRow:
    proposal_id: str
    run_id: str
    run_type: str
    series_label: str
    product_name: str
    customer_name: str
    channel_name: str
    segment_abc: str | None
    segment_xyz: str | None
    proposal_type: str
    week_from: str
    week_to: str
    current_units: Decimal
    proposed_units: Decimal
    delta_units: Decimal
    delta_value_eur: Decimal
    confidence: Decimal
    trigger_summary: str
    diagnosis_text: str | None
    evidence_text: str | None


@dataclass(frozen=True)
class NarrativeDecision:
    rationale: str
    source: str
    model_name: str | None
    fallback_reason: str | None


def fetch_all(cur: snowflake.connector.cursor.SnowflakeCursor, sql: str,
              params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    cur.execute(sql, params)
    columns = [column[0] for column in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def parse_env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return max(1, int(raw))


def parse_json_object(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {"raw_text": raw}
    return value if isinstance(value, dict) else {"raw_value": value}


def parse_json_array(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return [raw]
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]


def to_float(value: Decimal | int | float) -> float:
    return float(value)


def format_decimal(value: Decimal | int | float, places: int = 2) -> str:
    return f"{to_float(value):,.{places}f}"


def compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True, sort_keys=True)


def build_fact_block(row: ProposalRow) -> dict[str, Any]:
    diagnosis = parse_json_object(row.diagnosis_text)
    evidence = parse_json_array(row.evidence_text)
    return {
        "audience": "Vectron Components demand planner (automotive Tier 1)",
        "trading_unit": "pieces",
        "series_label": row.series_label,
        "product": row.product_name,
        "customer": row.customer_name,
        "channel": row.channel_name,
        "segment_abc": row.segment_abc,
        "segment_xyz": row.segment_xyz,
        "proposal_type": row.proposal_type,
        "week_range": {"from": row.week_from, "to": row.week_to},
        "current_units": to_float(row.current_units),
        "proposed_units": to_float(row.proposed_units),
        "delta_units": to_float(row.delta_units),
        "delta_value_eur": to_float(row.delta_value_eur),
        "confidence": to_float(row.confidence),
        "trigger_summary": row.trigger_summary,
        "diagnosis": diagnosis,
        "evidence": evidence,
    }


def build_prompt(fact_block: dict[str, Any]) -> str:
    return (
        "You are writing for a demand planner at Vectron Components, an automotive Tier 1 supplier. "
        "Write 2-3 sentences in plain professional British English explaining why "
        "this recommendation is being made and the risk of ignoring it. "
        "Use only the supplied figures. Do not invent, alter, convert, restate as a "
        "list, or recompute any number. Do not add percentages that are not given. "
        "If a fact is not supplied, leave it out. Treat pieces as the trading "
        "unit. No bullet points, no headings, no preamble, no markdown.\n\n"
        f"FACT BLOCK\n{compact_json(fact_block)}"
    )


def extract_numerals(text: str) -> list[str]:
    return NUMERAL_RE.findall(text)


def parse_numeral(token: str) -> float:
    return float(token.replace(",", "").replace("%", ""))


def iter_fact_values(value: Any) -> list[Any]:
    if isinstance(value, dict):
        items: list[Any] = []
        for nested in value.values():
            items.extend(iter_fact_values(nested))
        return items
    if isinstance(value, list):
        items = []
        for nested in value:
            items.extend(iter_fact_values(nested))
        return items
    return [value]


def build_allowed_numbers(fact_block: dict[str, Any]) -> list[float]:
    allowed: set[float] = set()
    for value in iter_fact_values(fact_block):
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float, Decimal)):
            add_number_variants(allowed, float(value))
            continue
        if isinstance(value, str):
            for token in extract_numerals(value):
                add_number_variants(allowed, parse_numeral(token))
    return sorted(allowed)


def add_number_variants(bucket: set[float], value: float) -> None:
    if value != value or value in (float("inf"), float("-inf")):
        return
    bucket.add(value)
    for places in (0, 1, 2):
        bucket.add(round(value, places))

    absolute = abs(value)
    # The guard needs to tolerate planner-style abbreviations such as "1.2 million"
    # because that is presentation, not recomputation. We stop at k/m variants so the
    # match space stays tight; broader scaling would start accepting prose the engine
    # never explicitly grounded.
    if absolute >= 1_000:
        scaled_thousands = value / 1_000
        for places in (0, 1, 2):
            bucket.add(round(scaled_thousands, places))
    if absolute >= 1_000_000:
        scaled_millions = value / 1_000_000
        for places in (0, 1, 2):
            bucket.add(round(scaled_millions, places))


def numbers_match(observed: float, allowed: float) -> bool:
    tolerance = max(1e-9, abs(allowed) * RELATIVE_TOLERANCE)
    return abs(observed - allowed) <= tolerance


def validate_rationale(text: str, allowed_numbers: list[float]) -> str | None:
    cleaned = " ".join(text.split())
    if not cleaned:
        return "empty_response"
    if len(cleaned) < MIN_TEXT_LENGTH:
        return "too_short"
    if len(cleaned) > MAX_TEXT_LENGTH:
        return "too_long"
    if MARKDOWN_RE.search(text):
        return "markdown_detected"

    unauthorised: list[str] = []
    for token in extract_numerals(cleaned):
        observed = parse_numeral(token)
        if not any(numbers_match(observed, candidate) for candidate in allowed_numbers):
            unauthorised.append(token)
    if unauthorised:
        return f"unauthorised_numbers:{','.join(unauthorised[:6])}"
    return None


def call_complete(cur: snowflake.connector.cursor.SnowflakeCursor, model: str,
                  prompt: str) -> str:
    cur.execute("SELECT SNOWFLAKE.CORTEX.COMPLETE(%s, %s)", (model, prompt))
    row = cur.fetchone()
    if not row:
        raise RuntimeError("No response row returned from Cortex COMPLETE")
    return str(row[0] or "")


def complete_with_retry(cur: snowflake.connector.cursor.SnowflakeCursor,
                        prompt: str) -> tuple[str | None, str | None, str | None]:
    primary_errors: list[str] = []
    for _ in range(2):
        try:
            return call_complete(cur, PRIMARY_MODEL, prompt), PRIMARY_MODEL, None
        except Exception as exc:  # noqa: BLE001
            primary_errors.append(str(exc))

    try:
        return call_complete(cur, FALLBACK_MODEL, prompt), FALLBACK_MODEL, None
    except Exception as exc:  # noqa: BLE001
        reason = "model_error"
        error_note = f"{reason}: primary={primary_errors[-1]}; fallback={exc}"
        return None, None, error_note


def trim_reason(reason: str | None) -> str | None:
    if reason is None:
        return None
    if reason.startswith("unauthorised_numbers:"):
        return "unauthorised_numbers"
    if reason.startswith("model_error"):
        return "model_error"
    return reason


def template_rationale(row: ProposalRow, fact_block: dict[str, Any]) -> str:
    diagnosis = fact_block["diagnosis"]
    base_context = (
        f"{row.series_label} in {row.customer_name} {row.channel_name} is planned at "
        f"{format_decimal(row.current_units)} pieces across {row.week_from} to "
        f"{row.week_to}, against {format_decimal(row.proposed_units)} proposed and "
        f"EUR {format_decimal(row.delta_value_eur)} of value at stake."
    )

    if row.proposal_type == "event_phasing":
        event_name = diagnosis.get("event", "the event")
        historical_peak = diagnosis.get("historical_peak_week", row.week_to)
        plan_peak = diagnosis.get("plan_peak_week", row.week_from)
        return (
            f"{event_name} sits inside this planning window, and {base_context} "
            f"The recommendation re-phases those pieces towards {historical_peak} "
            f"rather than the current peak in {plan_peak}, because the historical event "
            f"shape in the row shows demand landing in a different week. Ignoring it risks "
            f"holding the right volume in the wrong week, which can leave service exposed "
            f"before the event and stock stranded afterwards."
        )
    if row.proposal_type == "npd_ramp":
        product = diagnosis.get("product", row.product_name)
        tracking = diagnosis.get("tracking_ratio", 1.0)
        weeks_since_launch = diagnosis.get("weeks_since_launch", "")
        analogue = diagnosis.get("analogue", "the analogue")
        return (
            f"{product} is {weeks_since_launch} weeks post-launch and {base_context} "
            f"The proposal resizes the remaining launch ramp because the launch has "
            f"tracked {tracking:.2f} times expectation against the row's {analogue}-based "
            f"benchmark. Ignoring it leaves the forward plan tied to an early-launch curve "
            f"that recent trading has already contradicted."
        )
    if row.proposal_type == "override_decay":
        edge = diagnosis.get("model_edge_pct")
        weeks_overridden = diagnosis.get("weeks_overridden", "several")
        edge_text = f"{edge:.2f}%" if isinstance(edge, (int, float)) else str(edge)
        return (
            f"{base_context} The proposal removes a standing override across {weeks_overridden} "
            f"weeks because the row shows the statistical baseline has been {edge_text} more "
            f"accurate than the adjusted plan on this series. Ignoring it keeps manual volume "
            f"in place where the series' own history says the baseline is the safer call."
        )
    if row.proposal_type == "service_risk":
        lost_sales = diagnosis.get("lost_sales_units", 0)
        weeks_affected = diagnosis.get("weeks_affected", 0)
        return (
            f"Recent stockouts have censored demand on this series, and {base_context} "
            f"The proposal lifts the plan because the row records {lost_sales:,.1f} lost "
            f"pieces across {weeks_affected} recent weeks, so pull is understating "
            f"true demand. Ignoring it risks carrying a stockout-distorted baseline into the "
            f"next horizon and repeating the same service issue."
        )
    if row.proposal_type == "promo_response":
        realisation = diagnosis.get("historical_realisation", 1.0)
        planned_uplift = diagnosis.get("planned_uplift_pct", 0)
        mechanic = diagnosis.get("mechanic", "the promotion")
        return (
            f"{base_context} The proposal adjusts the upcoming {mechanic} because the row shows "
            f"recent promotions realising {realisation:.2f} times plan while the future event still "
            f"assumes a {planned_uplift:.1f}% uplift. Ignoring it risks carrying an uplift assumption "
            f"that this series has not been delivering in customer."
        )
    if row.proposal_type == "distribution":
        shift = diagnosis.get("shift_pct_of_base", 0)
        return (
            f"{base_context} The recommendation moves the forward plan because the row "
            f"shows distribution contribution shifting by {shift:.2f}% of base volume against its "
            f"baseline. Ignoring it leaves the plan anchored to an older level of distribution support "
            f"than recent trading is signalling."
        )
    if row.proposal_type == "bias_correction":
        bias = diagnosis.get("shrunk_bias_pct", 0)
        weeks_measured = diagnosis.get("weeks_measured", 0)
        direction = "light" if bias >= 0 else "heavy"
        return (
            f"{base_context} The proposal corrects a persistent model bias because the row shows the "
            f"one-week-ahead forecast running {abs(bias):.2f}% {direction} across {weeks_measured} "
            f"measured weeks on this series. Ignoring it leaves a repeated forecasting skew in place "
            f"even though the recent evidence has been consistent enough to act on."
        )
    if row.proposal_type == "price_change":
        implied_price = diagnosis.get("implied_price_move_pct", 0)
        elasticity = diagnosis.get("assumed_elasticity", 0)
        return (
            f"{base_context} The recommendation reflects a sustained price signal because the row "
            f"implies a {implied_price:.2f}% realised price move at an assumed elasticity of "
            f"{elasticity:.3f}, while the forward plan still reflects the earlier level. Ignoring it "
            f"risks leaving volume on a price assumption that current trading is no longer supporting."
        )
    return (
        f"{base_context} The trigger summary for this proposal points to a material change in the "
        f"series' outlook, and the forward plan has not yet absorbed it. Ignoring the "
        f"recommendation risks carrying that outdated assumption through the next planning window."
    )


def build_decision(cur: snowflake.connector.cursor.SnowflakeCursor,
                   row: ProposalRow) -> NarrativeDecision:
    fact_block = build_fact_block(row)
    allowed_numbers = build_allowed_numbers(fact_block)
    prompt = build_prompt(fact_block)
    response, model_name, model_error = complete_with_retry(cur, prompt)

    if response is None:
        return NarrativeDecision(
            rationale=template_rationale(row, fact_block),
            source="template",
            model_name=None,
            fallback_reason=model_error,
        )

    failure_reason = validate_rationale(response, allowed_numbers)
    if failure_reason is None:
        return NarrativeDecision(
            rationale=" ".join(response.split()),
            source="cortex",
            model_name=model_name,
            fallback_reason=None,
        )

    return NarrativeDecision(
        rationale=template_rationale(row, fact_block),
        source="template",
        model_name=model_name,
        fallback_reason=failure_reason,
    )


def load_proposals(cur: snowflake.connector.cursor.SnowflakeCursor,
                   all_runs: bool, max_proposals: int) -> list[ProposalRow]:
    run_filter = "1=1" if all_runs else "r.RUN_TYPE = 'live'"
    sql = f"""
        SELECT p.PROPOSAL_ID,
               p.RUN_ID,
               r.RUN_TYPE,
               s.SERIES_LABEL,
               s.PRODUCT_NAME,
               s.CUSTOMER_NAME,
               s.CHANNEL_NAME,
               s.SEGMENT_ABC,
               s.SEGMENT_XYZ,
               p.PROPOSAL_TYPE,
               p.WEEK_FROM,
               p.WEEK_TO,
               p.CURRENT_UNITS,
               p.PROPOSED_UNITS,
               p.DELTA_UNITS,
               p.DELTA_VALUE_EUR,
               p.CONFIDENCE,
               p.TRIGGER_SUMMARY,
               p.DIAGNOSIS,
               p.EVIDENCE
        FROM CORE.FACT_AGENT_PROPOSAL p
        JOIN CORE.FACT_AGENT_RUN r
          ON r.RUN_ID = p.RUN_ID
        JOIN APP.V_SERIES s
          ON s.SERIES_ID = p.SERIES_ID
        WHERE COALESCE(p.RATIONALE, '') = ''
          AND {run_filter}
        ORDER BY CASE WHEN r.RUN_TYPE = 'live' THEN 0 ELSE 1 END,
                 r.STARTED_AT DESC,
                 p.DELTA_VALUE_EUR DESC,
                 p.PROPOSAL_ID
        LIMIT %s
    """
    rows = fetch_all(cur, sql, (max_proposals,))
    return [
        ProposalRow(
            proposal_id=str(row["PROPOSAL_ID"]),
            run_id=str(row["RUN_ID"]),
            run_type=str(row["RUN_TYPE"]),
            series_label=str(row["SERIES_LABEL"]),
            product_name=str(row["PRODUCT_NAME"]),
            customer_name=str(row["CUSTOMER_NAME"]),
            channel_name=str(row["CHANNEL_NAME"]),
            segment_abc=row["SEGMENT_ABC"],
            segment_xyz=row["SEGMENT_XYZ"],
            proposal_type=str(row["PROPOSAL_TYPE"]),
            week_from=str(row["WEEK_FROM"]),
            week_to=str(row["WEEK_TO"]),
            current_units=row["CURRENT_UNITS"],
            proposed_units=row["PROPOSED_UNITS"],
            delta_units=row["DELTA_UNITS"],
            delta_value_eur=row["DELTA_VALUE_EUR"],
            confidence=row["CONFIDENCE"],
            trigger_summary=str(row["TRIGGER_SUMMARY"]),
            diagnosis_text=row["DIAGNOSIS"],
            evidence_text=row["EVIDENCE"],
        )
        for row in rows
    ]


def summarise_mode(cortex_accepted: int, template_fallbacks: int) -> str:
    if cortex_accepted and template_fallbacks:
        return "mixed"
    if cortex_accepted:
        return "cortex"
    return "template"


def update_run_metrics(cur: snowflake.connector.cursor.SnowflakeCursor,
                       run_stats: dict[str, dict[str, Any]]) -> None:
    updates: list[tuple[Any, ...]] = []
    for run_id, stats in run_stats.items():
        model_names = ",".join(sorted(stats["models"])) or None
        updates.append((
            stats["calls"],
            stats["fallbacks"],
            summarise_mode(stats["accepted"], stats["fallbacks"]),
            model_names,
            run_id,
        ))
    if updates:
        cur.executemany(
            "UPDATE CORE.FACT_AGENT_RUN "
            "SET CORTEX_CALLS = %s, CORTEX_FALLBACKS = %s, NARRATIVE_MODE = %s, MODEL_NAME = %s "
            "WHERE RUN_ID = %s",
            updates,
        )


def ensure_session_context(cur: snowflake.connector.cursor.SnowflakeCursor) -> None:
    # The employee profile asks for this role, but some demo connections are already
    # bound to an authorised role without the profile role being provisioned. Failing
    # hard there would block narration for an environment difference unrelated to the
    # proposals themselves, so we warn and keep the existing session role.
    try:
        cur.execute("USE ROLE SNOW_CERTIFIED_EMPLOYEE_RO_RL")
    except snowflake.connector.errors.ProgrammingError as exc:
        message = str(exc)
        if "Object does not exist" not in message:
            raise
        print("Role SNOW_CERTIFIED_EMPLOYEE_RO_RL is not available; using the connection role.")
    cur.execute("USE DATABASE VECTRON_DEMAND")


def main() -> int:
    all_runs = os.environ.get("ALL_RUNS") == "1"
    max_proposals = parse_env_int("MAX_PROPOSALS", MAX_PROPOSALS_DEFAULT)

    conn = snowflake.connector.connect(**load_connection())
    cur = conn.cursor()
    try:
        ensure_session_context(cur)

        proposals = load_proposals(cur, all_runs=all_runs, max_proposals=max_proposals)
        if not proposals:
            print("No proposals need a rationale.")
            return 0

        updates: list[tuple[str, str, str]] = []
        run_stats: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"calls": 0, "accepted": 0, "fallbacks": 0, "models": set()}
        )
        fallback_reasons: Counter[str] = Counter()
        calls = 0
        cortex_accepted = 0
        template_fallbacks = 0

        for row in proposals:
            calls += 1
            decision = build_decision(cur, row)
            updates.append((decision.rationale, decision.source, row.proposal_id))

            stats = run_stats[row.run_id]
            stats["calls"] += 1
            if decision.model_name:
                stats["models"].add(decision.model_name)

            if decision.source == "cortex":
                cortex_accepted += 1
                stats["accepted"] += 1
                status_text = f"cortex {decision.model_name}"
            else:
                template_fallbacks += 1
                stats["fallbacks"] += 1
                reason = trim_reason(decision.fallback_reason) or "unknown"
                fallback_reasons[reason] += 1
                status_text = f"template {reason}"

            print(f"{row.proposal_id} {row.proposal_type:16s} {status_text}")

        cur.executemany(
            "UPDATE CORE.FACT_AGENT_PROPOSAL SET RATIONALE = %s, RATIONALE_SOURCE = %s "
            "WHERE PROPOSAL_ID = %s",
            updates,
        )
        update_run_metrics(cur, run_stats)
        conn.commit()

        print("\nSummary")
        print(f"calls: {calls}")
        print(f"cortex-accepted: {cortex_accepted}")
        print(f"template-fallbacks: {template_fallbacks}")
        if fallback_reasons:
            for reason, count in sorted(fallback_reasons.items()):
                print(f"fallback-reason {reason}: {count}")
        else:
            print("fallback-reason none: 0")
        return 0
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    sys.exit(main())