"""Benchmark the live supply views (result cache off). Usage: python3 scripts/bench_supply.py [PLAN_SOURCE]"""
import sys
import time
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

SRC = sys.argv[1] if len(sys.argv) > 1 else "COMMITTED"
QUERIES = {
    "line_load": "SELECT COUNT(*), SUM(LOAD_UNITS) FROM VECTRON_DEMAND.APP.V_LINE_LOAD WHERE PLAN_SOURCE = %s",
    "dry_goods": "SELECT COUNT(*), SUM(PROJECTED_UNITS) FROM VECTRON_DEMAND.APP.V_DRY_GOODS_COVERAGE WHERE PLAN_SOURCE = %s",
    "net_req": "SELECT COUNT(*), SUM(NET_RECEIPT_UNITS) FROM VECTRON_DEMAND.APP.V_NET_REQUIREMENT WHERE PLAN_SOURCE = %s",
    "liquid": "SELECT COUNT(*), SUM(NEED_LPA) FROM VECTRON_DEMAND.APP.V_LIQUID_NEED WHERE PLAN_SOURCE = %s",
}

params = load_connection()
params.setdefault("role", "ACCOUNTADMIN")
conn = snowflake.connector.connect(**params)
cur = conn.cursor()
cur.execute("ALTER SESSION SET USE_CACHED_RESULT = FALSE")
for rnd in (1, 2):
    for name, sql in QUERIES.items():
        t = time.time()
        cur.execute(sql, (SRC,))
        row = cur.fetchone()
        print(f"run{rnd} {name:10s} {time.time() - t:5.2f}s {row}")
conn.close()
