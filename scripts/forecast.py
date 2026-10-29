#!/usr/bin/env python3
"""
Build the lag-versioned forecast history for Vectron Components.

Writes three model families into ML.FACT_FORECAST at every rolling origin, so
forecast value add and accuracy-by-horizon are real subtractions:

  NAIVE_SEASONAL  same ISO week last year, level-adjusted. A strong benchmark,
                  and the one that structurally MISHANDLES moveable feasts:
                  last year's shutdown pre-build sits in the wrong week.

  VECTRON_STAT   the production model. Removes estimated event effects before
                  fitting seasonality, then re-applies them at the correct
                  future week from the known event calendar. This is where its
                  value add over the naive benchmark comes from, and it is a
                  real effect rather than a tuned constant.

  CONSENSUS       VECTRON_STAT plus planner override. Some overrides help and
                  some hurt, which is the honest picture and the point of
                  measuring planner value add at all.

NO GROUND-TRUTH LEAKAGE
-----------------------
The model knows event DATES (a planner does) and the shape of the ship-in
pattern, but it does NOT read DIM_EVENT.UPLIFT_FACTOR, which is the generator's
ground truth. Event magnitude is estimated from historical outturn per customer
and event type. Seasonal indices are estimated only from data at or before each
origin, so no origin sees its own future.

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python scripts/forecast.py
"""
from __future__ import annotations

import csv
import gzip
import math
import random
import statistics
import sys
import tempfile
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

SEED = 419
HISTORY_END = "2026-W37"
BACKTEST_ORIGINS_FROM = "2026-W05"   # rolling origins from here to HISTORY_END-1
MAX_LAG = 8                          # backtest horizon
FORWARD_HORIZON = 52                 # plan horizon from HISTORY_END
# The horizon was 28 weeks until supply planning needed 52 (component lead
# times). `--extend` adds weeks 29..52 to an existing build WITHOUT touching
# weeks 1..28, so approved promotions, consensus inputs and cycle snapshots
# that reference them survive. A clean rebuild (no flag) produces all 52.
PRIOR_HORIZON = 28
EXTEND = "--extend" in sys.argv

# Damped trend: the further out, the less the recent slope is extrapolated.
TREND_DAMP = 0.85
LEVEL_WINDOW = 8
TREND_WINDOW = 26
PROFILE_EVERY = 8        # refit the seasonal profile every N origins

# Share of series-weeks a planner touches, and how good they are at it.
OVERRIDE_RATE = 0.16
OVERRIDE_SKILL = 0.58   # fraction of overrides that move towards the actual

REASONS = [
    "CUST_INTEL", "PROMO_PLAN", "LISTING_WIN", "EVENT_PHASE",
    "MODEL_MISS", "PRICE_CHANGE", "COMPETITOR", "NPD_RAMP",
]
PLANNERS = ["A. Rousseau", "M. Delacroix", "S. Kapoor", "L. Chen", "T. Nolan"]


# =====================================================================
# Event calendar — dates and shape only, never the generator's magnitude
# =====================================================================
def event_shapes(etype: str, duration: int) -> list[tuple[str, dict[int, float]]]:
    """
    Known relative shape of each plant-calendar event, split into components
    whose magnitudes are estimated independently (a pre-build and a shutdown
    move in opposite directions, so one scalar cannot fit both). Shared
    verbatim with generate_facts.py.
    """
    if etype == "SHUTDOWN":
        shut = {k: 1.0 for k in range(duration)}
        shut[duration] = 0.45            # ramp-up week
        return [("PREBUILD", {-2: 0.6, -1: 1.0}), ("SHUTDOWN", shut)]
    if etype == "CHANGEOVER":
        return [("CHANGEOVER", {0: 1.0})]
    return []


