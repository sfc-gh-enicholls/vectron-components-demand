#!/usr/bin/env python3
"""
Generate the consensus inputs: what sales, marketing and finance submitted, and
the derived event and promotion components of the forward plan.

TWO JOBS, ONE SCRIPT
--------------------
1. CORE.FACT_PLAN_EFFECT — splits the statistical baseline into an event
   component, a promotion component and the rest. The chart needs event effects
   as columns, but the statistical model has already absorbed them, so they are
   not additive on top of it: they have to be carved OUT of the baseline.

2. CORE.FACT_PLAN_INPUT — the submissions themselves, for the live cycle and a
   run of closed historical cycles.

THESE NUMBERS ARE SYNTHETIC, AND THEIR BIASES ARE INVENTED
----------------------------------------------------------
The dataset had no sales, marketing or finance input at all, so there is nothing
here to measure. The behaviours in STREAM_BIAS below are chosen to be realistic
and instructive for a beverage-alcohol audience, not fitted to anything. They are
kept in one place precisely so a reviewer can argue with them.

WHY HISTORICAL CYCLES ARE GENERATED TOO
---------------------------------------
Two reasons, and the second is the important one:
  - Contributor columns would otherwise exist only to the right of "today",
    leaving half the chart bare and the legend meaning different things on each
    side.
  - Submissions against weeks that now have outturn are the only way to ask
    "whose input was actually any good". That turns the streams from decoration
    into evidence, which is the whole point of showing them.

SUBMISSION GRAIN
----------------
Each stream submits at the hierarchy level it genuinely thinks at — sales by
product and customer, marketing by product and customer where it has activation, finance
by category — and the submission is disaggregated to series-week here using the
same largest-remainder apportionment as src/lib/disaggregate.ts. NODE_LEVEL and
NODE_KEY preserve the level the human worked at, so a -6% on Brake systems x
Stellantis is still traceable after it has been spread over 18 series.

Usage:
  SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/consensus.py
  EFFECTS_ONLY=1 ... python3 scripts/consensus.py    # skip submissions
"""
from __future__ import annotations

import math
import os
import sys
import uuid
from collections import defaultdict
from datetime import datetime

import snowflake.connector  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _conn import load_connection  # noqa: E402

# --- Tunables ---------------------------------------------------------------

# Closed cycles to generate. Each submits against the 8 weeks after itself, all
# of which now have outturn, so V_CONSENSUS_ACCURACY has something to score.
# Lower bound is set by forecast vintages, which start at 2026-W05.
HISTORICAL_CYCLES = ["2026-W12", "2026-W16", "2026-W20", "2026-W24",
                     "2026-W28", "2026-W32"]
CYCLE_HORIZON = 8

# How many nodes each stream submits against. Real teams do not touch every
# cell; they argue about the ones that matter to their targets.
SALES_NODES = 45
MARKETING_NODES = 28

SUBMITTED_BY = {
    "sales": "k.brandt@vectron-components.example",
    "marketing": "j.moreau@vectron-components.example",
    "finance": "t.lindqvist@vectron-components.example",
}

# ---------------------------------------------------------------------------
# THE INVENTED BEHAVIOURS. Everything judgemental about this script is here.
#
# The factors are ADDITIVE, not alternative: `base` applies to every week, and
# the bonuses stack on top where the condition holds. That distinction matters
# and getting it wrong was a real defect. Treating them as mutually exclusive
# modelled a rep who STOPS sandbagging the moment a promotion appears, so the
# promo optimism cancelled the sandbag and the live cycle came out at +0.15% —
# a sales team with no bias at all, which is the one thing they never are.
# ---------------------------------------------------------------------------
STREAM_BIAS = {
    # Field sales carry a quota, so their incentive is to be beatable. They
    # sandbag the whole base, then claim upside on the activity they have
    # personally argued for and on launches they want investment behind. Net of
    # both, they stay light — which is the recognisable pattern.
    "sales": {
        "base": -0.06,           # sandbag everything, against quota
        "promo_bonus": +0.09,    # but talk up weeks they have promotions in
        "event_bonus": +0.04,    # mild optimism into big calendar events
        "launch_bonus": +0.20,   # real optimism on new products
        "reason": "CUST_INTEL",
        "note": "Key account submission: base held light against target, upside claimed on new nominations and SOP ramps.",
    },
    # Marketing are judged on whether their activation delivered, so they claim
    # uplift where they are spending and stay close to baseline elsewhere.
    "marketing": {
        "base": +0.01,
        "promo_bonus": +0.10,
        "event_bonus": +0.08,
        "launch_bonus": +0.11,
        "reason": "PROMO_PLAN",
        "note": "Aftermarket and service view: uplift claimed behind distributor campaigns and winter wear.",
    },
    # Finance submit the budget. It is a TARGET, so it sits above the plan and is
    # deliberately FLAT — every bonus is zero, because a budget has no weekly
    # shape. That flatness is the tell, and the view surfaces it.
    "finance": {
        "base": +0.045,
        "promo_bonus": 0.0,
        "event_bonus": 0.0,
        "launch_bonus": 0.0,
        "reason": "ONE_OFF",
        "note": "Budget commitment. A target rather than a forecast; carried flat across the horizon.",
    },
}

