#!/usr/bin/env python3
"""
Train the Cortex ML champion forecast over the full portfolio and write it
into ML.FACT_FORECAST as MODEL_NAME = 'CORTEX_ML'.

WHY THIS IS FORWARD-ONLY
------------------------
Cortex ML FORECAST costs roughly 7 seconds per series to train on this data
(185s for 25 series), so one full-portfolio run is about 90 minutes. The
lag-versioned backtest needs ~24 rolling origins, which would be over a day of
training. The backtest therefore uses VECTRON_STAT, which is fast enough to
run at every origin, and Cortex is stored for the forward horizon only as a
champion-challenger comparison.

This is a deliberate boundary, not an oversight: accuracy-by-lag and forecast
value add are computed only across models that exist at every origin, so the
comparison stays coherent.

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python scripts/train_cortex.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

HISTORY_END = "2026-W37"
HORIZON = 52


def main() -> int:
    params = load_connection()
    params.setdefault("role", "ACCOUNTADMIN")
    conn = snowflake.connector.connect(**params)
    cur = conn.cursor()
    try:
        cur.execute("USE DATABASE VECTRON_DEMAND")
        cur.execute("USE SCHEMA ML")
        cur.execute("ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 14400")

        if os.getenv("SKIP_TRAIN") == "1":
            print("SKIP_TRAIN=1: reusing the existing ML.POS_CHAMPION model.")
        else:
            print("Training CORTEX_ML over full portfolio (expect ~35 min)...")
            t0 = time.time()
            cur.execute("""
                CREATE OR REPLACE SNOWFLAKE.ML.FORECAST ML.POS_CHAMPION(
                  INPUT_DATA => TABLE(SELECT SERIES_ID, WEEK_TS, UNITS FROM ML.V_TRAIN_POS),
                  SERIES_COLNAME => 'SERIES_ID',
                  TIMESTAMP_COLNAME => 'WEEK_TS',
                  TARGET_COLNAME => 'UNITS'
                )
            """)
            print(f"  trained in {time.time() - t0:.0f}s")

        print("Forecasting...")
        t1 = time.time()
        # Run the CALL and then capture its output in a separate statement.
        # RESULT_SCAN(LAST_QUERY_ID()) works across statements on the same
        # session; wrapping both in a scripting block does not, because
        # LAST_QUERY_ID() inside the block does not refer to the CALL.
        cur.execute(f"CALL ML.POS_CHAMPION!FORECAST(FORECASTING_PERIODS => {HORIZON})")
        cur.execute(
            "CREATE OR REPLACE TABLE ML.CORTEX_RAW AS "
            "SELECT * FROM TABLE(RESULT_SCAN(LAST_QUERY_ID(-1)))"
        )
        print(f"  forecast in {time.time() - t1:.0f}s")

        # Cortex returns SERIES as a JSON string, so it arrives double-quoted.
        cur.execute("""
            DELETE FROM ML.FACT_FORECAST WHERE MODEL_NAME = 'CORTEX_ML'
        """)
        cur.execute(f"""
            INSERT INTO ML.FACT_FORECAST
              (SERIES_ID, TARGET_WEEK_ID, MADE_WEEK_ID, LAG_WEEKS, MODEL_NAME,
               FORECAST_UNITS, LOWER_95, UPPER_95)
            SELECT
              TRIM(r.SERIES, '"')                              AS SERIES_ID,
              w.WEEK_ID                                        AS TARGET_WEEK_ID,
              '{HISTORY_END}'                                  AS MADE_WEEK_ID,
              DATEDIFF(week, o.WEEK_START_DATE, w.WEEK_START_DATE) AS LAG_WEEKS,
              'CORTEX_ML'                                      AS MODEL_NAME,
              GREATEST(0, r.FORECAST)                          AS FORECAST_UNITS,
              GREATEST(0, r.LOWER_BOUND)                       AS LOWER_95,
              GREATEST(0, r.UPPER_BOUND)                       AS UPPER_95
            FROM ML.CORTEX_RAW r
            JOIN CORE.DIM_WEEK w ON TO_TIMESTAMP_NTZ(w.WEEK_START_DATE) = r.TS
            CROSS JOIN (SELECT WEEK_START_DATE FROM CORE.DIM_WEEK
                        WHERE WEEK_ID = '{HISTORY_END}') o
            WHERE TRIM(r.SERIES, '"') IN (SELECT SERIES_ID FROM CORE.DIM_SERIES)
        """)
        cur.execute("SELECT COUNT(*) FROM ML.FACT_FORECAST WHERE MODEL_NAME='CORTEX_ML'")
        print(f"  CORTEX_ML rows: {cur.fetchone()[0]:,}")
        conn.commit()
    finally:
        cur.close()
        conn.close()
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
