#!/usr/bin/env python3
"""
The demand-planning agent: a deterministic proposal engine.

WHAT THIS IS, AND WHAT IT IS NOT
--------------------------------
Every number this produces comes from arithmetic in this file. The language
model is never asked to compute, choose, or size anything — scripts/narrate.py
adds prose on top of proposals that already exist, and if it disagrees with the
figures its output is discarded. Confidence in particular is computed from the
documented formula in `confidence()` and is never model-generated.

The agent PROPOSES. It never writes to FACT_DEMAND_PLAN. Accepting a proposal is
a separate human act, recorded in FACT_AGENT_DECISION, and it lands in a
scenario rather than the committed plan.

WHY IT RUNS AS A BATCH
----------------------
Like a real planning agent, this runs before the planner logs in rather than
on demand. That also makes the back-run possible, which matters more than
convenience:

  Actuals end at HISTORY_END and every live proposal targets weeks after it, so
  a scorecard built only from live proposals would be permanently empty — the
  headline "did the agent actually help" table would be a blank screen. So the
  engine also runs at four historical origins whose target weeks now have
  outturn, with seeded accept/reject decisions. Those runs are marked
  RUN_TYPE='backrun' and the UI labels them as seeded.

NO LEAKAGE
----------
At origin W, every rule may read only weeks <= W. Forecast vintages come from
ML.FACT_FORECAST filtered on MADE_WEEK_ID = W, which is what the plan actually
said at that time. Nothing reads DIM_EVENT.UPLIFT_FACTOR — event shapes are
estimated from prior occurrences in the history available at the origin.

Usage:
  SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/agent.py
  ONLY_LIVE=1 ... python3 scripts/agent.py     # skip the back-run
"""
from __future__ import annotations

import json
import math
import os
import random
import re
import sys
import uuid
from collections import defaultdict
from datetime import datetime

import snowflake.connector  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _conn import load_connection  # noqa: E402

# --- Tunables, all in one place so the engine's behaviour is inspectable -----

# The historical origins for the back-run.
#
# W20/W24/W28/W32 are four weeks apart so their 8-week horizons overlap and the
# scorecard sees repeated attempts at the same series.
#
# W24 and W28 put the 2026 summer plant shutdowns inside a forward window whose
# weeks now have outturn, so event_phasing (the shutdown and changeover rule)
# can be judged. W08 and W12 cover the spring changeovers.
#
# The lower bound is not free: ML.FACT_FORECAST only has vintages from 2026-W05,
# so an earlier origin would have no leakage-free view of what the plan said.
# That is also why the 2025 Christmas shutdown cannot be back-run: an origin
# far enough ahead of it falls before the first vintage.
BACKRUN_ORIGINS = ["2026-W08", "2026-W12", "2026-W20", "2026-W24",
                   "2026-W28", "2026-W32"]

HORIZON = 8            # proposals never reach past 8 weeks
LOOKBACK = 4           # weeks of recent signal used by the driver-trend rules
TRAILING = 13          # weeks of baseline used for trend comparisons

# A proposal must clear BOTH a relative and an absolute bar. The absolute bar is
# the meaningful one: it stops a large percentage move on a tail series from
# consuming a planner's attention. The relative bar is only a noise floor —
# each rule's own trigger threshold is what actually governs whether it fires.
#
# These two were originally 0.05 and 25k, and the pair silently cancelled the
# rules out: a rule documented as triggering on a 6% deviation would damp that
# to 3.6%, fall under a 5% floor, and emit nothing. If you raise this, check the
# per-rule thresholds against DAMP or you will mute rules without meaning to.
MIN_REL_CHANGE = 0.02
MIN_VALUE_EUR = 25_000.0

# Deviations are only ever partly signal, and the right damping is a MEASURED
# quantity, not an intuition. The first version of this engine asserted these
# numbers and destroyed accuracy: the back-run scored a 31% win rate and pushed
# WAPE from 16.9% to 19.8%.
#
# The cause was velocity. A series' deviation over the prior four weeks predicts
# its next deviation with a correlation of only rho = 0.148 (measured over 22,027
# series-weeks), so it carries about 2% of the variance — and 0.60 of it was
# being applied. The forecast made AT the origin has already absorbed the recent
# level, so re-applying a deviation measured against an older vintage is
# double-counting stale information.
#
# Anything here that chases a recent deviation is therefore damped hard. Rules
# correcting a PERSISTENT, significance-tested effect are not damped, because a
# bias that has survived a significance test is not noise.
DAMP = {
    "bias_correction": 1.00,  # shrinkage is applied per series instead; see BIAS_TAU
    "distribution": 0.30,     # a deviation read, so damped near its predictive weight
    "service_risk": 0.50,
    "npd_ramp": 0.75,         # earns it: 63% win rate, WAPE 26.7 -> 20.4 on back-run
    "price_change": 0.30,
    "override_decay": 1.00,   # reverting to the model is not a partial move
    "promo_response": 0.60,
    "event_phasing": 1.00,    # a shape correction is applied in full
}

# Rules the back-run proved do not work on this data, and why.
#
# This is the point of back-running the engine: a rule ships only if it beats the
# plan on held-out history. Keeping a rule that loses accuracy because it sounded
# plausible is the exact failure mode this design exists to prevent.
DISABLED = {
    "promo_response":
        "Promo uplift realisation is not a per-series property in this data. "
        "Splitting each series' promotions in half, the two halves' mean "
        "realisation correlate at 0.038 - indistinguishable from zero across 718 "
        "series. There was nothing to learn, so the rule was reading noise: it "
        "scored a 0% win rate on the back-run and pushed WAPE from 20.7% to "
        "29.9%. The logic is retained because it is correct, and would work on a "
        "portfolio where execution quality genuinely varies by series.",

    "bias_correction":
        "Trailing forecast bias does not predict forward forecast bias here, so "
        "there is nothing for this rule to correct. Measured over 9,186 "
        "series-weeks, the correlation between a series' bias over the trailing "
        "12 weeks and its bias over the next 8 is -0.016. Worse, among exactly "
        "the series this rule selects (trailing bias >= 6%), the forward bias has "
        "the OPPOSITE sign 72% of the time - the series mean-revert. That is why "
        "the rule scored a 21% win rate, far BELOW chance: it was reliably "
        "adjusting in the wrong direction. "
        "\n\n"
        "Worth recording how this was nearly missed. A split-half test on the "
        "same series showed bias correlating at 0.508, which looks like strong "
        "evidence of a stable per-series bias, and shrinking the estimate "
        "empirical-Bayes style did improve the rule (WAPE 19.8% -> 17.7%). But "
        "both halves of that test share one period's level, so it answers 'does "
        "this series have a stable average' and not 'does its past predict its "
        "future'. Only the trailing-versus-forward test asks the question the "
        "rule actually depends on. A plausible mechanism, a significance test and "
        "a principled shrinkage estimator were all in place around a signal that "
        "did not exist.",

    "distribution":
        "Effectively no signal at the damping its predictive weight supports. "
        "Only one proposal survived to be scored on the back-run and it did not "
        "improve the plan. Kept for a portfolio with real listings churn.",
}