RUN_TS = datetime.utcnow().replace(microsecond=0)


def fetch(cur, sql, binds=None):
    cur.execute(sql, binds or [])
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def apportion(total: float, weights: list[float]) -> list[float]:
    """
    Largest-remainder apportionment at 2dp, matching src/lib/disaggregate.ts.

    Deliberately duplicated logic rather than shared, because this runs in the
    build pipeline and that runs in the request path. The invariant both must
    hold is the same and is asserted by the plan_input_delta integrity check:
    the parts sum to the total EXACTLY, so a node submission can never disagree
    with the leaf rows it was spread across.
    """
    n = len(weights)
    if n == 0:
        return []
    wsum = sum(weights)
    eff = weights if wsum > 0 else [1.0] * n
    esum = wsum if wsum > 0 else float(n)

    target_units = round(total * 100)
    raw = [(target_units * w) / esum for w in eff]
    floored = [math.floor(u) for u in raw]
    remaining = target_units - sum(floored)

    order = sorted(range(n), key=lambda i: (-(raw[i] - math.floor(raw[i])), i))
    out = floored[:]
    k = 0
    while remaining > 0:
        out[order[k % n]] += 1
        remaining -= 1
        k += 1
    return [u / 100 for u in out]


class Ctx:
    def __init__(self, cur):
        self.weeks = [r["WEEK_ID"] for r in fetch(
            cur, "SELECT WEEK_ID FROM CORE.DIM_WEEK ORDER BY WEEK_START_DATE")]
        self.widx = {w: i for i, w in enumerate(self.weeks)}

        self.series = {r["SERIES_ID"]: r for r in fetch(cur, """
            SELECT s.SERIES_ID, s.PRODUCT_ID, s.PRODUCT_NAME, s.CUSTOMER_ID, s.CUSTOMER_NAME,
                   s.CHANNEL_NAME, s.CATEGORY_NAME, s.UNIT_PRICE_EUR,
                   b.LIFECYCLE_STATUS, b.LAUNCH_WEEK_ID
            FROM APP.V_SERIES s
            JOIN CORE.DIM_PRODUCT b ON b.PRODUCT_ID = s.PRODUCT_ID""")}

        # The live cycle's baseline is the committed plan's statistical column.
        self.plan_stat = {}
        for r in fetch(cur, "SELECT SERIES_ID, WEEK_ID, STAT_UNITS FROM CORE.FACT_DEMAND_PLAN"):
            self.plan_stat[(r["SERIES_ID"], r["WEEK_ID"])] = float(r["STAT_UNITS"])
        self.plan_weeks = sorted({w for (_, w) in self.plan_stat})

        # Historical cycles use the vintage that was live at that origin.
        self.vintage = defaultdict(dict)
        for r in fetch(cur, """
            SELECT SERIES_ID, MADE_WEEK_ID, TARGET_WEEK_ID, FORECAST_UNITS
            FROM ML.FACT_FORECAST
            WHERE MODEL_NAME = 'VECTRON_STAT' AND LAG_WEEKS BETWEEN 1 AND %s""",
            [CYCLE_HORIZON]):
            self.vintage[r["MADE_WEEK_ID"]][(r["SERIES_ID"], r["TARGET_WEEK_ID"])] = \
                float(r["FORECAST_UNITS"])

        # Promotion weeks per series, for the "own activity" bias.
        self.promo_weeks = defaultdict(set)
        self.promo_detail = {}
        for p in fetch(cur, """SELECT SERIES_ID, START_WEEK_ID, END_WEEK_ID, MECHANIC,
                                      DEPTH_PCT, PLANNED_UPLIFT_PCT
                               FROM CORE.FACT_PROMOTION"""):
            i0, i1 = self.widx.get(p["START_WEEK_ID"]), self.widx.get(p["END_WEEK_ID"])
            if i0 is None or i1 is None:
                continue
            for w in self.weeks[i0:i1 + 1]:
                self.promo_weeks[p["SERIES_ID"]].add(w)
                self.promo_detail[(p["SERIES_ID"], w)] = p

        # Event build windows per customer, from the calendar. Lead time is a
        # published property of the event, so this is knowable forward.
        self.event_weeks = defaultdict(dict)
        for e in fetch(cur, """SELECT EVENT_ID, EVENT_NAME, WEEK_ID, CUSTOMER_SCOPE, LEAD_WEEKS
                               FROM CORE.DIM_EVENT WHERE WEEK_ID IS NOT NULL"""):
            ei = self.widx.get(e["WEEK_ID"])
            if ei is None:
                continue
            lead = int(e["LEAD_WEEKS"] or 4)
            for mid in [m.strip() for m in (e["CUSTOMER_SCOPE"] or "").split(",") if m.strip()]:
                for off in range(-lead, 2):
                    j = ei + off
                    if 0 <= j < len(self.weeks):
                        self.event_weeks[mid][self.weeks[j]] = e["EVENT_NAME"]

    def baseline(self, cycle: str, sid: str, week: str, live_cycle: str) -> float | None:
        if cycle == live_cycle:
            return self.plan_stat.get((sid, week))
        return self.vintage.get(cycle, {}).get((sid, week))


