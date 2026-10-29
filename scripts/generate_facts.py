#!/usr/bin/env python3
"""
Generate the weekly fact data for Vectron Components demand planning.

Deliberately dependency-free: standard library only, no numpy or pandas, so
the requirements stay as small as the sibling application's. Output is written
as gzipped CSV, staged, and loaded with COPY INTO, which is faster than any
row-by-row insert path.

WHAT IS MODELLED
----------------
Demand is built multiplicatively from a base level and then decomposed
additively, so FACT_DRIVER_CONTRIB sums exactly to FACT_POS_WEEKLY.UNITS.

The decomposition is sequential: the contribution of factor i is

    R_{i-1} * (f_i - 1)      where R_{i-1} = BASE * prod(f_1 .. f_{i-1})

which telescopes exactly to BASE * prod(f_i). This is exact, not approximate,
but it is ORDER-DEPENDENT: each factor is credited with its incremental effect
*given the factors already applied*. That is a real interpretive caveat and the
application states it rather than implying a Shapley-style symmetric split.

Sell-in is derived from sell-out through a target-cover inventory policy, so
shipments genuinely lead POS around events and the three tables reconcile:

    opening + shipments - POS = closing

HONESTY NOTE
------------
Weather, macro and competitor activity are SYNTHETIC. They are generated with
realistic structure and plausible magnitudes but they are not observations, and
every surface that shows them says so.

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python scripts/generate_facts.py
    SNOWFLAKE_CONNECTION_NAME=snowplan python scripts/generate_facts.py --dry-run
"""
from __future__ import annotations

import argparse
import csv
import gzip
import math
import os
import random
import sys
import tempfile
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

SEED = 20260916
HISTORY_END = "2026-W37"   # last week with actuals
HORIZON_END = "2027-W36"   # last week in the calendar (52 weeks forward)

# Driver order. Fixed, because the decomposition is order-dependent.
DRIVERS = [
    "BASE", "SEASONALITY", "EVENT", "PRICE", "PROMO",
    "DISTRIBUTION", "WEATHER", "MACRO", "COMPETITOR", "RESIDUAL",
]

# Annual real growth by customer. Premium German OEMs flat to slightly up,
# Stellantis and Ford soft, the aftermarket growing with an ageing car parc.
CUSTOMER_GROWTH = {
    "OEM-BMW": 0.015, "OEM-VW": -0.010, "OEM-AUDI": -0.015, "OEM-POR": -0.020,
    "OEM-MB": 0.000, "OEM-STLA": -0.030, "OEM-REN": 0.010, "OEM-FORD": -0.020,
    "AM-IAM": 0.030,
}

# Price response by engineering content, before channel adjustment. OE
# volumes are set by the OEM's build schedule, not by Vectron's price, so the
# channel multiplier for series production is close to zero.
TIER_ELASTICITY = {
    "Commodity": -1.40, "Standard": -1.00,
    "Engineered": -0.70, "Mechatronic": -0.45,
}
CHANNEL_PRICE_MULT = {"CH-OE": 0.10, "CH-OES": 0.50, "CH-IAM": 1.20}

# Weeks of forward cover held downstream. JIS/JIT lines hold under a week;
# the OEM parts business and distributors hold warehouse stock.
TARGET_COVER = {"CH-OE": 1.0, "CH-OES": 6.0, "CH-IAM": 8.0}

# Mean weeks between promotions. Only the independent aftermarket runs
# promotions (distributor campaigns); OE and OES never do.
PROMO_INTERVAL = {"CH-OE": None, "CH-OES": None, "CH-IAM": 9}

# Service series below this weekly base are lumpy: demand arrives as
# occasional orders rather than a steady flow (the Croston regime).
INTERMITTENT_BELOW = 150.0

COMPETITORS = {
    "CAT-BRAKE": ["Continental", "Brembo", "ZF"],
    "CAT-CHASSIS": ["ZF", "Thyssenkrupp", "Benteler"],
    "CAT-STEER": ["Bosch", "Nexteer", "ZF"],
    "CAT-PT": ["Schaeffler", "Magna", "GKN"],
    "CAT-EDRIVE": ["Schaeffler", "Vitesco", "GKN"],
}