# Ceiling on any single proposal, so an outlier cannot propose a 5x plan.
MAX_FACTOR = 1.60
MIN_FACTOR = 0.40

# Empirical-Bayes shrinkage for the bias rule.
#
# Per-series bias IS real here: splitting each series' residual history in half,
# the two halves correlate at 0.508. But the OBSERVED bias overstates the true
# one, because part of it is sampling noise. Decomposing across 714 series:
#
#   SD(observed bias, half sample) = 9.19%
#   mean sampling SE (half sample) = 4.99%
#   => SD(true bias) = sqrt(9.19^2 - 4.99^2) = 7.72%
#
# So only about 70% of a measured bias is signal. The first version corrected
# 100% of it AND selected only series with extreme residuals, so regression to
# the mean guaranteed an overshoot: the rule scored a 16% win rate and pushed
# WAPE from 15.4% to 19.8%.
#
# Shrinking each series' estimate by tau^2/(tau^2 + se_i^2) fixes both problems
# at once, and self-corrects: a series measured noisily is shrunk harder.
BIAS_TAU = 0.0772

# The bias rule needs enough residuals for its standard error to mean anything.
BIAS_WINDOW = 12
MIN_BIAS = 0.04           # applied AFTER shrinkage, as a materiality bar
SIGNIFICANCE = 1.0        # light gate only; shrinkage does the statistical work

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "src", "lib", "elasticity.json")) as fh:
    ASSUMPTIONS = json.load(fh)

TIER_ELASTICITY = ASSUMPTIONS["tierElasticity"]
CHANNEL_PRICE_MULTIPLIER = ASSUMPTIONS["channelPriceMultiplier"]

RUN_TS = datetime.utcnow().replace(microsecond=0)


# =====================================================================
# Confidence
# =====================================================================
BASE_CONFIDENCE = {
    "event_phasing":   0.80,   # a repeated calendar pattern is the strongest signal
    "service_risk":    0.78,   # censored demand is a known, mechanical bias
    "override_decay":  0.72,   # backed by that series' own override track record
    "bias_correction": 0.70,   # significance-tested against the series' own residuals
    "promo_response":  0.62,
    "npd_ramp":        0.62,
    "distribution":    0.55,
    "price_change":    0.50,   # rests on assumed elasticities
}

XYZ_FACTOR = {"X": 1.00, "Y": 0.88, "Z": 0.74}
ABC_FACTOR = {"A": 1.00, "B": 0.94, "C": 0.86}


def confidence(rule: str, consistency: float, xyz: str, abc: str,
               evidence_count: int) -> float:
    """
    Deterministic confidence. Four independent discounts on a per-rule base:

      consistency   how far the signal agreed with itself across the weeks it
                    was measured over: 1.0 = every week moved the same way,
                    0.5 = an even split, which is noise. Mapped onto 0.55..1.0.
      volatility    a Z-classified series is erratic, so the same deviation
                    means less. From the XYZ segmentation.
      materiality   a C-item's history is thinner and noisier than an A-item's.
      evidence      a proposal supported by one observation is weaker than one
                    supported by five.

    Capped at 0.92: nothing here is certain, and a displayed 100% would be a lie.
    Floored at 0.25 so a weak-but-real signal is still rankable.
    """
    base = BASE_CONFIDENCE.get(rule, 0.50)
    consistency_factor = 0.55 + 0.90 * max(0.0, min(1.0, consistency - 0.5))
    vol = XYZ_FACTOR.get(xyz, 0.80)
    mat = ABC_FACTOR.get(abc, 0.90)
    ev = min(1.0, 0.72 + 0.07 * max(0, evidence_count))
    return round(max(0.25, min(0.92, base * consistency_factor * vol * mat * ev)), 3)


def clamp_factor(f: float) -> float:
    return max(MIN_FACTOR, min(MAX_FACTOR, f))


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else 0.0


# =====================================================================
# Data loading
# =====================================================================
def fetch(cur, sql):
    cur.execute(sql)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


