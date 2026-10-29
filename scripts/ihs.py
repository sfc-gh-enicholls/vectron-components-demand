#!/usr/bin/env python3
"""
Generate a SYNTHETIC IHS-style light-vehicle production forecast for Vectron.

A Tier 1 does not only plan from what its customers call off. It also asks:
how many vehicles will the OEM build, on which platforms, and how many of our
parts go into each one? S&P Global Mobility (IHS Markit) sells that view as a
monthly light-vehicle production forecast, republished every month. Each
publication is a VINTAGE: the actuals to date plus a forecast out to 2032.

This script writes a stand-in for that feed so the outside-in signal can be
built and demonstrated. It is NOT S&P data and every surface says so. The
schema is shaped so a real share can replace it: the app reads only
APP.V_LV_PRODUCTION, which points at EXT_IHS.LV_PRODUCTION today and can be
repointed at a licensed share without touching anything downstream.

Tables written:
    EXT_IHS.DIM_PLATFORM         platform, OEM, powertrain, lifecycle
    EXT_IHS.LV_PRODUCTION        vintage x platform x month, vehicles
    CORE.CONTENT_PER_VEHICLE     pieces of each part family per vehicle
    CORE.PLATFORM_AWARD          which platforms each OE series is nominated on

How the numbers hang together:
  * History follows the shape of each OEM's real OE pull in FACT_POS_WEEKLY
    (chassis, brake and steering parts, which fit every platform), so
    shutdown months, the 2024 sentiment dip and growth all line up. The
    installation rate a Tier 1 would calibrate is therefore stable.
  * Forward, ICE platforms erode slowly and some reach end of production;
    BEV platforms grow. Successive vintages REVISE BEV volumes down: the
    September 2025 vintage was ~18% more optimistic about 2027 BEV builds
    than the September 2026 one. That is the vintage walk the page shows.
  * Stellantis and Ford are revised down a further step in the 2026
    vintages. Those are the OEMs whose call-offs run hottest, so IHS and the
    call-off bias tell the planner the same thing from two directions.

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/ihs.py
"""
from __future__ import annotations

import csv
import gzip
import random
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

SEED = 1447
FIRST_MONTH = (2023, 1)
LAST_MONTH = (2032, 12)
LAST_ACTUAL = (2026, 8)            # history ends 2026-W37, so August is the last whole month
VINTAGES = [(2025, m) for m in range(9, 13)] + [(2026, m) for m in range(1, 10)]

# European light-vehicle builds a year, by OEM, at 2026 run-rate. ILLUSTRATIVE.
OEM_BUILD = {
    "OEM-BMW": 2_000_000, "OEM-VW": 3_200_000, "OEM-AUDI": 1_400_000, "OEM-POR": 250_000,
    "OEM-MB": 1_800_000, "OEM-STLA": 2_600_000, "OEM-REN": 1_600_000, "OEM-FORD": 1_000_000,
}
SHORT = {
    "OEM-BMW": "BMW", "OEM-VW": "VW", "OEM-AUDI": "Audi", "OEM-POR": "Porsche",
    "OEM-MB": "Mercedes", "OEM-STLA": "Stellantis", "OEM-REN": "Renault", "OEM-FORD": "Ford",
}
# Three fictional platforms per OEM: (suffix, label, powertrain, 2026 share, EOP or None)
PLATFORMS = [
    ("A", "compact", "ICE", 0.45, (2029, 12)),
    ("B", "mid-size SUV", "ICE", 0.37, None),
    ("E", "dedicated BEV", "BEV", 0.18, None),
]
# BEV share of build drifts up each year (latest view), ICE erodes.
BEV_GROWTH = 0.11
ICE_EROSION = -0.025
# How much more optimistic the oldest vintage was about future BEV builds.
BEV_VINTAGE_OPTIMISM = 0.18
# Extra 2026-vintage cut for the hottest-calling OEMs.
OEM_LATE_CUT = {"OEM-STLA": 0.07, "OEM-FORD": 0.05}