def build_event_weights(events, week_ids) -> dict:
    """
    (customer, week) -> {event_component: weight}. Weight is the known relative
    shape of the event, not its size. Components are keyed by type only, so
    the model learns one shutdown depth per customer from every prior year.
    """
    pos = {w: i for i, w in enumerate(week_ids)}
    out: dict[tuple[str, str], dict[str, float]] = {}
    for e in events:
        if e["WEEK_ID"] not in pos:
            continue
        centre = pos[e["WEEK_ID"]]
        for comp, shape in event_shapes(e["EVENT_TYPE"], int(e["DURATION_WEEKS"] or 1)):
            for off, wgt in shape.items():
                i = centre + off
                if 0 <= i < len(week_ids):
                    for mk in [s.strip() for s in e["CUSTOMER_SCOPE"].split(",")]:
                        slot = out.setdefault((mk, week_ids[i]), {})
                        slot[comp] = max(slot.get(comp, 0.0), wgt)
    return out


# =====================================================================
# Model
# =====================================================================
def centred_ma(vals: list[float], window: int = 52) -> list[float | None]:
    """Centred moving average via a rolling sum: O(n), not O(n*window)."""
    half = window // 2
    n = len(vals)
    out: list[float | None] = [None] * n
    if n < window:
        return out
    run = sum(vals[0:window])
    for i in range(half, n - half):
        lo = i - half
        if lo > 0:
            run += vals[lo + window - 1] - vals[lo - 1]
        out[i] = run / window
    return out


def estimate_profile(series_vals: dict, week_ids: list[str], iso_of: dict,
                     ev_weights: dict, customer_of: dict, group_of: dict,
                     upto: int) -> tuple[dict, dict]:
    """
    Estimate, using only weeks 0..upto:
      seasonal[(group, iso_week)] -> multiplicative index (mean 1)
      event_excess[(customer, etype)] -> excess per unit of event weight

    Event-contaminated weeks are excluded from the seasonal fit, then the event
    magnitude is estimated as the residual excess on those weeks. Doing it in
    that order stops a moveable feast from being smeared into a fixed ISO week.
    """
    ratios: dict[tuple[str, int], list[float]] = {}
    ev_obs: dict[tuple[str, str], list[float]] = {}

    for sid, vals in series_vals.items():
        grp = group_of[sid]
        mkt = customer_of[sid]
        window = vals[:upto + 1]
        if len(window) < 60:
            continue
        trend = centred_ma(window, 52)
        for i, (a, t) in enumerate(zip(window, trend)):
            if t is None or t <= 0 or a <= 0:
                continue
            r = a / t
            wid = week_ids[i]
            ew = ev_weights.get((mkt, wid), {})
            if ew:
                continue                      # hold back for the event fit
            ratios.setdefault((grp, iso_of[wid]), []).append(r)

    seasonal: dict[tuple[str, int], float] = {}
    by_group: dict[str, list[float]] = {}
    for (grp, iso), rs in ratios.items():
        v = statistics.median(rs)
        seasonal[(grp, iso)] = v
        by_group.setdefault(grp, []).append(v)
    # Normalise each group's profile to mean 1 so it carries no level
    for grp, vs in by_group.items():
        m = sum(vs) / len(vs) if vs else 1.0
        if m > 0:
            for iso in range(1, 54):
                if (grp, iso) in seasonal:
                    seasonal[(grp, iso)] /= m

    # Second pass: event magnitude as residual excess over seasonal expectation
    for sid, vals in series_vals.items():
        grp = group_of[sid]
        mkt = customer_of[sid]
        window = vals[:upto + 1]
        if len(window) < 60:
            continue
        trend = centred_ma(window, 52)
        for i, (a, t) in enumerate(zip(window, trend)):
            if t is None or t <= 0 or a <= 0:
                continue
            wid = week_ids[i]
            ew = ev_weights.get((mkt, wid), {})
            if not ew:
                continue
            s = seasonal.get((grp, iso_of[wid]), 1.0)
            expected = t * s
            if expected <= 0:
                continue
            excess = a / expected - 1.0
            total_w = sum(ew.values())
            if total_w <= 0:
                continue
            for etype, wgt in ew.items():
                ev_obs.setdefault((mkt, etype), []).append(
                    excess * (wgt / total_w) / max(wgt, 1e-6)
                )

    event_excess = {k: statistics.median(v) for k, v in ev_obs.items() if v}
    return seasonal, event_excess