class Data:
    """Everything the engine needs, loaded once."""

    def __init__(self, cur):
        ctx = fetch(cur, "SELECT * FROM APP.V_CONTEXT")[0]
        self.history_end = ctx["HISTORY_END_WEEK"]
        self.horizon_end = ctx["HORIZON_END_WEEK"]

        self.weeks = [r["WEEK_ID"] for r in fetch(
            cur, "SELECT WEEK_ID FROM CORE.DIM_WEEK ORDER BY WEEK_START_DATE")]
        self.widx = {w: i for i, w in enumerate(self.weeks)}

        self.series = {r["SERIES_ID"]: r for r in fetch(cur, """
            SELECT SERIES_ID, SERIES_LABEL, PRODUCT_ID, PRODUCT_NAME, CUSTOMER_ID,
                   CUSTOMER_NAME, CHANNEL_NAME, CATEGORY_NAME, PRICE_TIER,
                   SEGMENT_ABC, SEGMENT_XYZ, UNIT_PRICE_EUR,
                   BASE_ANNUAL_VALUE_EUR
            FROM APP.V_SERIES""")}

        # POS actuals, keyed for O(1) lookup by (series, week).
        self.pos = {}
        for r in fetch(cur, "SELECT SERIES_ID, WEEK_ID, UNITS FROM CORE.FACT_POS_WEEKLY"):
            self.pos[(r["SERIES_ID"], r["WEEK_ID"])] = float(r["UNITS"])

        # The committed forward plan (the 'live' origin's starting point).
        self.plan = {}
        for r in fetch(cur, """SELECT SERIES_ID, WEEK_ID, PLAN_UNITS, STAT_UNITS,
                                      OVERRIDE_UNITS, IS_LOCKED
                               FROM CORE.FACT_DEMAND_PLAN"""):
            self.plan[(r["SERIES_ID"], r["WEEK_ID"])] = r

        # Forecast vintages for FORWARD weeks at the back-run origins.
        # MADE_WEEK_ID is the origin, so this is the only honest way to know
        # what the plan said at a historical point in time.
        self.fc = defaultdict(dict)
        for r in fetch(cur, f"""
            SELECT SERIES_ID, MADE_WEEK_ID, TARGET_WEEK_ID, FORECAST_UNITS
            FROM ML.FACT_FORECAST
            WHERE MODEL_NAME = 'CONSENSUS'
              AND MADE_WEEK_ID IN ({','.join("'" + o + "'" for o in BACKRUN_ORIGINS)})"""):
            self.fc[r["MADE_WEEK_ID"]][(r["SERIES_ID"], r["TARGET_WEEK_ID"])] = \
                float(r["FORECAST_UNITS"])

        # Residuals of ONE-WEEK-AHEAD forecasts. This is the series the bias
        # rule measures against: a lag-1 forecast has already seen everything up
        # to the week before, so a bias that survives it is real model bias
        # rather than information the model has yet to absorb.
        self.shortlag = {}
        for r in fetch(cur, """
            SELECT SERIES_ID, TARGET_WEEK_ID, FORECAST_UNITS
            FROM ML.FACT_FORECAST
            WHERE MODEL_NAME = 'CONSENSUS' AND LAG_WEEKS = 1"""):
            self.shortlag[(r["SERIES_ID"], r["TARGET_WEEK_ID"])] = \
                float(r["FORECAST_UNITS"])

        # What we expected of a week that has now HAPPENED, a month out.
        #
        # FACT_DEMAND_PLAN holds forward weeks only, so it cannot answer this —
        # reaching for it is what originally left the velocity rule with no
        # expectations at all and silently emitting nothing. The lag-4 vintage is
        # the right source: a consistent "what did we think a month out", already
        # stored per target week, and by construction free of hindsight.
        self.vintage = {}
        for r in fetch(cur, """
            SELECT SERIES_ID, TARGET_WEEK_ID, FORECAST_UNITS
            FROM ML.FACT_FORECAST
            WHERE MODEL_NAME = 'CONSENSUS' AND LAG_WEEKS = 4"""):
            self.vintage[(r["SERIES_ID"], r["TARGET_WEEK_ID"])] = \
                float(r["FORECAST_UNITS"])

        # Per-series historical accuracy of the two models, used by override_decay.
        self.model_err = defaultdict(lambda: defaultdict(float))
        for r in fetch(cur, """
            SELECT f.SERIES_ID, f.MODEL_NAME, f.TARGET_WEEK_ID,
                   ABS(f.FORECAST_UNITS - p.UNITS) AS ERR
            FROM ML.FACT_FORECAST f
            JOIN CORE.FACT_POS_WEEKLY p
              ON p.SERIES_ID = f.SERIES_ID AND p.WEEK_ID = f.TARGET_WEEK_ID
            WHERE f.MODEL_NAME IN ('VECTRON_STAT', 'CONSENSUS') AND f.LAG_WEEKS <= 8"""):
            self.model_err[r["SERIES_ID"]][r["MODEL_NAME"]] += float(r["ERR"])

        self.promos = fetch(cur, """
            SELECT PROMO_ID, SERIES_ID, START_WEEK_ID, END_WEEK_ID, MECHANIC,
                   DEPTH_PCT, PLANNED_UPLIFT_PCT, ACTUAL_UPLIFT_PCT
            FROM CORE.FACT_PROMOTION""")

        self.events = fetch(cur, """
            SELECT EVENT_ID, EVENT_NAME, EVENT_TYPE, WEEK_ID, CUSTOMER_SCOPE,
                   LEAD_WEEKS,
                   REGEXP_REPLACE(EVENT_NAME, '\\\\s+[0-9]{4}$', '') AS EVENT_SERIES
            FROM CORE.DIM_EVENT WHERE WEEK_ID IS NOT NULL""")

        self.lost = defaultdict(float)
        for r in fetch(cur, """SELECT SERIES_ID, WEEK_ID, LOST_SALES_UNITS
                               FROM CORE.FACT_INVENTORY_WEEKLY
                               WHERE LOST_SALES_UNITS > 0"""):
            self.lost[(r["SERIES_ID"], r["WEEK_ID"])] = float(r["LOST_SALES_UNITS"])

        # Driver contributions, needed by the distribution and price rules.
        self.driver = defaultdict(dict)
        for r in fetch(cur, """SELECT SERIES_ID, WEEK_ID, DRIVER, CONTRIB_UNITS
                               FROM CORE.FACT_DRIVER_CONTRIB
                               WHERE DRIVER IN ('DISTRIBUTION', 'PRICE')"""):
            self.driver[(r["SERIES_ID"], r["WEEK_ID"])][r["DRIVER"]] = \
                float(r["CONTRIB_UNITS"])

        self.npd = fetch(cur, """
            SELECT PRODUCT_ID, PRODUCT_NAME, LAUNCH_WEEK_ID, ANALOGUE_PRODUCT_ID,
                   ANALOGUE_PRODUCT_NAME, SIMILARITY_SCORE, LIFECYCLE_STATUS
            FROM APP.V_NPD_TRACKING
            GROUP BY 1,2,3,4,5,6,7""")

        self.by_product = defaultdict(list)
        self.by_customer = defaultdict(list)
        for sid, s in self.series.items():
            self.by_product[s["PRODUCT_ID"]].append(sid)
            self.by_customer[s["CUSTOMER_ID"]].append(sid)

    def window(self, origin: str, back: int) -> list[str]:
        """The `back` weeks ending at and including `origin`."""
        i = self.widx[origin]
        return self.weeks[max(0, i - back + 1): i + 1]

    def forward(self, origin: str, n: int = HORIZON) -> list[str]:
        i = self.widx[origin]
        return self.weeks[i + 1: i + 1 + n]

    def plan_at(self, origin: str, sid: str, week: str) -> float | None:
        """
        What the plan said for `week`, as at `origin`.

        Live origin: the committed plan. Historical origin: the forecast vintage
        made at that week, which is the only leakage-free answer.
        """
        if origin == self.history_end:
            row = self.plan.get((sid, week))
            return float(row["PLAN_UNITS"]) if row else None
        return self.fc.get(origin, {}).get((sid, week))

    def expected_at(self, sid: str, week: str) -> float | None:
        """What was expected of a week that has already happened. See self.vintage."""
        return self.vintage.get((sid, week))


# =====================================================================
# Proposal accumulator
# =====================================================================
class Proposals:
    def __init__(self, data: Data, run_id: str, origin: str):
        self.d = data
        self.run_id = run_id
        self.origin = origin
        self.rows: list[dict] = []
        self.week_rows: list[tuple] = []

    def add(self, *, rule: str, sid: str, weeks: dict[str, tuple[float, float]],
            confidence_: float, reason_code: str, summary: str,
            diagnosis: dict, evidence: list[str],
            node_level: str | None = None, node_key: str | None = None) -> bool:
        """
        Register a proposal. `weeks` maps week_id -> (current, proposed).

        Returns False if the proposal fails the materiality bars, so callers can
        keep their loops flat.

        DELTA_VALUE_EUR is VALUE AT STAKE — the absolute volume moved, priced —
        not value gained. That framing is deliberate and consistent across every
        rule. It also happens to be the only sane choice for event_phasing,
        where volume is relocated between weeks so the NET delta is ~zero: a
        net-based figure would rank the most valuable correction the agent makes
        as the least important thing in the queue.
        """
        if not weeks:
            return False
        cur_total = sum(c for c, _ in weeks.values())
        new_total = sum(p for _, p in weeks.values())
        if cur_total <= 0:
            return False

        moved = sum(abs(p - c) for c, p in weeks.values())
        rel = moved / cur_total
        price = float(self.d.series[sid]["UNIT_PRICE_EUR"])
        value = moved * price
        if rel < MIN_REL_CHANGE or value < MIN_VALUE_EUR:
            return False

        pid = f"PRP-{uuid.uuid4().hex[:16]}"
        ordered = sorted(weeks)
        self.rows.append({
            "PROPOSAL_ID": pid, "RUN_ID": self.run_id, "AS_OF_WEEK": self.origin,
            "PROPOSAL_TYPE": rule, "SERIES_ID": sid,
            "NODE_LEVEL": node_level, "NODE_KEY": node_key,
            "WEEK_FROM": ordered[0], "WEEK_TO": ordered[-1],
            "CURRENT_UNITS": round(cur_total, 2),
            "PROPOSED_UNITS": round(new_total, 2),
            "DELTA_UNITS": round(new_total - cur_total, 2),
            "DELTA_VALUE_EUR": round(value, 2),
            "CONFIDENCE": confidence_, "REASON_CODE": reason_code,
            "TRIGGER_SUMMARY": summary[:600],
            "DIAGNOSIS": json.dumps(diagnosis)[:4000],
            "EVIDENCE": json.dumps(evidence)[:4000],
            "RATIONALE": None, "RATIONALE_SOURCE": "template",
            "STATUS": "proposed",
        })
        for w in ordered:
            c, p = weeks[w]
            self.week_rows.append((pid, w, round(c, 2), round(p, 2)))
        return True


