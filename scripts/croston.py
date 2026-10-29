#!/usr/bin/env python3
"""
Intermittent-demand forecasts for Vectron service parts: Croston and SBA.

Service (OES) and aftermarket (IAM) demand for low-runner part families is
intermittent: most weeks nothing, then an order. A seasonal-level model like
VECTRON_STAT forecasts a small positive number every week, which is fine on
average but wrong in shape, and its errors are judged with WAPE/MAPE that
break on zero weeks.

This script:
  1. Classifies every series by ADI (average inter-demand interval) and CV^2
     of non-zero sizes, using the Syntetos-Boylan cut-offs (ADI 1.32, CV^2
     0.49): smooth / erratic / intermittent / lumpy. Written to
     ML.SERIES_DEMAND_CLASS on the 104 weeks before the first backtest origin,
     so the class is not fitted on the weeks it is scored on.
  2. For intermittent and lumpy series, runs Croston (1972) and the
     Syntetos-Boylan Approximation (SBA, Croston x (1 - alpha/2)), alpha 0.1,
     over the same rolling origins and lags 1..8 that forecast.py uses, and a
     52-week forward forecast from HISTORY_END. Written to ML.FACT_FORECAST
     under MODEL_NAME 'CROSTON' and 'SBA'; rows for other models are untouched.

Intervals: Croston gives a rate, not a distribution. UPPER_95 is the 95th
percentile of the series' own weekly demand over the fitting window, LOWER_95
is 0. Simple and honest; the page says so.

Run after forecast.py. Scored by snowflake/07c-service.sql (MASE).

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/croston.py
"""
from __future__ import annotations

import csv
import gzip
import sys
import tempfile
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

HISTORY_END = "2026-W37"
BACKTEST_ORIGINS_FROM = "2026-W05"   # must match forecast.py
MAX_LAG = 8
FORWARD_HORIZON = 52
ALPHA = 0.1
CLASS_WINDOW = 104
ADI_CUT = 1.32
CV2_CUT = 0.49
MODELS = ("CROSTON", "SBA")


def classify(xs: list[float]) -> tuple[float | None, float | None, str]:
    nz = [x for x in xs if x > 0]
    if len(nz) < 2:
        return None, None, "insufficient"
    adi = len(xs) / len(nz)
    mean = sum(nz) / len(nz)
    var = sum((x - mean) ** 2 for x in nz) / len(nz)
    cv2 = var / (mean * mean)
    if adi < ADI_CUT:
        cls = "smooth" if cv2 < CV2_CUT else "erratic"
    else:
        cls = "intermittent" if cv2 < CV2_CUT else "lumpy"
    return adi, cv2, cls


def croston_rate(xs: list[float]) -> float | None:
    """Croston demand rate per period after observing xs (oldest first)."""
    z = p = None
    q = 1          # periods since last demand, including the current one
    for x in xs:
        if x > 0:
            if z is None:
                z, p = x, float(q)
            else:
                z = z + ALPHA * (x - z)
                p = p + ALPHA * (q - p)
            q = 1
        else:
            q += 1
    return None if z is None else z / p


def p95(xs: list[float]) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, int(0.95 * len(s)))] if s else 0.0


