"""Time the supply reads the plan grid makes, and the bare matrix route.
Usage: python3 scripts/profile_grid.py"""
import sys
import time
import urllib.request
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

A = "VECTRON_DEMAND.APP."
QUERIES = {
    "solve_status": f"SELECT IS_STALE FROM {A}V_SUPPLY_SOLVE_STATUS WHERE PLAN_SOURCE = 'COMMITTED'",
    "alloc_weeks": f"SELECT RECEIPT_WEEK_ID, SUM(ON_TIME_UNITS) FROM {A}V_SUPPLY_ALLOCATION "
                   "WHERE PLAN_SOURCE = 'COMMITTED' GROUP BY 1",
}

params = load_connection()
params.setdefault("role", "ACCOUNTADMIN")
conn = snowflake.connector.connect(**params)
cur = conn.cursor()
cur.execute("ALTER SESSION SET USE_CACHED_RESULT = FALSE")
for name, sql in QUERIES.items():
    t = time.time()
    cur.execute(sql)
    cur.fetchall()
    print(f"{name:13s} {time.time() - t:5.2f}s")
conn.close()

for url in ["http://localhost:3003/api/plan-grid?rollup=quarter",
            "http://localhost:3003/api/supply"]:
    t = time.time()
    urllib.request.urlopen(url, timeout=120).read()
    print(f"{url.split('/api/')[1]:22s} {time.time() - t:5.2f}s")