# =====================================================================
# Rule families
# =====================================================================
def rule_bias_correction(d: Data, P: Proposals, origin: str) -> None:
    """
    A persistent, significance-tested bias in the model on THIS series.

    This replaces a naive velocity rule that measured how far sell-out had run
    from an older forecast vintage and carried a large fraction of it forward.
    That was wrong twice over. The forecast made AT the origin has already seen
    the recent weeks, so most of the deviation was stale information being
    counted a second time; and the prior four weeks' deviation predicts the next
    one with a correlation of only 0.148, so most of what it carried forward was
    noise. On the back-run it took WAPE from 17.6% to 21.6% — the rule was
    actively destroying accuracy.

    What survives removing the double-counting is genuine and measurable: the
    one-week-ahead forecast still runs 1.5% light on average across the
    portfolio, widening to 3.1% by lag 8. A lag-1 forecast has seen everything up
    to the week before, so a bias that persists THERE is not stale information —
    it is the model being consistently wrong in one direction on that series.

    So: measure the signed residual of one-week-ahead forecasts, require it to be
    both statistically distinguishable from zero AND materially large, and only
    then correct it. Applying the lag-1 bias across the whole 1-8 horizon is
    deliberately conservative, since the measured bias grows with lag.
    """
    fwd = d.forward(origin)
    if not fwd:
        return
    window = d.window(origin, BIAS_WINDOW)

    for sid, s in d.series.items():
        resid = []
        for w in window:
            a = d.pos.get((sid, w))
            f = d.shortlag.get((sid, w))
            if a is None or not f or f <= 0:
                continue
            resid.append(a / f - 1.0)
        if len(resid) < 8:
            continue

        n = len(resid)
        bias = sum(resid) / n
        var = sum((x - bias) ** 2 for x in resid) / (n - 1)
        se = math.sqrt(var / n) if var > 0 else 0.0

        # Empirical-Bayes shrinkage. Part of any measured bias is sampling noise,
        # and selecting a series BECAUSE its residual is large makes that worse.
        # Shrinking towards zero by the reliability of this series' own estimate
        # is what turns the correction into an improvement rather than an
        # overshoot, and it self-corrects: a noisily measured series shrinks more.
        shrink = (BIAS_TAU ** 2) / (BIAS_TAU ** 2 + se ** 2) if se > 0 else 1.0
        adj = bias * shrink

        if se > 0 and abs(bias) < SIGNIFICANCE * se:
            continue
        if abs(adj) < MIN_BIAS:
            continue

        t_stat = abs(bias) / se if se > 0 else float("inf")
        signs = [1 if x > 0 else -1 for x in resid]
        agree = sum(1 for x in signs if x == (1 if bias > 0 else -1)) / n
        factor = clamp_factor(1.0 + adj)

        weeks = {}
        for w in fwd:
            c = d.plan_at(origin, sid, w)
            if c is None or c <= 0:
                continue
            weeks[w] = (c, round(c * factor, 2))

        direction = "light" if bias > 0 else "heavy"
        P.add(
            rule="bias_correction", sid=sid, weeks=weeks,
            confidence_=confidence("bias_correction", agree, s["SEGMENT_XYZ"],
                                   s["SEGMENT_ABC"], n),
            reason_code="TREND_SHIFT",
            summary=(f"The baseline has run {abs(bias):.1%} {direction} on this series "
                     f"across {n} weeks of one-week-ahead forecasts, in the same "
                     f"direction {agree:.0%} of the time (t={t_stat:.1f}). Correcting "
                     f"{shrink:.0%} of it: part of any measured bias is sampling "
                     f"noise, so the estimate is shrunk towards zero."),
            diagnosis={"mean_bias_pct": round(bias * 100, 2),
                       "shrunk_bias_pct": round(adj * 100, 2),
                       "shrinkage_factor": round(shrink, 3),
                       "between_series_tau_pct": round(BIAS_TAU * 100, 2),
                       "standard_error_pct": round(se * 100, 3),
                       "t_statistic": round(t_stat, 2),
                       "weeks_measured": n,
                       "direction_agreement": round(agree, 2),
                       "applied_factor": round(factor, 4),
                       "measured_at_lag": 1,
                       "note": ("Measured on lag-1 residuals, so the model already "
                                "knew the recent level. This is model bias, not a "
                                "recent deviation it has yet to absorb.")},
            evidence=[f"{w}: actual {d.pos.get((sid, w), 0):,.0f} vs one-week-ahead "
                      f"forecast {(d.shortlag.get((sid, w)) or 0):,.0f} units"
                      for w in window[-6:]],
        )