ACTIVITY_TYPES = ["QUOTE_UNDERCUT", "RESOURCING_BID", "CAPACITY_ADD", "NEW_NOMINATION", "AM_CAMPAIGN"]


# =====================================================================
# Seasonality
# =====================================================================
def seasonal_index(cat_row: dict, iso_week: int, channel: str) -> float:
    """
    Multiplicative weekly seasonal index.

    OE series demand follows the build schedule, which is flat apart from the
    plant calendar (handled as events, because its weeks move every year) and a
    mild Q4 push to hit annual volume targets. Service and aftermarket demand
    follow vehicle use: brake and chassis wear parts peak in the winter half
    and after the spring tyre change.
    """
    idx = 1.0
    if channel == "CH-OE":
        # Year-end volume push in weeks 44-50, a soft first week back in January
        if 44 <= iso_week <= 50:
            idx *= 1.04
        if iso_week == 1:
            idx *= 0.85
        return idx

    if cat_row["IS_WINTER_SKEW"]:
        # Smooth winter hump peaking around week 3, trough in midsummer
        idx *= 1.0 + 0.22 * math.cos(2 * math.pi * (iso_week - 3) / 52)
        # Spring workshop surge around the tyre change (weeks 13-17)
        if 13 <= iso_week <= 17:
            idx *= 1.12
    else:
        idx *= 1.0 + 0.06 * math.cos(2 * math.pi * (iso_week - 10) / 52)
    # Workshops close over the August holidays and at Christmas
    if 31 <= iso_week <= 33:
        idx *= 0.82
    if iso_week in (52, 53):
        idx *= 0.70
    return idx


def event_index(events_for_week: list[dict]) -> float:
    idx = 1.0
    for e in events_for_week:
        idx *= e["factor"]
    return idx


# =====================================================================
# Data loading
# =====================================================================
def fetch_dims(cur) -> dict:
    def rows(sql):
        cur.execute(sql)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    weeks = rows("""
        SELECT WEEK_ID, WEEK_START_DATE, ISO_YEAR, ISO_WEEK
        FROM DIM_WEEK ORDER BY WEEK_START_DATE
    """)
    series = rows("""
        SELECT s.SERIES_ID, s.PRODUCT_ID, s.CUSTOMER_ID, s.CHANNEL_ID, s.CATEGORY_ID,
               s.BASE_ANNUAL_UNITS, s.LIFECYCLE_STATUS, s.LAUNCH_WEEK_ID, s.DELIST_WEEK_ID,
               b.PRICE_TIER, b.UNIT_PRICE_EUR, m.DELIVERY_MODE,
               c.IS_WINTER_SKEW, c.IS_EV_EXPOSED
        FROM DIM_SERIES s
        JOIN DIM_PRODUCT b    ON b.PRODUCT_ID = s.PRODUCT_ID
        JOIN DIM_CUSTOMER m   ON m.CUSTOMER_ID = s.CUSTOMER_ID
        JOIN DIM_CATEGORY c ON c.CATEGORY_ID = s.CATEGORY_ID
        ORDER BY s.SERIES_ID
    """)
    customers = rows("SELECT CUSTOMER_ID, DELIVERY_MODE, IS_AFTERMARKET FROM DIM_CUSTOMER")
    events = rows("""
        SELECT EVENT_ID, EVENT_NAME, EVENT_TYPE, WEEK_ID, CUSTOMER_SCOPE,
               LEAD_WEEKS, UPLIFT_FACTOR, DURATION_WEEKS
        FROM DIM_EVENT WHERE WEEK_ID IS NOT NULL
    """)
    cats = rows("SELECT CATEGORY_ID, IS_WINTER_SKEW, IS_EV_EXPOSED FROM DIM_CATEGORY")
    return {"weeks": weeks, "series": series, "customers": customers,
            "events": events, "cats": cats}