def forecast_stat(vals: list[float], origin_i: int, target_i: int,
                  week_ids, iso_of, seasonal, event_excess, ev_weights,
                  grp: str, mkt: str) -> float:
    """VECTRON_STAT: damped level-trend on deseasonalised, event-adjusted data."""
    def deseason(i: int) -> float | None:
        a = vals[i]
        if a <= 0:
            return None
        s = seasonal.get((grp, iso_of[week_ids[i]]), 1.0)
        ew = ev_weights.get((mkt, week_ids[i]), {})
        e = 1.0
        for etype, wgt in ew.items():
            e *= 1.0 + event_excess.get((mkt, etype), 0.0) * wgt
        if s <= 0 or e <= 0:
            return None
        return a / (s * e)

    lo = max(0, origin_i - LEVEL_WINDOW + 1)
    recent = [d for d in (deseason(i) for i in range(lo, origin_i + 1)) if d]
    if not recent:
        return 0.0
    level = sum(recent) / len(recent)

    tlo = max(0, origin_i - TREND_WINDOW + 1)
    tvals = [(i, d) for i in range(tlo, origin_i + 1) if (d := deseason(i))]
    slope = 0.0
    if len(tvals) >= 8:
        n = len(tvals)
        mx = sum(i for i, _ in tvals) / n
        my = sum(d for _, d in tvals) / n
        num = sum((i - mx) * (d - my) for i, d in tvals)
        den = sum((i - mx) ** 2 for i, _ in tvals)
        if den > 0:
            slope = num / den

    h = target_i - origin_i
    damp = sum(TREND_DAMP ** k for k in range(1, h + 1))
    base = max(0.0, level + slope * damp)

    s = seasonal.get((grp, iso_of[week_ids[target_i]]), 1.0)
    ew = ev_weights.get((mkt, week_ids[target_i]), {})
    e = 1.0
    for etype, wgt in ew.items():
        e *= 1.0 + event_excess.get((mkt, etype), 0.0) * wgt
    return max(0.0, base * s * e)


def forecast_naive(vals: list[float], origin_i: int, target_i: int) -> float:
    """
    Seasonal naive with level adjustment: same week last year, scaled by the
    ratio of the last 8 weeks to the same 8 weeks a year earlier.

    Structurally cannot handle a moveable feast, which is the point.
    """
    ly = target_i - 52
    if ly < 0 or ly >= len(vals):
        return max(0.0, vals[origin_i])
    baseline = vals[ly]

    a = [vals[i] for i in range(max(0, origin_i - 7), origin_i + 1)]
    b = [vals[i] for i in range(max(0, origin_i - 59), max(0, origin_i - 51)) ]
    ratio = 1.0
    if a and b and sum(b) > 0:
        ratio = sum(a) / sum(b)
        ratio = min(max(ratio, 0.5), 2.0)
    return max(0.0, baseline * ratio)