def rule_event_phasing(d: Data, P: Proposals, origin: str) -> None:
    """
    The highest-value rule, and the one that justifies a weekly grain.

    Plant summer shutdowns move by a week or more between years (Bavaria: 29 July
    2024, 4 August 2025), and OEMs pre-build into the weeks before. A plan phased
    off last year.s calendar weeks puts the pre-build in the wrong week — a mistake that is
    invisible in a monthly plan and expensive in a weekly one.

    The build shape is ESTIMATED from prior occurrences of the same event in the
    same customer, using only history available at the origin. It is never read
    from DIM_EVENT.UPLIFT_FACTOR, which would be leaking the answer.
    """
    fwd = set(d.forward(origin, HORIZON))
    if not fwd:
        return
    OFFSETS = list(range(-5, 2))

    by_series_customer = defaultdict(list)
    for ev in d.events:
        by_series_customer[ev["EVENT_SERIES"]].append(ev)

    for ev_series, occurrences in by_series_customer.items():
        upcoming = [e for e in occurrences if e["WEEK_ID"] in fwd]
        past = [e for e in occurrences if e["WEEK_ID"] <= origin]
        if not upcoming or not past:
            continue

        for ev in upcoming:
            customers = [m.strip() for m in (ev["CUSTOMER_SCOPE"] or "").split(",") if m.strip()]
            for mid in customers:
                for sid in d.by_customer.get(mid, []):
                    s = d.series[sid]

                    # Estimate the shape from this series' own past occurrences.
                    shapes = []
                    for pev in past:
                        if mid not in (pev["CUSTOMER_SCOPE"] or ""):
                            continue
                        pi = d.widx.get(pev["WEEK_ID"])
                        if pi is None:
                            continue
                        vals = []
                        for off in OFFSETS:
                            j = pi + off
                            if j < 0 or j >= len(d.weeks):
                                vals = []
                                break
                            vals.append(d.pos.get((sid, d.weeks[j])))
                        if not vals or any(v is None for v in vals):
                            continue
                        tot = sum(vals)
                        if tot <= 0:
                            continue
                        shapes.append([v / tot for v in vals])
                    if len(shapes) < 3:
                        continue

                    shape = [mean([sh[k] for sh in shapes]) for k in range(len(OFFSETS))]
                    ssum = sum(shape)
                    if ssum <= 0:
                        continue
                    shape = [x / ssum for x in shape]

                    # The plan's own phasing across the same window.
                    ei = d.widx[ev["WEEK_ID"]]
                    win, cur = [], []
                    for off in OFFSETS:
                        j = ei + off
                        if j < 0 or j >= len(d.weeks):
                            win = []
                            break
                        w = d.weeks[j]
                        c = d.plan_at(origin, sid, w)
                        if c is None:
                            win = []
                            break
                        win.append(w)
                        cur.append(c)
                    if not win:
                        continue
                    total = sum(cur)
                    if total <= 0:
                        continue

                    proposed = [total * x for x in shape]
                    # Only re-phase the weeks that are actually still open.
                    weeks = {w: (cur[k], round(proposed[k], 2))
                             for k, w in enumerate(win) if w in fwd}
                    if len(weeks) < 3:
                        continue

                    plan_peak = win[cur.index(max(cur))]
                    hist_peak = win[shape.index(max(shape))]
                    if plan_peak == hist_peak:
                        continue   # already phased correctly; nothing to say

                    # Consistency: how tightly the past occurrences agreed on
                    # where the peak sits.
                    peaks = [sh.index(max(sh)) for sh in shapes]
                    agree = peaks.count(max(set(peaks), key=peaks.count)) / len(peaks)
                    # Past occurrences must actually agree on where the peak sits.
                    # Averaging two disagreeing shapes produces a phasing nobody
                    # observed, which is why this scored only 39% before the gate.
                    if agree < 0.60:
                        continue

                    P.add(
                        rule="event_phasing", sid=sid, weeks=weeks,
                        confidence_=confidence("event_phasing", agree,
                                               s["SEGMENT_XYZ"], s["SEGMENT_ABC"],
                                               len(shapes)),
                        reason_code="EVENT_TIMING",
                        node_level="EVENT_CUSTOMER", node_key=f"{ev_series} · {mid}",
                        summary=(f"{ev['EVENT_NAME']} falls in {ev['WEEK_ID']}. Across "
                                 f"{len(shapes)} prior occurrences pull peaked in "
                                 f"{hist_peak.split('-')[1]} relative terms, but the plan "
                                 f"peaks in {plan_peak.split('-')[1]}. Re-phasing the "
                                 f"window; the total is unchanged."),
                        diagnosis={"event": ev["EVENT_NAME"],
                                   "event_week": ev["WEEK_ID"],
                                   "plan_peak_week": plan_peak,
                                   "historical_peak_week": hist_peak,
                                   "window_total_units": round(total, 1),
                                   "occurrences_used": len(shapes),
                                   "historical_shape": [round(x, 4) for x in shape],
                                   "peak_agreement": round(agree, 2)},
                        evidence=[f"{pev['EVENT_NAME']} fell in {pev['WEEK_ID']}"
                                  for pev in past[-4:]],
                    )


def rule_service_risk(d: Data, P: Proposals, origin: str) -> None:
    """
    Where a stockout truncated sell-out, POS understates true demand, and any
    model fitted on POS inherits that bias. This is one of the few corrections
    that is mechanically justified rather than statistically inferred, which is
    why its base confidence is high.

    DORMANT ON THIS DATASET, deliberately. The generated inventory policy holds
    enough cover that stockouts are almost absent: 16 series-weeks in the whole
    history, all in 2025-W37..W39, totalling 157 units. That is far below the
    materiality bar, so this rule correctly emits nothing at the origins used
    here. The threshold has NOT been dropped to make it fire — manufacturing
    proposals out of 157 units of noise would be inventing a capability. The
    logic is kept because it is right, and on a real portfolio with real service
    failures it is one of the most valuable rules in the engine.
    """
    recent = d.window(origin, HORIZON)
    fwd = d.forward(origin)
    if not fwd:
        return

    for sid, s in d.series.items():
        lost = [(w, d.lost.get((sid, w), 0.0)) for w in recent]
        lost_total = sum(v for _, v in lost)
        if lost_total <= 0:
            continue
        pos_total = sum(d.pos.get((sid, w), 0.0) for w in recent)
        if pos_total <= 0:
            continue
        ratio = lost_total / pos_total
        if ratio < 0.02:
            continue

        weeks_affected = sum(1 for _, v in lost if v > 0)
        factor = clamp_factor(1.0 + DAMP["service_risk"] * ratio)

        weeks = {}
        for w in fwd:
            c = d.plan_at(origin, sid, w)
            if c is None or c <= 0:
                continue
            weeks[w] = (c, round(c * factor, 2))

        P.add(
            rule="service_risk", sid=sid, weeks=weeks,
            confidence_=confidence("service_risk", weeks_affected / max(1, len(recent)),
                                   s["SEGMENT_XYZ"], s["SEGMENT_ABC"], weeks_affected),
            reason_code="SUPPLY_CONSTRAINT",
            summary=(f"{lost_total:,.0f} units of demand went unmet across "
                     f"{weeks_affected} of the last {len(recent)} weeks "
                     f"({ratio:.1%} of pull). Pull therefore understates true "
                     f"demand and the baseline has absorbed a censored signal."),
            diagnosis={"lost_sales_units": round(lost_total, 1),
                       "pos_units": round(pos_total, 1),
                       "censoring_ratio_pct": round(ratio * 100, 2),
                       "weeks_affected": weeks_affected,
                       "applied_factor": round(factor, 4),
                       "damping": DAMP["service_risk"]},
            evidence=[f"{w}: {v:,.0f} units lost to stockout" for w, v in lost if v > 0][:6],
        )