def main() -> int:
    conn = snowflake.connector.connect(**load_connection())
    cur = conn.cursor()
    try:
        cur.execute("USE DATABASE VECTRON_DEMAND")
        cur.execute("SELECT WEEK_ID FROM CORE.DIM_WEEK ORDER BY WEEK_START_DATE")
        week_ids = [r[0] for r in cur.fetchall()]
        idx = {w: i for i, w in enumerate(week_ids)}
        hist_i = idx[HISTORY_END]
        first_o = idx[BACKTEST_ORIGINS_FROM]

        cur.execute("SELECT SERIES_ID, CHANNEL_ID FROM CORE.DIM_SERIES")
        channel = dict(cur.fetchall())
        vals = {sid: [0.0] * (hist_i + 1) for sid in channel}
        cur.execute("SELECT SERIES_ID, WEEK_ID, UNITS FROM CORE.FACT_POS_WEEKLY")
        for sid, wid, u in cur:
            if sid in vals and wid in idx and idx[wid] <= hist_i:
                vals[sid][idx[wid]] = float(u)

        class_rows, targets = [], []
        lo = max(0, first_o - CLASS_WINDOW)
        for sid, v in vals.items():
            adi, cv2, cls = classify(v[lo:first_o])
            class_rows.append([sid, adi, cv2, cls, week_ids[lo], week_ids[first_o - 1]])
            # Service and aftermarket only: an OE series with zero weeks is a
            # shutdown or a launch, not intermittent demand.
            if cls in ("intermittent", "lumpy") and channel[sid] != "CH-OE":
                targets.append(sid)
        print(f"  classified {len(class_rows)} series; {len(targets)} intermittent or lumpy")

        out = Path(tempfile.mkdtemp(prefix="vectron_croston_")) / "fc.csv.gz"
        n = 0
        with gzip.open(out, "wt", newline="") as fh:
            wr = csv.writer(fh)
            for sid in targets:
                v = vals[sid]
                origins = list(range(first_o, hist_i + 1))
                for oi in origins:
                    rate = croston_rate(v[: oi + 1])
                    if rate is None:
                        continue
                    hi = p95(v[max(0, oi + 1 - CLASS_WINDOW): oi + 1])
                    # Backtest lags, plus the full forward horizon from the last origin.
                    last = FORWARD_HORIZON if oi == hist_i else MAX_LAG
                    for h in range(1, last + 1):
                        ti = oi + h
                        if ti >= len(week_ids):
                            break
                        if oi < hist_i and ti > hist_i:
                            break
                        for model, f in (("CROSTON", rate), ("SBA", rate * (1 - ALPHA / 2))):
                            wr.writerow([sid, week_ids[ti], week_ids[oi], h, model,
                                         round(f, 4), 0, round(max(hi, f), 4)])
                            n += 1
        print(f"  {n:,} forecast rows")

        cur.execute("""CREATE OR REPLACE TABLE ML.SERIES_DEMAND_CLASS (
                         SERIES_ID      VARCHAR(80) PRIMARY KEY,
                         ADI            FLOAT,
                         CV2            FLOAT,
                         DEMAND_CLASS   VARCHAR(20) NOT NULL,
                         WINDOW_FROM    VARCHAR(10) NOT NULL,
                         WINDOW_TO      VARCHAR(10) NOT NULL)""")
        cur.executemany("INSERT INTO ML.SERIES_DEMAND_CLASS VALUES (%s, %s, %s, %s, %s, %s)", class_rows)

        cur.execute("CREATE STAGE IF NOT EXISTS CORE.LOAD_STAGE")
        cur.execute("""CREATE FILE FORMAT IF NOT EXISTS CORE.CSV_GZ TYPE = CSV
                       FIELD_DELIMITER = ',' COMPRESSION = GZIP NULL_IF = ('')""")
        cur.execute("DELETE FROM ML.FACT_FORECAST WHERE MODEL_NAME IN ('CROSTON', 'SBA')")
        cur.execute(f"PUT 'file://{out.as_posix()}' @CORE.LOAD_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE")
        cur.execute(f"""COPY INTO ML.FACT_FORECAST
                          (SERIES_ID, TARGET_WEEK_ID, MADE_WEEK_ID, LAG_WEEKS, MODEL_NAME,
                           FORECAST_UNITS, LOWER_95, UPPER_95)
                        FROM @CORE.LOAD_STAGE/{out.name}
                        FILE_FORMAT = (FORMAT_NAME = CORE.CSV_GZ) ON_ERROR = ABORT_STATEMENT""")
        cur.execute("SELECT MODEL_NAME, COUNT(*) FROM ML.FACT_FORECAST GROUP BY 1 ORDER BY 1")
        for m, c in cur.fetchall():
            print(f"  ML.FACT_FORECAST {m}: {c:,}")
        conn.commit()
    finally:
        cur.close()
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