# =====================================================================
# Exogenous series
# =====================================================================
def build_weather(customers, weeks, rng) -> dict:
    """
    AR(1) winter-severity proxy per customer: temperature anomaly with
    cold-snap flags. Hard winters (salt, potholes) bring forward brake and
    chassis replacement in the service and aftermarket channels.
    """
    out = {}
    for m in customers:
        anomaly = 0.0
        for w in weeks:
            anomaly = 0.65 * anomaly + rng.gauss(0, 1.35)
            iso = w["ISO_WEEK"]
            winter = iso <= 10 or iso >= 46
            heat = anomaly > 3.0 and 22 <= iso <= 34
            cold = anomaly < -3.0 and winter
            out[(m["CUSTOMER_ID"], w["WEEK_ID"])] = (round(anomaly, 2), heat, cold)
    return out


def build_macro(customers, weeks, rng, event_weeks: dict) -> dict:
    """
    Vehicle-market sentiment, FX, a tariff index and fleet mileage per customer.

    Two structural breaks are deliberate: European new-car demand softens from
    2024-W09 (the sentiment TARGET moves, it is not subtracted every week, which
    would compound), and the US tariff on Mexican-built vehicles lifts Ford's
    tariff index from 2025-W10, aligned with EVT-TARIFF-MX.
    """
    out = {}
    for m in customers:
        mid = m["CUSTOMER_ID"]
        conf = 100.0
        fx = 1.0
        for w in weeks:
            target = 100.0
            if mid != "AM-IAM" and w["WEEK_ID"] >= "2024-W09":
                target = 95.0
            conf = 0.92 * conf + 0.08 * target + rng.gauss(0, 1.4)
            if m["CUSTOMER_ID"] == "OEM-FORD":
                fx *= 1.0 + rng.gauss(0.0, 0.004)   # USD/EUR
            tariff = 1.0
            if mid == "OEM-FORD" and w["WEEK_ID"] >= "2025-W10":
                tariff = 1.250
            iso = w["ISO_WEEK"]
            mileage = 100.0 + 9.0 * math.sin(2 * math.pi * (iso - 18) / 52) + rng.gauss(0, 2.5)
            out[(mid, w["WEEK_ID"])] = (
                round(conf, 2), round(fx, 4), round(tariff, 3), round(mileage, 2)
            )
    return out


def build_competitor(customers, cats, weeks, rng) -> list[tuple]:
    """Sparse competitive activity: roughly one event per customer-category per 14 weeks."""
    rows = []
    for m in customers:
        for c in cats:
            names = COMPETITORS.get(c["CATEGORY_ID"], [])
            if not names:
                continue
            for w in weeks:
                if rng.random() < 1.0 / 14.0:
                    rows.append((
                        m["CUSTOMER_ID"], c["CATEGORY_ID"], w["WEEK_ID"],
                        rng.choice(names), rng.choice(ACTIVITY_TYPES),
                        round(rng.uniform(0.20, 0.90), 3),
                    ))
    return rows


def event_shapes(etype: str, duration: int) -> list[tuple[str, dict[int, float]]]:
    """Shared verbatim with forecast.py: the known shape of each event."""
    if etype == "SHUTDOWN":
        shut = {k: 1.0 for k in range(duration)}
        shut[duration] = 0.45            # ramp-up week
        return [("PREBUILD", {-2: 0.6, -1: 1.0}), ("SHUTDOWN", shut)]
    if etype == "CHANGEOVER":
        return [("CHANGEOVER", {0: 1.0})]
    return []


# Pre-build strength ahead of a shutdown, as a fraction of a normal week.
PREBUILD_UPLIFT = 0.18