# Pieces per vehicle, and which powertrains each part fits.
CPV = {
    "P-PAD": (2, "ALL"), "P-CALFL": (2, "ALL"), "P-CALFX": (2, "ALL"), "P-DISCV": (4, "ALL"),
    "P-DISCC": (4, "ALL"), "P-EPB": (2, "ALL"), "P-ABS": (1, "ALL"), "P-IBS": (1, "ALL"),
    "P-CTRL": (4, "ALL"), "P-DAMP": (4, "ALL"), "P-DAMPA": (4, "ALL"), "P-AIRS": (4, "ALL"),
    "P-KNUCK": (2, "ALL"), "P-SUBF": (1, "ALL"), "P-STAB": (2, "ALL"), "P-WHUB": (4, "ALL"),
    "P-EPSC": (1, "ALL"), "P-EPSR": (1, "ALL"), "P-SBW": (1, "ALL"), "P-TIER": (2, "ALL"),
    "P-HSHAFT": (2, "ALL"), "P-DIFF": (1, "ICE"), "P-DCT": (1, "ICE"), "P-TH8": (1, "ICE"),
    "P-DMF": (1, "ICE"), "P-DMFD": (1, "ICE"), "P-ENGM": (3, "ICE"), "P-EAXLE": (1, "BEV"),
    "P-EAX2": (1, "BEV"), "P-BTRAY": (1, "BEV"), "P-INVH": (1, "BEV"), "P-RGB": (1, "BEV"),
    "P-ROTOR": (1, "BEV"),
}


def months(a: tuple[int, int], b: tuple[int, int]) -> list[tuple[int, int]]:
    out, (y, m) = [], a
    while (y, m) <= b:
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def mkey(ym: tuple[int, int]) -> str:
    return f"{ym[0]:04d}-{ym[1]:02d}"


def load_csv(cur, rows: list[list], table: str, name: str) -> None:
    out = Path(tempfile.mkdtemp(prefix="vectron_ihs_")) / f"{name}.csv.gz"
    with gzip.open(out, "wt", newline="") as fh:
        csv.writer(fh).writerows(rows)
    cur.execute(f"PUT 'file://{out.as_posix()}' @CORE.LOAD_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE")
    cur.execute(f"""COPY INTO {table} FROM @CORE.LOAD_STAGE/{out.name}
                    FILE_FORMAT = (FORMAT_NAME = CORE.CSV_GZ) ON_ERROR = ABORT_STATEMENT""")