def rule_promo_response(d: Data, P: Proposals, origin: str) -> None:
    """
    This series' promotions have systematically over- or under-delivered against
    their planned uplift, and there is another promotion coming that still
    assumes the planned figure.
    """
    fwd = set(d.forward(origin))
    realisation: dict[str, list[float]] = defaultdict(list)
    for p in d.promos:
        if p["END_WEEK_ID"] > origin or p["ACTUAL_UPLIFT_PCT"] is None:
            continue
        planned = float(p["PLANNED_UPLIFT_PCT"] or 0)
        if planned <= 0:
            continue
        realisation[p["SERIES_ID"]].append(float(p["ACTUAL_UPLIFT_PCT"]) / planned)

    for p in d.promos:
        sid = p["SERIES_ID"]
        if p["START_WEEK_ID"] not in fwd and p["END_WEEK_ID"] not in fwd:
            continue
        hist = realisation.get(sid, [])
        if len(hist) < 8:
            continue
        r = mean(hist)

        # Realisation has a portfolio-wide SD of 0.232, so a series' mean needs
        # enough observations to mean anything. Requiring only two and a flat 15%
        # trigger fired on pure noise: this rule scored a 0% win rate on the
        # back-run and pushed WAPE from 16.9% to 23.3%. Now it must beat its own
        # standard error before it will speak.
        n = len(hist)
        sd = math.sqrt(sum((x - r) ** 2 for x in hist) / (n - 1)) if n > 1 else 0.0
        se = sd / math.sqrt(n) if sd > 0 else 0.0
        if se > 0 and abs(r - 1.0) < SIGNIFICANCE * se:
            continue
        if abs(r - 1.0) < 0.15:
            continue

        planned = float(p["PLANNED_UPLIFT_PCT"] or 0)
        if planned <= 0:
            continue
        # Rescale only the uplift portion of the plan, not the whole baseline.
        factor = clamp_factor((1 + planned * r * DAMP["promo_response"]) / (1 + planned))

        weeks = {}
        i0, i1 = d.widx.get(p["START_WEEK_ID"]), d.widx.get(p["END_WEEK_ID"])
        if i0 is None or i1 is None:
            continue
        for w in d.weeks[i0:i1 + 1]:
            if w not in fwd:
                continue
            c = d.plan_at(origin, sid, w)
            if c is None or c <= 0:
                continue
            weeks[w] = (c, round(c * factor, 2))

        s = d.series[sid]
        agree = sum(1 for x in hist if (x > 1) == (r > 1)) / len(hist)
        P.add(
            rule="promo_response", sid=sid, weeks=weeks,
            confidence_=confidence("promo_response", agree, s["SEGMENT_XYZ"],
                                   s["SEGMENT_ABC"], len(hist)),
            reason_code="PROMO_PLAN",
            summary=(f"The last {len(hist)} promotions on this series delivered "
                     f"{r:.0%} of their planned uplift (standard error "
                     f"{se:.1%}). {p['MECHANIC']} at "
                     f"{float(p['DEPTH_PCT'] or 0):.0%} in {p['START_WEEK_ID']} still "
                     f"assumes the full {planned:.0%}."),
            diagnosis={"promo_id": p["PROMO_ID"], "mechanic": p["MECHANIC"],
                       "planned_uplift_pct": round(planned * 100, 1),
                       "historical_realisation": round(r, 3),
                       "realisation_std_error": round(se, 4),
                       "promos_observed": len(hist),
                       "applied_factor": round(factor, 4)},
            evidence=[f"realisation {x:.0%} of planned" for x in hist[-5:]],
        )


def rule_distribution(d: Data, P: Proposals, origin: str) -> None:
    """
    The distribution driver has moved persistently and the forward plan has not
    absorbed it. Compares the recent contribution to a trailing baseline.
    """
    recent = d.window(origin, LOOKBACK)
    trailing = d.window(origin, TRAILING + LOOKBACK)[:TRAILING]
    fwd = d.forward(origin)
    if not fwd or not trailing:
        return

    for sid, s in d.series.items():
        rc = [d.driver.get((sid, w), {}).get("DISTRIBUTION") for w in recent]
        tc = [d.driver.get((sid, w), {}).get("DISTRIBUTION") for w in trailing]
        rc = [x for x in rc if x is not None]
        tc = [x for x in tc if x is not None]
        if len(rc) < 3 or len(tc) < 8:
            continue

        rpos = mean([d.pos.get((sid, w), 0.0) for w in recent])
        if rpos <= 0:
            continue
        shift = (mean(rc) - mean(tc)) / rpos
        if abs(shift) < 0.025:
            continue

        signs = [1 if (x - mean(tc)) > 0 else -1 for x in rc]
        agree = sum(1 for x in signs if x == (1 if shift > 0 else -1)) / len(signs)
        factor = clamp_factor(1.0 + DAMP["distribution"] * shift)

        weeks = {}
        for w in fwd:
            c = d.plan_at(origin, sid, w)
            if c is None or c <= 0:
                continue
            weeks[w] = (c, round(c * factor, 2))

        P.add(
            rule="distribution", sid=sid, weeks=weeks,
            confidence_=confidence("distribution", agree, s["SEGMENT_XYZ"],
                                   s["SEGMENT_ABC"], len(rc)),
            reason_code="DISTRIBUTION",
            summary=(f"Distribution contribution has shifted {shift:+.1%} of base "
                     f"volume against its {len(tc)}-week baseline and has held for "
                     f"{len(rc)} weeks. The forward plan still reflects the old level."),
            diagnosis={"recent_contrib_units": round(mean(rc), 1),
                       "baseline_contrib_units": round(mean(tc), 1),
                       "shift_pct_of_base": round(shift * 100, 2),
                       "applied_factor": round(factor, 4),
                       "damping": DAMP["distribution"]},
            evidence=[f"{w}: distribution contributed "
                      f"{d.driver.get((sid, w), {}).get('DISTRIBUTION', 0):,.0f} units"
                      for w in recent],
        )


def rule_price_change(d: Data, P: Proposals, origin: str) -> None:
    """
    A sustained price effect the baseline has not carried forward.

    The observed PRICE contribution is converted into an IMPLIED price move using
    the tier and channel elasticities from elasticity.json — the same file the
    application reads, so the agent and the UI cannot explain the same number
    two different ways. Inverting an assumed elasticity is a genuinely weak step,
    which is why this rule has the lowest base confidence in the engine.

    DORMANT ON THIS DATASET, deliberately. The generator moves price as a slow
    annual trend rather than as discrete repricing events, so the measured PRICE
    contribution barely varies: a median shift of 0.19% of base volume and a
    maximum of 1.02%, against a 2% trigger. There is no price event here to
    detect. Lowering the trigger under 1% would just be reading noise through an
    assumed elasticity and presenting the result as a recommendation.
    """
    recent = d.window(origin, LOOKBACK)
    trailing = d.window(origin, TRAILING + LOOKBACK)[:TRAILING]
    fwd = d.forward(origin)
    if not fwd or not trailing:
        return

    for sid, s in d.series.items():
        rc = [d.driver.get((sid, w), {}).get("PRICE") for w in recent]
        tc = [d.driver.get((sid, w), {}).get("PRICE") for w in trailing]
        rc = [x for x in rc if x is not None]
        tc = [x for x in tc if x is not None]
        if len(rc) < 3 or len(tc) < 8:
            continue

        rpos = mean([d.pos.get((sid, w), 0.0) for w in recent])
        if rpos <= 0:
            continue
        shift = (mean(rc) - mean(tc)) / rpos
        if abs(shift) < 0.02:
            continue

        elasticity = (TIER_ELASTICITY.get(s["PRICE_TIER"], -1.0)
                      * CHANNEL_PRICE_MULTIPLIER.get(s["CHANNEL_NAME"], 1.0))
        if abs(elasticity) < 0.1:
            continue
        implied_price_move = shift / elasticity

        signs = [1 if (x - mean(tc)) > 0 else -1 for x in rc]
        agree = sum(1 for x in signs if x == (1 if shift > 0 else -1)) / len(signs)
        factor = clamp_factor(1.0 + DAMP["price_change"] * shift)

        weeks = {}
        for w in fwd:
            c = d.plan_at(origin, sid, w)
            if c is None or c <= 0:
                continue
            weeks[w] = (c, round(c * factor, 2))

        P.add(
            rule="price_change", sid=sid, weeks=weeks,
            confidence_=confidence("price_change", agree, s["SEGMENT_XYZ"],
                                   s["SEGMENT_ABC"], len(rc)),
            reason_code="PRICE_CHANGE",
            summary=(f"Price has been contributing {shift:+.1%} of base volume "
                     f"against its baseline for {len(rc)} weeks. At an assumed "
                     f"elasticity of {elasticity:.2f} for {s['PRICE_TIER']} in "
                     f"{s['CHANNEL_NAME']}, that implies a "
                     f"{implied_price_move:+.1%} realised price move the plan has "
                     f"not carried forward."),
            diagnosis={"recent_contrib_units": round(mean(rc), 1),
                       "baseline_contrib_units": round(mean(tc), 1),
                       "volume_shift_pct": round(shift * 100, 2),
                       "assumed_elasticity": round(elasticity, 3),
                       "implied_price_move_pct": round(implied_price_move * 100, 2),
                       "applied_factor": round(factor, 4),
                       "assumption_source": "elasticity.json"},
            evidence=[f"{w}: price contributed "
                      f"{d.driver.get((sid, w), {}).get('PRICE', 0):,.0f} units"
                      for w in recent],
        )