def resolve_events(events, weeks) -> dict:
    """
    Map each (event key, week) to the multipliers acting on it.

    SHUTDOWN: OEMs bank output in the two weeks before, the line then runs at
    UPLIFT_FACTOR of normal for DURATION_WEEKS, and a ramp-up week recovers
    part of the way. CHANGEOVER: a single-week dip. MACRO: a step change.
    """
    week_pos = {w["WEEK_ID"]: i for i, w in enumerate(weeks)}
    out: dict[tuple[str, str], list[dict]] = {}
    for e in events:
        if e["WEEK_ID"] not in week_pos:
            continue
        centre = week_pos[e["WEEK_ID"]]
        scope = [s.strip() for s in e["CUSTOMER_SCOPE"].split(",")]
        factor = float(e["UPLIFT_FACTOR"])
        etype = e["EVENT_TYPE"]

        if etype in ("SHUTDOWN", "CHANGEOVER"):
            for comp, shape in event_shapes(etype, int(e["DURATION_WEEKS"] or 1)):
                depth = PREBUILD_UPLIFT if comp == "PREBUILD" else (factor - 1.0)
                for off, w8 in shape.items():
                    i = centre + off
                    if 0 <= i < len(weeks):
                        wid = weeks[i]["WEEK_ID"]
                        for mk in scope:
                            out.setdefault((mk, wid), []).append(
                                {"event": e["EVENT_NAME"], "factor": 1.0 + depth * w8}
                            )
        else:
            for i in range(centre, len(weeks)):
                wid = weeks[i]["WEEK_ID"]
                for mk in scope:
                    out.setdefault((mk, wid), []).append(
                        {"event": e["EVENT_NAME"], "factor": factor}
                    )
    return out


# =====================================================================
# Lifecycle
# =====================================================================
def lifecycle_factor(s: dict, week_ids: list[str], i: int) -> float:
    wid = week_ids[i]
    launch = s["LAUNCH_WEEK_ID"]
    delist = s["DELIST_WEEK_ID"]

    if launch:
        if wid < launch:
            return 0.0
        # Bass-style diffusion: 40 weeks to plateau, inflection at week 12
        k = week_ids.index(launch)
        age = i - k
        return 1.0 / (1.0 + math.exp(-(age - 12) / 4.5))

    if delist:
        if wid >= delist:
            return 0.0
        k = week_ids.index(delist)
        remaining = k - i
        if remaining <= 26:
            return max(0.0, remaining / 26.0)
        return 1.0

    return 1.0


def status_trend(status: str, years: float) -> float:
    rate = {"Growth": 0.18, "Decline": -0.06, "Launch": 0.0,
            "Delisted": -0.10, "Mature": 0.0}.get(status, 0.0)
    return (1.0 + rate) ** years