# =====================================================================
# Main
# =====================================================================
def extend_horizon(cur, conn, vals, week_ids, iso_of, hist_i, group_of,
                   customer_of, profile_for, ev_weights, resid_scale, growth_at,
                   outdir) -> int:
    """Append plan weeks PRIOR_HORIZON+1..FORWARD_HORIZON to an existing build.

    Uses its OWN seeded generator so weeks 1..28 (already loaded, and already
    referenced by approvals and cycle snapshots) are not regenerated. Re-running
    replaces only the extension rows, so it is idempotent.
    """
    rng = random.Random(SEED + FORWARD_HORIZON)
    first_new = week_ids[hist_i + PRIOR_HORIZON + 1]
    fc_path = outdir / "fc_ext.csv.gz"
    pl_path = outdir / "plan_ext.csv.gz"
    n = 0
    with gzip.open(fc_path, "wt", newline="") as fh, \
         gzip.open(pl_path, "wt", newline="") as ph:
        w_fc, w_pl = csv.writer(fh), csv.writer(ph)
        seasonal, ev_ex = profile_for(hist_i)
        for sid, v in vals.items():
            grp, mkt = group_of[sid], customer_of[sid]
            for h in range(PRIOR_HORIZON + 1, FORWARD_HORIZON + 1):
                ti = hist_i + h
                if ti >= len(week_ids):
                    break
                stat = forecast_stat(v, hist_i, ti, week_ids, iso_of, seasonal,
                                     ev_ex, ev_weights, grp, mkt)
                naive = forecast_naive(v, hist_i, ti)
                band = 1.96 * resid_scale[sid] * growth_at(h)
                cons, reason, planner = stat, "", ""
                if rng.random() < OVERRIDE_RATE:
                    reason = rng.choice(REASONS)
                    planner = rng.choice(PLANNERS)
                    cons = max(0.0, stat * (1.0 + rng.choice([-1, 1]) *
                                            rng.uniform(0.06, 0.30)))
                tw, mw = week_ids[ti], week_ids[hist_i]
                for name, f in (("NAIVE_SEASONAL", naive),
                                ("VECTRON_STAT", stat),
                                ("CONSENSUS", cons)):
                    w_fc.writerow([sid, tw, mw, h, name, round(f, 2),
                                   round(max(0.0, f - band), 2),
                                   round(f + band, 2)])
                w_pl.writerow([sid, tw, round(stat, 2),
                               round(cons, 2) if reason else "",
                               round(cons, 2), reason, "", planner])
                n += 1
    print(f"  extension: {n:,} series-weeks from {first_new}")

    cur.execute("CREATE OR REPLACE STAGE CORE.LOAD_STAGE_FC")
    cur.execute("""CREATE OR REPLACE FILE FORMAT CORE.CSV_GZ2
                   TYPE=CSV FIELD_DELIMITER=',' COMPRESSION=GZIP
                   NULL_IF=('') EMPTY_FIELD_AS_NULL=TRUE""")
    for p in (fc_path, pl_path):
        cur.execute(f"PUT 'file://{p.as_posix()}' @CORE.LOAD_STAGE_FC "
                    "AUTO_COMPRESS=FALSE OVERWRITE=TRUE")
    cur.execute("BEGIN")
    cur.execute("""DELETE FROM ML.FACT_FORECAST
                   WHERE MODEL_NAME <> 'CORTEX_ML' AND MADE_WEEK_ID = %s
                     AND LAG_WEEKS > %s""", (week_ids[hist_i], PRIOR_HORIZON))
    cur.execute(f"""COPY INTO ML.FACT_FORECAST FROM @CORE.LOAD_STAGE_FC/{fc_path.name}
                    FILE_FORMAT=(FORMAT_NAME=CORE.CSV_GZ2) ON_ERROR=ABORT_STATEMENT""")
    cur.execute("DELETE FROM CORE.FACT_DEMAND_PLAN WHERE WEEK_ID >= %s", (first_new,))
    cur.execute(f"""COPY INTO CORE.FACT_DEMAND_PLAN
                    (SERIES_ID, WEEK_ID, STAT_UNITS, OVERRIDE_UNITS,
                     PLAN_UNITS, REASON_CODE, OVERRIDE_NOTE, PLANNER)
                    FROM @CORE.LOAD_STAGE_FC/{pl_path.name}
                    FILE_FORMAT=(FORMAT_NAME=CORE.CSV_GZ2) ON_ERROR=ABORT_STATEMENT""")
    cur.execute("COMMIT")
    cur.execute("SELECT COUNT(*), MIN(WEEK_ID), MAX(WEEK_ID) FROM CORE.FACT_DEMAND_PLAN")
    print("  CORE.FACT_DEMAND_PLAN rows / range:", cur.fetchone())
    return 0