def main() -> int:
    rng = random.Random(SEED)
    conn = snowflake.connector.connect(**load_connection())
    cur = conn.cursor()
    try:
        cur.execute("USE DATABASE VECTRON_DEMAND")
        cur.execute("USE SCHEMA CORE")
        cur.execute("CREATE STAGE IF NOT EXISTS CORE.LOAD_STAGE")
        cur.execute("""CREATE FILE FORMAT IF NOT EXISTS CORE.CSV_GZ TYPE = CSV
                       FIELD_DELIMITER = ',' COMPRESSION = GZIP NULL_IF = ('')""")

        # Shape of each OEM's build: OE pull of parts that fit every platform.
        # Weeks are spread over their seven days, so a month gets its share of
        # a week that straddles it (no four-or-five-week months).
        cur.execute("""WITH days AS (SELECT SEQ4() AS d FROM TABLE(GENERATOR(ROWCOUNT => 7)))
                       SELECT s.CUSTOMER_ID, YEAR(DATEADD(day, days.d, w.WEEK_START_DATE)),
                              MONTH(DATEADD(day, days.d, w.WEEK_START_DATE)), SUM(p.UNITS) / 7
                       FROM FACT_POS_WEEKLY p
                       JOIN DIM_SERIES s USING (SERIES_ID)
                       JOIN DIM_PRODUCT d ON d.PRODUCT_ID = s.PRODUCT_ID
                       JOIN DIM_WEEK w ON w.WEEK_ID = p.WEEK_ID
                       CROSS JOIN days
                       WHERE s.CHANNEL_ID = 'CH-OE'
                         AND d.CATEGORY_ID IN ('CAT-BRAKE','CAT-CHASSIS','CAT-STEER')
                       GROUP BY 1, 2, 3""")
        pull: dict[str, dict[tuple[int, int], float]] = defaultdict(dict)
        for cust, y, m, u in cur:
            pull[cust][(int(y), int(m))] = float(u)

        hist = months(FIRST_MONTH, LAST_ACTUAL)
        fut = months((LAST_ACTUAL[0], LAST_ACTUAL[1] + 1), LAST_MONTH)
        all_m = hist + fut

        platform_rows, prod_rows = [], []
        for cust, annual in OEM_BUILD.items():
            p = pull[cust]
            last12 = hist[-12:]
            mean12 = sum(p.get(m, 0.0) for m in last12) / 12
            # Month-of-year seasonality from the last two years (shutdown August etc.).
            seas = {}
            for mo in range(1, 13):
                vals = [p[(y, mo)] / mean12 for y in (2024, 2025) if (y, mo) in p]
                seas[mo] = sum(vals) / len(vals) if vals else 1.0
            norm = sum(seas.values()) / 12
            seas = {k: v / norm for k, v in seas.items()}

            for suffix, label, pt, share26, eop in PLATFORMS:
                pid = f"{cust.split('-')[1]}-{suffix}"
                name = f"{SHORT[cust]} {suffix} ({label})"
                sop = (2023, 1) if pt == "ICE" else (2023, 3)
                platform_rows.append([pid, name, cust, pt, mkey(sop), mkey(eop) if eop else None])
                # BEV share in history ramps toward 2026 level.
                actual: dict[tuple[int, int], float] = {}
                for ym in hist:
                    yrs = (ym[0] + (ym[1] - 1) / 12) - 2026.0
                    tilt = (1 + BEV_GROWTH) ** yrs if pt == "BEV" else (1 + ICE_EROSION) ** yrs
                    v = annual * share26 / 12 * (p.get(ym, 0.0) / mean12) * tilt
                    actual[ym] = max(0.0, v * (1 + rng.gauss(0, 0.015)))
                for vy, vm in VINTAGES:
                    v_last = (vy - 1, 12) if vm == 1 else (vy, vm - 1)
                    v_last = min(v_last, LAST_ACTUAL)
                    # 0 for the oldest vintage, 1 for the latest.
                    age = (VINTAGES.index((vy, vm))) / (len(VINTAGES) - 1)
                    i_last = hist.index(v_last)
                    window = hist[i_last - 11:i_last + 1]
                    # A full trailing year: seasonality (and a shutdown that
                    # moves between July and August) cancels out.
                    base = sum(actual[m] for m in window) / 12
                    for ym in all_m:
                        if ym <= v_last:
                            prod_rows.append([mkey((vy, vm)), pid, mkey(ym), True, round(actual[ym])])
                            continue
                        yrs = (ym[0] + (ym[1] - 1) / 12) - (v_last[0] + (v_last[1] - 1) / 12)
                        if pt == "BEV":
                            optimism = BEV_VINTAGE_OPTIMISM * (1 - age) * min(1.0, yrs / 1.5)
                            # The BEV successor picks up 60% of the A platform's
                            # volume as it ends, ramped over the year around EOP.
                            ramp = max(0.0, min(1.0, (ym[0] + (ym[1] - 1) / 12) - 2029.5))
                            succession = 0.6 * PLATFORMS[0][3] / PLATFORMS[2][3] * ramp
                            level = base * (1 + BEV_GROWTH) ** yrs * (1 + optimism) * (1 + succession)
                        else:
                            level = base * (1 + ICE_EROSION) ** yrs
                            if eop and ym > eop:
                                level = 0.0
                            elif eop:
                                to_eop = (eop[0] - ym[0]) * 12 + (eop[1] - ym[1])
                                if to_eop < 6:
                                    level *= (to_eop + 1) / 7
                        if cust in OEM_LATE_CUT and vy == 2026:
                            level *= 1 - OEM_LATE_CUT[cust] * min(1.0, yrs / 0.75)
                        prod_rows.append([mkey((vy, vm)), pid, mkey(ym), False,
                                          round(max(0.0, level * seas[ym[1]]))])

        cur.execute("""CREATE OR REPLACE TABLE EXT_IHS.DIM_PLATFORM (
                         PLATFORM_ID   VARCHAR(20) PRIMARY KEY,
                         PLATFORM_NAME VARCHAR(80) NOT NULL,
                         CUSTOMER_ID   VARCHAR(20) NOT NULL,
                         POWERTRAIN    VARCHAR(10) NOT NULL,
                         SOP_MONTH     VARCHAR(7)  NOT NULL,
                         EOP_MONTH     VARCHAR(7))""")
        cur.execute("""CREATE OR REPLACE TABLE EXT_IHS.LV_PRODUCTION (
                         VINTAGE_MONTH VARCHAR(7)  NOT NULL,
                         PLATFORM_ID   VARCHAR(20) NOT NULL,
                         PROD_MONTH    VARCHAR(7)  NOT NULL,
                         IS_ACTUAL     BOOLEAN     NOT NULL,
                         VEHICLES      NUMBER(12,0) NOT NULL,
                         PRIMARY KEY (VINTAGE_MONTH, PLATFORM_ID, PROD_MONTH))""")
        cur.execute("COMMENT ON TABLE EXT_IHS.LV_PRODUCTION IS 'SYNTHETIC stand-in for an S&P Global "
                    "Mobility light-vehicle production forecast. Monthly vintages, actuals plus forecast "
                    "to 2032. Not S&P data. Replace by repointing APP.V_LV_PRODUCTION at a licensed share.'")
        load_csv(cur, platform_rows, "EXT_IHS.DIM_PLATFORM", "platform")
        load_csv(cur, prod_rows, "EXT_IHS.LV_PRODUCTION", "lv_production")

        cur.execute("""CREATE OR REPLACE TABLE CORE.CONTENT_PER_VEHICLE (
                         PRODUCT_ID         VARCHAR(20) PRIMARY KEY,
                         PIECES_PER_VEHICLE NUMBER(4,0) NOT NULL,
                         FITS_POWERTRAIN    VARCHAR(10) NOT NULL)""")
        cur.executemany("INSERT INTO CORE.CONTENT_PER_VEHICLE VALUES (%s, %s, %s)",
                        [(k, n, f) for k, (n, f) in CPV.items()])

        # Nomination: each OE series is awarded on most of the fitting
        # platforms of its OEM. At least one award per series.
        cur.execute("SELECT SERIES_ID, CUSTOMER_ID, PRODUCT_ID FROM DIM_SERIES WHERE CHANNEL_ID = 'CH-OE'")
        awards = []
        for sid, cust, prod in cur.fetchall():
            fits = CPV[prod][1]
            cands = [f"{cust.split('-')[1]}-{s}" for s, _, pt, _, _ in PLATFORMS
                     if fits == "ALL" or fits == pt]
            chosen = [c for c in cands if rng.random() < 0.8] or [rng.choice(cands)]
            awards += [(sid, c) for c in chosen]
        cur.execute("""CREATE OR REPLACE TABLE CORE.PLATFORM_AWARD (
                         SERIES_ID   VARCHAR(80) NOT NULL,
                         PLATFORM_ID VARCHAR(20) NOT NULL,
                         PRIMARY KEY (SERIES_ID, PLATFORM_ID))""")
        cur.executemany("INSERT INTO CORE.PLATFORM_AWARD VALUES (%s, %s)", awards)

        for t in ("EXT_IHS.DIM_PLATFORM", "EXT_IHS.LV_PRODUCTION", "CORE.CONTENT_PER_VEHICLE",
                  "CORE.PLATFORM_AWARD"):
            cur.execute(f"SELECT COUNT(*) FROM {t}")
            print(f"  {t}: {cur.fetchone()[0]:,} rows")
        conn.commit()
    finally:
        cur.close()
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
