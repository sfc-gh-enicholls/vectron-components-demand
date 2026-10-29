#!/usr/bin/env python3
"""
Generate the OEM EDI call-off history for Vectron (FACT_EDI_RELEASE).

Every week each OEM sends a delivery schedule (VDA 4905 / DELFOR style) for
the next 12 weeks of series production. A schedule has three zones:

    FIRM      weeks 0-2   production is committed; Vectron must deliver
    TRADE     weeks 3-8   material authorisation; quantities still move
    FORECAST  weeks 9-12  the OEM's planning view; least reliable

The pattern this encodes is the one every Tier 1 lives with: firm-zone
quantities land close to what is eventually pulled, but further out the OEM's
build plan is noisy AND optimistic, by an amount that differs by OEM. Plant
shutdowns are known to the OEM (it is their calendar), so they appear in every
release; what moves is volume.

SYNTHETIC. Bias and noise levels are illustrative and are not measurements of
any named OEM. Every surface that shows them says so.

Truth for history weeks is the realised OE pull (FACT_POS_WEEKLY). For weeks
beyond HISTORY_END it is the statistical plan, so the latest releases cover
the forward horizon without inventing a second demand model.

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/calloffs.py
"""
from __future__ import annotations

import csv
import gzip
import random
import sys
import tempfile
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

SEED = 4905
HISTORY_END = "2026-W37"
FIRST_RELEASE = "2025-W38"      # 52 weekly releases up to HISTORY_END
HORIZON = 12

# Optimism at the far end of the horizon (week 12), by OEM. Ramps linearly
# from zero at the end of the firm zone. ILLUSTRATIVE.
FAR_BIAS = {
    "OEM-BMW": 0.04, "OEM-VW": 0.09, "OEM-AUDI": 0.06, "OEM-POR": 0.03,
    "OEM-MB": 0.05, "OEM-STLA": 0.15, "OEM-REN": 0.07, "OEM-FORD": 0.12,
}
# Noise sd by zone, scaled per OEM by how disciplined its scheduling is.
ZONE_SD = {"FIRM": 0.025, "TRADE": 0.09, "FORECAST": 0.19}
OEM_NOISE = {
    "OEM-BMW": 0.85, "OEM-VW": 1.10, "OEM-AUDI": 1.00, "OEM-POR": 0.80,
    "OEM-MB": 0.90, "OEM-STLA": 1.35, "OEM-REN": 1.05, "OEM-FORD": 1.20,
}


def zone_of(h: int) -> str:
    return "FIRM" if h <= 2 else ("TRADE" if h <= 8 else "FORECAST")


def main() -> int:
    rng = random.Random(SEED)
    conn = snowflake.connector.connect(**load_connection())
    cur = conn.cursor()
    try:
        cur.execute("USE DATABASE VECTRON_DEMAND")
        cur.execute("USE SCHEMA CORE")
        cur.execute("SELECT WEEK_ID FROM DIM_WEEK ORDER BY WEEK_START_DATE")
        week_ids = [r[0] for r in cur.fetchall()]
        pos = {w: i for i, w in enumerate(week_ids)}
        hist_i = pos[HISTORY_END]

        cur.execute("SELECT SERIES_ID, CUSTOMER_ID FROM DIM_SERIES WHERE CHANNEL_ID = 'CH-OE' ORDER BY 1")
        series = cur.fetchall()

        truth: dict[tuple[str, int], float] = {}
        cur.execute("""SELECT p.SERIES_ID, p.WEEK_ID, p.UNITS FROM FACT_POS_WEEKLY p
                       JOIN DIM_SERIES s USING (SERIES_ID) WHERE s.CHANNEL_ID = 'CH-OE'""")
        for sid, wid, u in cur:
            truth[(sid, pos[wid])] = float(u)
        cur.execute("""SELECT d.SERIES_ID, d.WEEK_ID, d.STAT_UNITS FROM FACT_DEMAND_PLAN d
                       JOIN DIM_SERIES s USING (SERIES_ID) WHERE s.CHANNEL_ID = 'CH-OE'""")
        for sid, wid, u in cur:
            if wid in pos and pos[wid] > hist_i:
                truth[(sid, pos[wid])] = float(u)

        out = Path(tempfile.mkdtemp(prefix="vectron_calloff_")) / "edi.csv.gz"
        n = 0
        with gzip.open(out, "wt", newline="") as fh:
            wr = csv.writer(fh)
            for sid, cust in series:
                # A persistent per-series schedule error: some programmes are
                # chronically over-called, not just noisy week to week.
                series_tilt = rng.gauss(0, 0.03)
                for r in range(pos[FIRST_RELEASE], hist_i + 1):
                    # Week-level shock shared across the horizon of one release:
                    # a release that is high at week 5 tends to be high at 6.
                    release_shock = rng.gauss(0, 1)
                    for h in range(HORIZON + 1):
                        t = r + h
                        if t >= len(week_ids):
                            break
                        actual = truth.get((sid, t), 0.0)
                        z = zone_of(h)
                        ramp = max(0.0, (h - 2) / (HORIZON - 2))
                        bias = FAR_BIAS[cust] * ramp + series_tilt * ramp
                        sd = ZONE_SD[z] * OEM_NOISE[cust]
                        err = sd * (0.6 * release_shock + 0.8 * rng.gauss(0, 1))
                        qty = max(0.0, actual * (1.0 + bias + err))
                        # Firm zone is called in whole delivery lots (racks).
                        if z == "FIRM" and qty > 0:
                            lot = max(1.0, round(actual * 0.02))
                            qty = round(qty / lot) * lot
                        wr.writerow([sid, week_ids[r], week_ids[t], h, z, round(qty, 2)])
                        n += 1
        print(f"  {n:,} release lines for {len(series)} OE series")

        cur.execute("""CREATE OR REPLACE TABLE FACT_EDI_RELEASE (
                         SERIES_ID       VARCHAR(80) NOT NULL,
                         RELEASE_WEEK_ID VARCHAR(10) NOT NULL,
                         TARGET_WEEK_ID  VARCHAR(10) NOT NULL,
                         HORIZON_WEEKS   NUMBER(3,0) NOT NULL,
                         ZONE            VARCHAR(10) NOT NULL,
                         RELEASE_UNITS   NUMBER(14,2) NOT NULL,
                         PRIMARY KEY (SERIES_ID, RELEASE_WEEK_ID, TARGET_WEEK_ID))""")
        cur.execute("COMMENT ON TABLE FACT_EDI_RELEASE IS "
                    "'SYNTHETIC OEM delivery schedules (DELFOR-style), one per OE series per week, 12-week horizon. Bias and noise are illustrative.'")
        cur.execute("CREATE OR REPLACE STAGE CORE.LOAD_STAGE")
        cur.execute("""CREATE OR REPLACE FILE FORMAT CORE.CSV_GZ TYPE = CSV
                       FIELD_DELIMITER = ',' COMPRESSION = GZIP NULL_IF = ('')""")
        cur.execute(f"PUT 'file://{out.as_posix()}' @CORE.LOAD_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE")
        cur.execute(f"""COPY INTO FACT_EDI_RELEASE FROM @CORE.LOAD_STAGE/{out.name}
                        FILE_FORMAT = (FORMAT_NAME = CORE.CSV_GZ) ON_ERROR = ABORT_STATEMENT""")
        cur.execute("SELECT COUNT(*) FROM FACT_EDI_RELEASE")
        print(f"  CORE.FACT_EDI_RELEASE: {cur.fetchone()[0]:,} rows")
        conn.commit()
    finally:
        cur.close()
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