# =====================================================================
# Main generation
# =====================================================================
def generate(dims, outdir: Path) -> dict[str, Path]:
    rng = random.Random(SEED)
    weeks = dims["weeks"]
    week_ids = [w["WEEK_ID"] for w in weeks]
    hist_n = week_ids.index(HISTORY_END) + 1

    cats_by_id = {c["CATEGORY_ID"]: c for c in dims["cats"]}
    weather = build_weather(dims["customers"], weeks, rng)
    macro = build_macro(dims["customers"], weeks, rng, {})
    competitor = build_competitor(dims["customers"], dims["cats"], weeks, rng)
    events_map = resolve_events(dims["events"], weeks)

    # Competitor intensity lookup by (customer, category, week)
    comp_lookup = {(m, c, w): inten for m, c, w, _n, _a, inten in competitor}

    paths = {
        "pos": outdir / "pos.csv.gz",
        "ship": outdir / "ship.csv.gz",
        "inv": outdir / "inv.csv.gz",
        "drv": outdir / "drv.csv.gz",
        "wth": outdir / "wth.csv.gz",
        "mac": outdir / "mac.csv.gz",
        "cmp": outdir / "cmp.csv.gz",
        "promo": outdir / "promo.csv.gz",
        "xyz": outdir / "xyz.csv.gz",
    }
    handles = {k: gzip.open(p, "wt", newline="") for k, p in paths.items()}
    wr = {k: csv.writer(h) for k, h in handles.items()}

    for (mid, wid), (anom, heat, cold) in weather.items():
        wr["wth"].writerow([mid, wid, anom, heat, cold])
    for (mid, wid), (conf, fx, exc, foot) in macro.items():
        wr["mac"].writerow([mid, wid, conf, fx, exc, foot])
    for row in competitor:
        wr["cmp"].writerow(list(row))

    promo_seq = 0
    for s in dims["series"]:
        sid = s["SERIES_ID"]
        mid = s["CUSTOMER_ID"]
        cid = s["CHANNEL_ID"]
        cat = cats_by_id[s["CATEGORY_ID"]]
        base_weekly = float(s["BASE_ANNUAL_UNITS"]) / 52.0
        list_price = float(s["UNIT_PRICE_EUR"])
        elasticity = TIER_ELASTICITY[s["PRICE_TIER"]] * CHANNEL_PRICE_MULT[cid]
        growth = CUSTOMER_GROWTH.get(mid, 0.0)
        # Plant-calendar events hit series production only (see forecast.py).
        ekey = mid if cid == "CH-OE" else mid + "|" + cid
        intermittent = cid != "CH-OE" and base_weekly < INTERMITTENT_BELOW
        # Probability a week sees any order at all. Small service series are
        # driven by a few workshop or distributor orders, not a steady flow.
        p_occ = min(0.95, max(0.12, base_weekly / 60.0)) if intermittent else 1.0

        # --- promotion calendar for this series ---------------------
        promo_weeks: dict[int, tuple[float, float]] = {}   # i -> (depth, planned_uplift)
        interval = PROMO_INTERVAL[cid]
        i = rng.randint(0, interval) if interval else len(week_ids)
        while i < len(week_ids):
            dur = rng.choice([1, 2, 2, 3])
            depth = round(rng.uniform(0.08, 0.30), 4)
            planned = round(-elasticity * depth + rng.uniform(0.05, 0.20), 4)
            promo_seq += 1
            pid = f"PRM-{promo_seq:06d}"
            end_i = min(i + dur - 1, len(week_ids) - 1)
            realised = None
            for j in range(i, end_i + 1):
                promo_weeks[j] = (depth, planned)
            if i < hist_n:
                realised = round(planned * rng.uniform(0.55, 1.35), 4)
            wr["promo"].writerow([
                pid, sid, week_ids[i], week_ids[end_i],
                rng.choice(["DISTRIBUTOR_REBATE", "VOLUME_BONUS", "WORKSHOP_CAMPAIGN", "SEASONAL_KIT"]),
                depth, planned, "" if realised is None else realised,
            ])
            i += max(dur, 1) + max(1, int(rng.gauss(interval, interval * 0.35)))

        # --- distribution random walk -------------------------------
        dist_base = max(50.0, base_weekly * rng.uniform(0.8, 1.6))
        dist = dist_base

        # --- weekly loop --------------------------------------------
        pos_hist: list[float] = []
        for i, w in enumerate(weeks):
            wid = w["WEEK_ID"]
            # Trend is centred on the last week of actuals, so the volumes in
            # DIM_PRODUCT.ANNUAL_UNITS_GLOBAL mean "current annual run rate"
            # rather than "level back in 2023". History therefore sits below
            # the stated figure and the horizon above it, which is what makes
            # those dimension values checkable against the real world.
            years = (i - (hist_n - 1)) / 52.0

            life = lifecycle_factor(s, week_ids, i)
            if life <= 0.0:
                if i < hist_n:
                    pos_hist.append(0.0)
                continue

            trend = (1.0 + growth) ** years * status_trend(s["LIFECYCLE_STATUS"], years)
            base = base_weekly * trend * life

            f_seas = seasonal_index(cat, w["ISO_WEEK"], cid)
            f_evt = event_index(events_map.get((ekey, wid), []))

            depth, planned = promo_weeks.get(i, (0.0, 0.0))
            eff_price = list_price * (1.0 - depth)
            # Price factor is the non-promotional price position only; the
            # promotional discount is credited to PROMO, not to PRICE, so the
            # two are not double counted.
            drift = 1.0 + 0.012 * years + rng.gauss(0, 0.002)
            f_price = drift ** elasticity
            f_promo = (1.0 + planned) if depth > 0 else 1.0

            dist *= 1.0 + rng.gauss(0.0, 0.004)
            if rng.random() < 0.003:
                # Share-of-business step: a nomination won or a part resourced
                dist *= rng.choice([0.88, 0.94, 1.06, 1.12])
            f_dist = (dist / dist_base) ** 0.45

            anom, heat, cold = weather[(mid, wid)]
            if cat["IS_WINTER_SKEW"] and cid != "CH-OE":
                f_wth = 1.0 - 0.018 * anom + (0.12 if cold else 0.0)
            else:
                f_wth = 1.0
            f_wth = max(0.6, f_wth)

            conf, fx, exc, foot = macro[(mid, wid)]
            if cid == "CH-OE":
                # Builds follow new-vehicle demand; EV programmes swing harder
                sens = 0.018 if cat["IS_EV_EXPOSED"] else 0.008
                f_mac = 1.0 + sens * (conf - 100.0)
                f_mac *= 1.0 - 0.30 * (exc - 1.0)     # tariff cuts US-bound builds
            else:
                # Replacement demand follows the miles the car parc drives
                f_mac = 1.0 + 0.006 * (foot - 100.0)
            f_mac = max(0.5, f_mac)

            inten = comp_lookup.get((mid, s["CATEGORY_ID"], wid), 0.0)
            f_cmp = 1.0 - (0.025 if cid == "CH-OE" else 0.065) * inten

            if intermittent:
                # Occurrence x size. Mean-preserving: E[f_res] = 1.
                if rng.random() >= p_occ:
                    if i < hist_n:
                        pos_hist.append(0.0)
                    continue
                f_res = math.exp(rng.gauss(-0.08, 0.40)) / p_occ
            else:
                f_res = math.exp(rng.gauss(0, 0.085 if cid == "CH-OE" else 0.12))

            # --- exact additive decomposition -----------------------
            factors = [
                ("SEASONALITY", f_seas), ("EVENT", f_evt), ("PRICE", f_price),
                ("PROMO", f_promo), ("DISTRIBUTION", f_dist), ("WEATHER", f_wth),
                ("MACRO", f_mac), ("COMPETITOR", f_cmp), ("RESIDUAL", f_res),
            ]
            contribs = [("BASE", base)]
            running = base
            for name, f in factors:
                delta = running * (f - 1.0)
                contribs.append((name, delta))
                running += delta

            units = max(0.0, running)
            if i < hist_n:
                rounded = [(n, round(v, 2)) for n, v in contribs]
                total = round(sum(v for _n, v in rounded), 2)
                if total <= 0:
                    # A negative draw is possible at very small base levels;
                    # zero it out rather than emit a negative POS row.
                    pos_hist.append(0.0)
                    continue
                # pos_hist must carry the value that is actually STORED, not
                # the unrounded intermediate, or the inventory recursion below
                # reconciles against a number that is not in the table.
                pos_hist.append(total)
                for n, v in rounded:
                    wr["drv"].writerow([sid, wid, n, v])
                price_realised = round(eff_price * rng.uniform(0.98, 1.02), 2)
                wr["pos"].writerow([
                    sid, wid, total, round(total * price_realised, 2), price_realised,
                    depth > 0, depth, int(dist),
                ])

        # --- XYZ segmentation from realised volatility --------------
        nz = [v for v in pos_hist if v > 0]
        if len(nz) >= 8:
            mean = sum(nz) / len(nz)
            var = sum((v - mean) ** 2 for v in nz) / len(nz)
            cv = math.sqrt(var) / mean if mean > 0 else 1.0
        else:
            cv = 1.0
        seg = "X" if cv < 0.25 else ("Y" if cv < 0.50 else "Z")
        wr["xyz"].writerow([sid, seg, round(cv, 4)])

        # --- shipments and inventory from a target-cover policy -----
        # Sell-in leads sell-out because the trade orders to cover forward
        # demand. This is what makes shipments peak ahead of Chinese New Year
        # without that lead being hardcoded anywhere.
        cover = TARGET_COVER[cid]
        stock = base_weekly * cover
        for i in range(hist_n):
            wid = week_ids[i]
            pos = pos_hist[i] if i < len(pos_hist) else 0.0
            fwd = pos_hist[i + 1: i + 1 + int(cover) + 1]
            expected = (sum(fwd) / len(fwd)) if fwd else pos
            target = expected * cover
            order = max(0.0, target - stock + pos)
            # Order lumpiness: the trade orders in pallet-ish multiples
            step = max(1.0, round(base_weekly * 0.25, 0))
            order = round(order / step) * step
            opening = stock
            # Where demand exceeds what is physically available the shortfall
            # is recorded as lost sales rather than clamped away, so the
            # reconciliation identity stays exact and service failure stays
            # visible.
            available = opening + order
            lost = max(0.0, pos - available)
            closing = max(0.0, available - pos)
            wr["ship"].writerow([sid, wid, round(order, 2),
                                 round(order * list_price, 2)])
            wow = round(closing / expected, 2) if expected > 0 else ""
            wr["inv"].writerow([sid, wid, round(opening, 2), round(closing, 2),
                                wow, round(lost, 2)])
            stock = closing

    for h in handles.values():
        h.close()
    return paths