def rule_override_decay(d: Data, P: Proposals, origin: str) -> None:
    """
    A standing manual override that this series' own track record does not
    support. Only fires where the statistical model has beaten the
    planner-adjusted consensus on THIS series over its history, so it is an
    evidenced argument rather than a blanket preference for the model.
    """
    fwd = d.forward(origin)
    if not fwd or origin != d.history_end:
        # Overrides only exist on the committed plan, so this rule has nothing
        # to look at from a historical forecast vintage.
        return

    for sid, s in d.series.items():
        err = d.model_err.get(sid, {})
        stat_err, cons_err = err.get("VECTRON_STAT"), err.get("CONSENSUS")
        if not stat_err or not cons_err or stat_err >= cons_err:
            continue
        edge = (cons_err - stat_err) / cons_err

        weeks, gaps = {}, []
        for w in fwd:
            row = d.plan.get((sid, w))
            if not row or row["OVERRIDE_UNITS"] is None or row["IS_LOCKED"]:
                continue
            stat = float(row["STAT_UNITS"])
            plan = float(row["PLAN_UNITS"])
            if stat <= 0 or abs(plan - stat) / stat < 0.10:
                continue
            weeks[w] = (plan, round(stat, 2))
            gaps.append((w, plan, stat))
        if len(weeks) < 2:
            continue

        P.add(
            rule="override_decay", sid=sid, weeks=weeks,
            confidence_=confidence("override_decay", 0.5 + min(0.5, edge),
                                   s["SEGMENT_XYZ"], s["SEGMENT_ABC"], len(gaps)),
            reason_code="OVERRIDE_REVIEW",
            summary=(f"{len(weeks)} forward weeks carry a manual override, but on "
                     f"this series the statistical baseline has been {edge:.1%} more "
                     f"accurate than the adjusted plan across its history. "
                     f"Recommend reverting to baseline."),
            diagnosis={"stat_abs_error": round(stat_err, 1),
                       "consensus_abs_error": round(cons_err, 1),
                       "model_edge_pct": round(edge * 100, 2),
                       "weeks_overridden": len(weeks)},
            evidence=[f"{w}: plan {p:,.0f} vs baseline {st:,.0f} units"
                      for w, p, st in gaps[:6]],
        )


def rule_npd_ramp(d: Data, P: Proposals, origin: str) -> None:
    """
    A launch tracking off the ramp that was expected of it.

    Uses a 13-week window rather than the velocity rule's 4, because early launch
    weeks are extremely noisy — pipeline fill, listing phasing and trade loading
    all land in the first weeks and none of them are consumer demand. The
    analogue product is named in the diagnosis because that is what the original
    ramp was built from, and it is what a planner will argue with.
    """
    fwd = d.forward(origin)
    if not fwd:
        return
    NPD_WINDOW = 13

    for n in d.npd:
        if n["LIFECYCLE_STATUS"] not in ("Launch", "Growth"):
            continue
        launch = n["LAUNCH_WEEK_ID"]
        if not launch or launch > origin:
            continue
        li, oi = d.widx.get(launch), d.widx[origin]
        if li is None or oi - li < 6:
            continue   # too early to judge

        window = [w for w in d.window(origin, NPD_WINDOW) if d.widx[w] >= li]
        if len(window) < 6:
            continue

        for sid in d.by_product.get(n["PRODUCT_ID"], []):
            s = d.series[sid]
            pairs = [(d.pos.get((sid, w)), d.expected_at(sid, w)) for w in window]
            pairs = [(a, e) for a, e in pairs if a is not None and e and e > 0]
            if len(pairs) < 6:
                continue

            o_sum = sum(a for a, _ in pairs)
            e_sum = sum(e for _, e in pairs)
            if e_sum <= 0:
                continue
            tracking = o_sum / e_sum
            if abs(tracking - 1.0) < 0.10:
                continue

            factor = clamp_factor(1.0 + DAMP["npd_ramp"] * (tracking - 1.0))
            weeks = {}
            for w in fwd:
                c = d.plan_at(origin, sid, w)
                if c is None or c <= 0:
                    continue
                weeks[w] = (c, round(c * factor, 2))

            signs = [1 if a > e else -1 for a, e in pairs]
            agree = sum(1 for x in signs
                        if x == (1 if tracking > 1 else -1)) / len(signs)
            weeks_live = oi - li + 1

            P.add(
                rule="npd_ramp", sid=sid, weeks=weeks,
                confidence_=confidence("npd_ramp", agree, s["SEGMENT_XYZ"],
                                       s["SEGMENT_ABC"], len(pairs)),
                reason_code="NPD_RAMP",
                node_level="PRODUCT", node_key=n["PRODUCT_NAME"],
                summary=(f"{n['PRODUCT_NAME']} is {weeks_live} weeks post-launch and has "
                         f"run at {tracking:.0%} of expectation over the last "
                         f"{len(pairs)} weeks. The ramp was built from "
                         f"{n['ANALOGUE_PRODUCT_NAME']} (similarity "
                         f"{float(n['SIMILARITY_SCORE'] or 0):.2f}); rescaling what "
                         f"remains of it rather than restating a curve the launch "
                         f"has already contradicted."),
                diagnosis={"product": n["PRODUCT_NAME"],
                           "analogue": n["ANALOGUE_PRODUCT_NAME"],
                           "similarity": float(n["SIMILARITY_SCORE"] or 0),
                           "cannibalisation_pct": float(n.get("CANNIBALISATION_PCT") or 0),
                           "weeks_since_launch": weeks_live,
                           "weeks_measured": len(pairs),
                           "observed_units": round(o_sum, 1),
                           "expected_units": round(e_sum, 1),
                           "tracking_ratio": round(tracking, 3),
                           "applied_factor": round(factor, 4),
                           "damping": DAMP["npd_ramp"]},
                evidence=[f"{w}: {a:,.0f} vs expected {e:,.0f} units"
                          for w, (a, e) in list(zip(window, pairs))[:6]],
            )