# ===========================================================================
# Job 1: carve the event and promotion components out of the baseline
# ===========================================================================
def build_effects(cur, ctx: Ctx) -> int:
    """
    Estimate what part of each forward week's statistical baseline is event or
    promotion driven.

    Method, and its limits. The EVENT share is estimated from the series' own
    realised lift in the equivalent weeks of prior occurrences of the same event
    — that is measured behaviour, from history the model also had. The PROMO
    share comes from the committed promotion's planned uplift. Both are then
    capped so the residual baseline cannot go negative, because a baseline that
    goes negative would make the stacked columns nonsense.

    Anything the estimate does not explain stays in the baseline term rather than
    being forced into a component. IS_DERIVED is set TRUE on every row: this is a
    reconstruction, and the UI says so rather than implying it was measured.
    """
    print("Deriving event and promotion effects...")

    # The realised event share per series, computed from the driver table.
    #
    # An earlier attempt did this in SQL with a correlated window join onto
    # DIM_EVENT's lead time; it does not express cleanly in Snowflake and was
    # much harder to read than it was worth. Reading FACT_DRIVER_CONTRIB and
    # aggregating in Python gets the same numbers from the same rows.
    realised = defaultdict(list)
    for r in fetch(cur, """
        SELECT d.SERIES_ID, d.WEEK_ID,
               SUM(CASE WHEN d.DRIVER = 'EVENT' THEN d.CONTRIB_UNITS ELSE 0 END) AS EVENT_UNITS,
               SUM(d.CONTRIB_UNITS) AS TOTAL_UNITS
        FROM CORE.FACT_DRIVER_CONTRIB d GROUP BY 1, 2
        HAVING SUM(CASE WHEN d.DRIVER = 'EVENT' THEN d.CONTRIB_UNITS ELSE 0 END) <> 0"""):
        total = float(r["TOTAL_UNITS"])
        if total <= 0:
            continue
        realised[r["SERIES_ID"]].append(float(r["EVENT_UNITS"]) / total)

    # A single realised event share per series: the mean share of volume that
    # event weeks historically carried. Blunt, but it is measured, and it keeps
    # the estimate proportional to how event-sensitive the series actually is.
    event_share = {sid: (sum(v) / len(v)) for sid, v in realised.items() if v}

    rows = []
    for (sid, week), stat in ctx.plan_stat.items():
        s = ctx.series.get(sid)
        if not s or stat <= 0:
            continue

        ev_name = ctx.event_weeks.get(s["CUSTOMER_ID"], {}).get(week)
        ev_units = 0.0
        if ev_name:
            share = event_share.get(sid, 0.0)
            ev_units = max(0.0, min(0.45, share)) * stat

        promo = ctx.promo_detail.get((sid, week))
        pr_units = 0.0
        if promo:
            uplift = float(promo["PLANNED_UPLIFT_PCT"] or 0)
            # The uplift is expressed on the un-promoted base, so the promoted
            # portion of the total is uplift / (1 + uplift).
            pr_units = stat * (uplift / (1.0 + uplift)) if uplift > 0 else 0.0

        # Never let the components exceed the baseline they are carved from.
        if ev_units + pr_units > stat * 0.85:
            scale = (stat * 0.85) / (ev_units + pr_units)
            ev_units *= scale
            pr_units *= scale

        if ev_units > 0.005:
            rows.append((sid, week, "EVENT", round(ev_units, 2), ev_name, True))
        if pr_units > 0.005:
            label = f"{promo['MECHANIC']} at {float(promo['DEPTH_PCT'] or 0):.0%}"
            rows.append((sid, week, "PROMO", round(pr_units, 2), label, True))

    cur.execute("DELETE FROM CORE.FACT_PLAN_EFFECT")
    for i in range(0, len(rows), 5000):
        cur.executemany(
            "INSERT INTO CORE.FACT_PLAN_EFFECT "
            "(SERIES_ID, WEEK_ID, EFFECT_TYPE, EFFECT_UNITS, EFFECT_LABEL, IS_DERIVED) "
            "VALUES (%s, %s, %s, %s, %s, %s)", rows[i:i + 5000])
    print(f"  {len(rows)} effect rows "
          f"({sum(1 for r in rows if r[2] == 'EVENT')} event, "
          f"{sum(1 for r in rows if r[2] == 'PROMO')} promo)")
    return len(rows)