def main() -> int:
    rng = random.Random(SEED)
    params = load_connection()
    params.setdefault("role", "ACCOUNTADMIN")
    conn = snowflake.connector.connect(**params)
    cur = conn.cursor()
    try:
        cur.execute("USE DATABASE VECTRON_DEMAND")
        cur.execute("USE SCHEMA CORE")

        def rows(sql):
            cur.execute(sql)
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

        print("Loading...")
        weeks = rows("SELECT WEEK_ID, ISO_WEEK FROM DIM_WEEK ORDER BY WEEK_START_DATE")
        week_ids = [w["WEEK_ID"] for w in weeks]
        iso_of = {w["WEEK_ID"]: int(w["ISO_WEEK"]) for w in weeks}
        idx_of = {w: i for i, w in enumerate(week_ids)}
        hist_i = idx_of[HISTORY_END]

        series = rows("""SELECT SERIES_ID, CUSTOMER_ID, CATEGORY_ID, CHANNEL_ID
                         FROM DIM_SERIES ORDER BY SERIES_ID""")
        # Events are keyed on the customer for OE series production only.
        # Plant shutdowns stop the line, not the OEM's service-parts business,
        # so OES / IAM series get a distinct key that no event scope matches.
        # The generator uses the same rule (event_key_of), so the model knows
        # exactly what a planner would know: which weeks the plants are shut.
        customer_of = {s["SERIES_ID"]: (s["CUSTOMER_ID"] if s["CHANNEL_ID"] == "CH-OE"
                                       else s["CUSTOMER_ID"] + "|" + s["CHANNEL_ID"])
                       for s in series}
        group_of = {s["SERIES_ID"]: s["CATEGORY_ID"] + "|" + customer_of[s["SERIES_ID"]]
                    for s in series}

        events = rows("""SELECT EVENT_NAME, EVENT_TYPE, WEEK_ID, CUSTOMER_SCOPE, DURATION_WEEKS
                         FROM DIM_EVENT WHERE WEEK_ID IS NOT NULL""")
        ev_weights = build_event_weights(events, week_ids)

        cur.execute("""SELECT SERIES_ID, WEEK_ID, UNITS FROM FACT_POS_WEEKLY""")
        vals: dict[str, list[float]] = {
            s["SERIES_ID"]: [0.0] * len(week_ids) for s in series
        }
        for sid, wid, c in cur:
            if sid in vals and wid in idx_of:
                vals[sid][idx_of[wid]] = float(c)
        print(f"  {len(vals)} series, {len(week_ids)} weeks")

        # --- rolling origins ----------------------------------------
        origins = [i for i in range(idx_of[BACKTEST_ORIGINS_FROM], hist_i + 1)]
        print(f"  {len(origins)} origins from {week_ids[origins[0]]} "
              f"to {week_ids[origins[-1]]}")

        # Profiles are refitted only at anchor origins and reused forward from
        # there. Seasonality does not move materially week to week, and an
        # origin only ever uses a profile fitted at or BEFORE itself, so this
        # is a cost saving rather than a source of leakage.
        anchors = sorted({origins[0], *origins[::PROFILE_EVERY], origins[-1]})

        outdir = Path(tempfile.mkdtemp(prefix="meridian_fc_"))
        fc_path = outdir / "fc.csv.gz"
        pl_path = outdir / "plan.csv.gz"
        fh = gzip.open(fc_path, "wt", newline="")
        ph = gzip.open(pl_path, "wt", newline="")
        w_fc = csv.writer(fh)
        w_pl = csv.writer(ph)

        profile_cache: dict[int, tuple] = {}
        for ai in anchors:
            profile_cache[ai] = estimate_profile(
                vals, week_ids, iso_of, ev_weights, customer_of, group_of, ai
            )
            print(f"  profile fitted at {week_ids[ai]}", flush=True)

        def profile_for(oi: int) -> tuple:
            """Most recent anchor at or before this origin."""
            usable = [a for a in anchors if a <= oi]
            return profile_cache[max(usable) if usable else anchors[0]]

        # =============================================================
        # Pass 1: residuals, to calibrate prediction intervals empirically.
        #
        # Scaling a one-step residual by sqrt(h) assumes random-walk error
        # growth. That is wrong for this data: because seasonality and the
        # event calendar are known in advance, error barely grows with
        # horizon, and sqrt(h) over-widened the 8-week band to 99.9%
        # coverage against a 95% target. The growth factor is therefore
        # measured from the backtest rather than assumed.
        # =============================================================
        lag1_sq: dict[str, list[float]] = {}
        lag_sq: dict[int, list[float]] = {}
        for sid, v in vals.items():
            grp, mkt = group_of[sid], customer_of[sid]
            for oi in origins:
                seasonal, ev_ex = profile_for(oi)
                for h in range(1, MAX_LAG + 1):
                    ti = oi + h
                    if ti > hist_i or ti >= len(week_ids):
                        break
                    a = v[ti]
                    if a <= 0:
                        continue
                    f = forecast_stat(v, oi, ti, week_ids, iso_of, seasonal,
                                      ev_ex, ev_weights, grp, mkt)
                    e2 = (f - a) ** 2
                    lag_sq.setdefault(h, []).append(e2)
                    if h == 1:
                        lag1_sq.setdefault(sid, []).append(e2)

        def rms(xs: list[float]) -> float:
            return math.sqrt(sum(xs) / len(xs)) if xs else 0.0

        base_rms = rms(lag_sq.get(1, []))
        lag_growth = {
            h: (rms(lag_sq[h]) / base_rms if base_rms > 0 else 1.0)
            for h in sorted(lag_sq)
        }
        print("  measured interval growth by lag: "
              + ", ".join(f"{h}:{g:.2f}" for h, g in lag_growth.items()))

        def growth_at(h: int) -> float:
            if h in lag_growth:
                return lag_growth[h]
            # Beyond the backtest horizon there is no measurement, so extend
            # the last measured value with mild sub-linear growth and say so.
            last_h = max(lag_growth) if lag_growth else 1
            return lag_growth.get(last_h, 1.0) * (h / last_h) ** 0.35

        resid_scale: dict[str, float] = {}
        for sid, v in vals.items():
            s = rms(lag1_sq.get(sid, []))
            resid_scale[sid] = max(s, max(1.0, v[hist_i] * 0.05))

        if EXTEND:
            return extend_horizon(cur, conn, vals, week_ids, iso_of, hist_i,
                                  group_of, customer_of, profile_for, ev_weights,
                                  resid_scale, growth_at, outdir)

        plan_rows: dict[tuple[str, str], tuple] = {}

        for sid, v in vals.items():
            grp, mkt = group_of[sid], customer_of[sid]

            for oi in origins:
                seasonal, ev_ex = profile_for(oi)
                max_h = FORWARD_HORIZON if oi == hist_i else MAX_LAG
                for h in range(1, max_h + 1):
                    ti = oi + h
                    if ti >= len(week_ids):
                        break
                    if oi != hist_i and ti > hist_i:
                        break

                    stat = forecast_stat(v, oi, ti, week_ids, iso_of, seasonal,
                                         ev_ex, ev_weights, grp, mkt)
                    naive = forecast_naive(v, oi, ti)

                    band = 1.96 * resid_scale[sid] * growth_at(h)
                    actual = v[ti] if ti <= hist_i else None

                    # --- CONSENSUS: planner override ----------------
                    cons = stat
                    reason = ""
                    planner = ""
                    if rng.random() < OVERRIDE_RATE:
                        reason = rng.choice(REASONS)
                        planner = rng.choice(PLANNERS)
                        if actual is not None and rng.random() < OVERRIDE_SKILL:
                            # A good override moves part-way to the truth
                            cons = stat + (actual - stat) * rng.uniform(0.25, 0.75)
                        else:
                            # A poor one moves confidently in some direction
                            cons = stat * (1.0 + rng.choice([-1, 1]) *
                                           rng.uniform(0.06, 0.30))
                        cons = max(0.0, cons)

                    tw, mw = week_ids[ti], week_ids[oi]
                    for name, f in (("NAIVE_SEASONAL", naive),
                                    ("VECTRON_STAT", stat),
                                    ("CONSENSUS", cons)):
                        w_fc.writerow([
                            sid, tw, mw, h, name, round(f, 2),
                            round(max(0.0, f - band), 2), round(f + band, 2),
                        ])

                    if oi == hist_i:
                        plan_rows[(sid, tw)] = (
                            sid, tw, round(stat, 2),
                            round(cons, 2) if reason else "",
                            round(cons, 2), reason, "", planner,
                        )

        for r in plan_rows.values():
            w_pl.writerow(list(r))
        fh.close()
        ph.close()
        print(f"  forecast file {fc_path.stat().st_size / 1e6:.1f} MB")

        # --- load ---------------------------------------------------
        cur.execute("CREATE OR REPLACE STAGE CORE.LOAD_STAGE_FC")
        cur.execute("""CREATE OR REPLACE FILE FORMAT CORE.CSV_GZ2
                       TYPE=CSV FIELD_DELIMITER=',' COMPRESSION=GZIP
                       NULL_IF=('') EMPTY_FIELD_AS_NULL=TRUE""")
        cur.execute("DELETE FROM ML.FACT_FORECAST WHERE MODEL_NAME <> 'CORTEX_ML'")
        cur.execute(f"PUT 'file://{fc_path.as_posix()}' @CORE.LOAD_STAGE_FC "
                    "AUTO_COMPRESS=FALSE OVERWRITE=TRUE")
        cur.execute(f"""COPY INTO ML.FACT_FORECAST
                        FROM @CORE.LOAD_STAGE_FC/{fc_path.name}
                        FILE_FORMAT=(FORMAT_NAME=CORE.CSV_GZ2)
                        ON_ERROR=ABORT_STATEMENT""")
        cur.execute("SELECT COUNT(*) FROM ML.FACT_FORECAST WHERE MODEL_NAME<>'CORTEX_ML'")
        print(f"  ML.FACT_FORECAST: {cur.fetchone()[0]:,} backtest+plan rows")

        cur.execute("TRUNCATE TABLE CORE.FACT_DEMAND_PLAN")
        cur.execute(f"PUT 'file://{pl_path.as_posix()}' @CORE.LOAD_STAGE_FC "
                    "AUTO_COMPRESS=FALSE OVERWRITE=TRUE")
        cur.execute(f"""COPY INTO CORE.FACT_DEMAND_PLAN
                        (SERIES_ID, WEEK_ID, STAT_UNITS, OVERRIDE_UNITS,
                         PLAN_UNITS, REASON_CODE, OVERRIDE_NOTE, PLANNER)
                        FROM @CORE.LOAD_STAGE_FC/{pl_path.name}
                        FILE_FORMAT=(FORMAT_NAME=CORE.CSV_GZ2)
                        ON_ERROR=ABORT_STATEMENT""")
        cur.execute("SELECT COUNT(*) FROM CORE.FACT_DEMAND_PLAN")
        print(f"  CORE.FACT_DEMAND_PLAN: {cur.fetchone()[0]:,} rows")
        conn.commit()
    finally:
        cur.close()
        conn.close()
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