COPY_TARGETS = [
    ("pos",   "CORE.FACT_POS_WEEKLY"),
    ("ship",  "CORE.FACT_SHIPMENTS_WEEKLY"),
    ("inv",   "CORE.FACT_INVENTORY_WEEKLY"),
    ("drv",   "CORE.FACT_DRIVER_CONTRIB"),
    ("wth",   "CORE.FACT_WEATHER_WEEKLY"),
    ("mac",   "CORE.FACT_MACRO_WEEKLY"),
    ("cmp",   "CORE.FACT_COMPETITOR_ACTIVITY"),
    ("promo", "CORE.FACT_PROMOTION"),
]


def load(cur, paths: dict[str, Path]) -> None:
    cur.execute("CREATE OR REPLACE STAGE CORE.LOAD_STAGE")
    cur.execute("""
        CREATE OR REPLACE FILE FORMAT CORE.CSV_GZ
          TYPE = CSV FIELD_DELIMITER = ',' COMPRESSION = GZIP
          NULL_IF = ('') EMPTY_FIELD_AS_NULL = TRUE
    """)
    for key, table in COPY_TARGETS:
        cur.execute(f"TRUNCATE TABLE {table}")
        p = paths[key].as_posix()
        cur.execute(f"PUT 'file://{p}' @CORE.LOAD_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE")
        cur.execute(f"""
            COPY INTO {table}
            FROM @CORE.LOAD_STAGE/{paths[key].name}
            FILE_FORMAT = (FORMAT_NAME = CORE.CSV_GZ)
            ON_ERROR = ABORT_STATEMENT
        """)
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        print(f"  {table}: {cur.fetchone()[0]:,} rows")

    # XYZ segmentation back onto DIM_SERIES
    p = paths["xyz"].as_posix()
    cur.execute("CREATE OR REPLACE TEMPORARY TABLE CORE.TMP_XYZ "
                "(SERIES_ID VARCHAR, SEGMENT_XYZ VARCHAR, CV NUMBER(10,4))")
    cur.execute(f"PUT 'file://{p}' @CORE.LOAD_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE")
    cur.execute(f"""
        COPY INTO CORE.TMP_XYZ FROM @CORE.LOAD_STAGE/{paths['xyz'].name}
        FILE_FORMAT = (FORMAT_NAME = CORE.CSV_GZ) ON_ERROR = ABORT_STATEMENT
    """)
    cur.execute("""
        UPDATE CORE.DIM_SERIES s SET SEGMENT_XYZ = t.SEGMENT_XYZ
        FROM CORE.TMP_XYZ t WHERE t.SERIES_ID = s.SERIES_ID
    """)
    print("  DIM_SERIES.SEGMENT_XYZ updated")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Generate CSVs and report sizes without loading")
    args = ap.parse_args()

    params = load_connection()
    params.setdefault("role", "ACCOUNTADMIN")
    conn = snowflake.connector.connect(**params)
    cur = conn.cursor()
    try:
        cur.execute("USE DATABASE VECTRON_DEMAND")
        cur.execute("USE SCHEMA CORE")
        print("Reading dimensions...")
        dims = fetch_dims(cur)
        print(f"  {len(dims['series'])} series, {len(dims['weeks'])} weeks, "
              f"{len(dims['events'])} events")

        outdir = Path(tempfile.mkdtemp(prefix="vectron_"))
        print(f"Generating into {outdir} ...")
        paths = generate(dims, outdir)
        for k, p in paths.items():
            print(f"  {k}: {p.stat().st_size / 1e6:.1f} MB")

        if args.dry_run:
            print("\nDry run: not loading.")
            return 0

        print("Loading...")
        load(cur, paths)
        conn.commit()
    finally:
        cur.close()
        conn.close()
    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