# ===========================================================================
# Job 2: the submissions
# ===========================================================================
def node_factor(stream: str, ctx: Ctx, sid: str, week: str) -> float:
    """
    The bias this stream applies to this series-week. See STREAM_BIAS.

    Bonuses STACK on the base rather than replacing it, so a sandbagged series
    with a promotion in the week comes out less light but still light.
    """
    b = STREAM_BIAS[stream]
    s = ctx.series[sid]
    f = b["base"]
    launch = s.get("LAUNCH_WEEK_ID")
    # Judge "new" by how recently it launched, not by the lifecycle LABEL: a
    # product can sit in 'Growth' for years, and treating that as launch optimism
    # would apply a 20% uplift across a third of the portfolio.
    if launch and s.get("LIFECYCLE_STATUS") in ("Launch", "Growth"):
        li, wi = ctx.widx.get(launch), ctx.widx.get(week)
        if li is not None and wi is not None and wi - li <= 104:
            f += b["launch_bonus"]
    if week in ctx.promo_weeks.get(sid, set()):
        f += b["promo_bonus"]
    if ctx.event_weeks.get(s["CUSTOMER_ID"], {}).get(week):
        f += b["event_bonus"]
    return f


def submit_stream(ctx: Ctx, stream: str, cycle: str, live_cycle: str,
                  weeks: list[str], nodes: list[tuple[str, dict]]) -> list[tuple]:
    """
    Build one stream's submission for one cycle, node by node.

    Each node's target is its own baseline scaled by the stream's bias, then
    apportioned back down to leaves in proportion to each leaf's baseline. That
    keeps the leaf rows summing to the node total exactly.
    """
    out = []
    bias = STREAM_BIAS[stream]

    for node_level, node in nodes:
        node_key = node["key"]
        leaves = [(sid, w) for sid in node["series"] for w in weeks]
        bases, factors = [], []
        keep = []
        for sid, w in leaves:
            base = ctx.baseline(cycle, sid, w, live_cycle)
            if base is None or base <= 0:
                continue
            keep.append((sid, w))
            bases.append(base)
            factors.append(node_factor(stream, ctx, sid, w))
        if not keep:
            continue

        node_base = sum(bases)
        # The node's own target: a volume-weighted application of the bias, so a
        # node containing promoted weeks moves differently from one that does not.
        weighted = sum(b * f for b, f in zip(bases, factors)) / node_base
        target_delta = node_base * weighted
        deltas = apportion(target_delta, bases)

        group = f"SUB-{uuid.uuid4().hex[:16]}"
        for (sid, w), base, delta in zip(keep, bases, deltas):
            out.append((
                cycle, stream, sid, w,
                round(base, 2), round(base + delta, 2), round(delta, 2),
                node_level, node_key, "statistical", group,
                bias["reason"], bias["note"], SUBMITTED_BY[stream], RUN_TS,
            ))
    return out