RULES = [
    ("event_phasing", rule_event_phasing),
    ("service_risk", rule_service_risk),
    ("override_decay", rule_override_decay),
    ("promo_response", rule_promo_response),
    ("npd_ramp", rule_npd_ramp),
    ("distribution", rule_distribution),
    ("bias_correction", rule_bias_correction),
    ("price_change", rule_price_change),
]


# =====================================================================
# Persistence
# =====================================================================
PROPOSAL_COLS = ["PROPOSAL_ID", "RUN_ID", "AS_OF_WEEK", "PROPOSAL_TYPE", "SERIES_ID",
                 "NODE_LEVEL", "NODE_KEY", "WEEK_FROM", "WEEK_TO", "CURRENT_UNITS",
                 "PROPOSED_UNITS", "DELTA_UNITS", "DELTA_VALUE_EUR", "CONFIDENCE",
                 "REASON_CODE", "TRIGGER_SUMMARY", "DIAGNOSIS", "EVIDENCE",
                 "RATIONALE", "RATIONALE_SOURCE", "STATUS"]


def insert_batch(cur, sql, rows, size=1000):
    for i in range(0, len(rows), size):
        cur.executemany(sql, rows[i:i + size])


def persist(cur, run_id, run_type, origin, proposals: Proposals):
    cur.execute(
        "INSERT INTO CORE.FACT_AGENT_RUN (RUN_ID, RUN_TYPE, AS_OF_WEEK, TRIGGERED_BY,"
        " STARTED_AT, COMPLETED_AT, STATUS, PROPOSAL_COUNT, NARRATIVE_MODE) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (run_id, run_type, origin, "scheduled", RUN_TS,
         datetime.utcnow().replace(microsecond=0), "completed",
         len(proposals.rows), "template"))

    if proposals.rows:
        placeholders = ", ".join(["%s"] * len(PROPOSAL_COLS))
        insert_batch(cur,
                     f"INSERT INTO CORE.FACT_AGENT_PROPOSAL ({', '.join(PROPOSAL_COLS)}) "
                     f"VALUES ({placeholders})",
                     [tuple(r[c] for c in PROPOSAL_COLS) for r in proposals.rows])
    if proposals.week_rows:
        insert_batch(cur,
                     "INSERT INTO CORE.FACT_AGENT_PROPOSAL_WEEK "
                     "(PROPOSAL_ID, WEEK_ID, CURRENT_UNITS, PROPOSED_UNITS) "
                     "VALUES (%s, %s, %s, %s)",
                     proposals.week_rows)


def seed_decisions(cur, proposals: Proposals, rng: random.Random):
    """
    Seeded human decisions for the back-run only, so the scorecard has something
    to judge. A planner accepts more often when the agent is confident, which is
    what makes the resulting scorecard interesting rather than uniform: it lets
    the UI show that acceptance and improvement track confidence.

    These are clearly labelled as seeded in the UI. Inventing them for the LIVE
    queue would be dishonest — those are left untouched for the user to action.
    """
    rows = []
    for p in proposals.rows:
        conf = float(p["CONFIDENCE"])
        roll = rng.random()
        accept_p = 0.25 + 0.65 * conf
        if roll < accept_p * 0.78:
            decision, applied = "accept", p["PROPOSED_UNITS"]
        elif roll < accept_p:
            # Took the direction but trimmed the size — the commonest real
            # planner behaviour, and the reason edit_accept exists.
            trim = 0.5 + 0.35 * rng.random()
            applied = round(float(p["CURRENT_UNITS"])
                            + trim * (float(p["PROPOSED_UNITS"]) - float(p["CURRENT_UNITS"])), 2)
            decision = "edit_accept"
        else:
            decision, applied = "reject", None
        rows.append((f"DEC-{uuid.uuid4().hex[:16]}", p["PROPOSAL_ID"], decision,
                     "j.moreau@vectron-components.example", RUN_TS, applied, None,
                     "Seeded decision for scorecard history"))
        p["STATUS"] = {"accept": "accepted", "edit_accept": "edited_accepted",
                       "reject": "rejected"}[decision]

    if rows:
        insert_batch(cur,
                     "INSERT INTO CORE.FACT_AGENT_DECISION (DECISION_ID, PROPOSAL_ID,"
                     " DECISION, DECIDED_BY, DECIDED_AT, APPLIED_UNITS, SCENARIO_ID, NOTE)"
                     " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)", rows)
        insert_batch(cur,
                     "UPDATE CORE.FACT_AGENT_PROPOSAL SET STATUS = %s WHERE PROPOSAL_ID = %s",
                     [(p["STATUS"], p["PROPOSAL_ID"]) for p in proposals.rows])


def run_origin(cur, d: Data, origin: str, run_type: str, rng: random.Random) -> int:
    run_id = f"RUN-{run_type}-{origin}-{uuid.uuid4().hex[:8]}"
    P = Proposals(d, run_id, origin)
    for name, fn in RULES:
        if name in DISABLED:
            continue
        before = len(P.rows)
        fn(d, P, origin)
        print(f"    {name:16s} {len(P.rows) - before:5d}")
    persist(cur, run_id, run_type, origin, P)
    if run_type == "backrun":
        seed_decisions(cur, P, rng)
    return len(P.rows)


def main() -> int:
    rng = random.Random(20260916)   # fixed so the demo is reproducible
    conn = snowflake.connector.connect(**load_connection())
    cur = conn.cursor()
    try:
        cur.execute("USE DATABASE VECTRON_DEMAND")
        print("Loading...")
        d = Data(cur)
        print(f"  {len(d.series)} series, history ends {d.history_end}")

        # Idempotent: a re-run replaces the machine-generated content but leaves
        # any decisions the user made in the app alone unless they belong to a
        # run we are about to replace.
        print("Clearing previous agent output...")
        cur.execute("DELETE FROM CORE.FACT_AGENT_DECISION WHERE PROPOSAL_ID IN "
                    "(SELECT PROPOSAL_ID FROM CORE.FACT_AGENT_PROPOSAL)")
        cur.execute("DELETE FROM CORE.FACT_AGENT_PROPOSAL_WEEK")
        cur.execute("DELETE FROM CORE.FACT_AGENT_PROPOSAL")
        cur.execute("DELETE FROM CORE.FACT_AGENT_RUN")

        total = 0
        print(f"\nLive run at {d.history_end}")
        total += run_origin(cur, d, d.history_end, "live", rng)

        if not os.environ.get("ONLY_LIVE"):
            for origin in BACKRUN_ORIGINS:
                print(f"\nBack-run at {origin}")
                total += run_origin(cur, d, origin, "backrun", rng)

        conn.commit()
        print(f"\n{total} proposals written.")
        return 0
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