def build_nodes(ctx: Ctx) -> dict[str, list[tuple[str, dict]]]:
    """Pick the nodes each stream argues about, and which series sit under them."""
    by_product_customer = defaultdict(list)
    by_category = defaultdict(list)
    value = defaultdict(float)

    for sid, s in ctx.series.items():
        bm = (s["PRODUCT_NAME"], s["CUSTOMER_NAME"])
        by_product_customer[bm].append(sid)
        by_category[s["CATEGORY_NAME"]].append(sid)
        for w in ctx.plan_weeks:
            value[bm] += ctx.plan_stat.get((sid, w), 0.0) * float(s["UNIT_PRICE_EUR"])

    ranked = sorted(by_product_customer, key=lambda k: -value[k])

    def bm_node(bm):
        return ("PRODUCT_CUSTOMER", {"key": f"{bm[0]} · {bm[1]}", "series": by_product_customer[bm]})

    # Marketing argue where there is actually activation to argue about.
    promoted = [bm for bm in ranked
                if any(ctx.promo_weeks.get(sid) for sid in by_product_customer[bm])]

    return {
        "sales": [bm_node(bm) for bm in ranked[:SALES_NODES]],
        "marketing": [bm_node(bm) for bm in promoted[:MARKETING_NODES]],
        "finance": [("CATEGORY_NAME", {"key": c, "series": by_category[c]})
                    for c in sorted(by_category)],
    }


def main() -> int:
    conn = snowflake.connector.connect(**load_connection())
    cur = conn.cursor()
    try:
        cur.execute("USE DATABASE VECTRON_DEMAND")
        print("Loading...")
        ctx = Ctx(cur)
        live_cycle = min(ctx.plan_weeks)
        live_cycle = ctx.weeks[ctx.widx[live_cycle] - 1]   # the week before the plan starts
        print(f"  {len(ctx.series)} series, live cycle {live_cycle}, "
              f"{len(ctx.plan_weeks)} plan weeks")

        build_effects(cur, ctx)

        if os.environ.get("EFFECTS_ONLY"):
            conn.commit()
            return 0

        nodes = build_nodes(ctx)
        print(f"Nodes: sales {len(nodes['sales'])}, marketing {len(nodes['marketing'])}, "
              f"finance {len(nodes['finance'])}")

        print("Clearing previous submissions...")
        cur.execute("DELETE FROM CORE.FACT_PLAN_INPUT")

        total = 0
        cycles = [(live_cycle, ctx.plan_weeks)]
        for c in HISTORICAL_CYCLES:
            i = ctx.widx.get(c)
            if i is None:
                continue
            cycles.append((c, ctx.weeks[i + 1:i + 1 + CYCLE_HORIZON]))

        for cycle, weeks in cycles:
            rows = []
            for stream in ("sales", "marketing", "finance"):
                rows += submit_stream(ctx, stream, cycle, live_cycle, weeks,
                                      nodes[stream])
            for i in range(0, len(rows), 5000):
                cur.executemany(
                    "INSERT INTO CORE.FACT_PLAN_INPUT (CYCLE_WEEK, STREAM_ID,"
                    " SERIES_ID, WEEK_ID, BASE_UNITS, INPUT_UNITS, DELTA_UNITS,"
                    " NODE_LEVEL, NODE_KEY, DISAGG_METHOD, EDIT_GROUP_ID,"
                    " REASON_CODE, NOTE, SUBMITTED_BY, SUBMITTED_AT)"
                    " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    rows[i:i + 5000])
            total += len(rows)
            tag = "live" if cycle == live_cycle else "closed"
            print(f"  {cycle} ({tag}): {len(rows)} rows over {len(weeks)} weeks")

        conn.commit()
        print(f"\n{total} submission rows written.")
        return 0
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
