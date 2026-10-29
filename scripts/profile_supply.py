"""Time each layer of the live supply views (result cache off).
Usage: python3 scripts/profile_supply.py [PLAN_SOURCE]"""
import sys
import time
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

SRC = sys.argv[1] if len(sys.argv) > 1 else "COMMITTED"
A = "VECTRON_DEMAND.APP."
QUERIES = {
    "demand_src": f"SELECT COUNT(*), SUM(UNITS) FROM {A}V_SUPPLY_DEMAND_SOURCE WHERE PLAN_SOURCE = %s",
    "sku_demand": f"SELECT COUNT(*), SUM(DEMAND_UNITS) FROM {A}V_SKU_DEMAND WHERE PLAN_SOURCE = %s",
    "opening": f"SELECT COUNT(*), SUM(OPENING_UNITS) FROM {A}V_SKU_OPENING_STOCK WHERE %s IS NOT NULL",
    "pipeline": f"SELECT COUNT(*), SUM(SCHEDULED_UNITS) FROM {A}V_SKU_PIPELINE WHERE %s IS NOT NULL",
    "net_req": f"SELECT COUNT(*), SUM(NET_RECEIPT_UNITS) FROM {A}V_NET_REQUIREMENT WHERE PLAN_SOURCE = %s",
    "orders": f"SELECT COUNT(*), SUM(ORDER_UNITS) FROM {A}V_PLANNED_ORDERS WHERE PLAN_SOURCE = %s",
    "dry_need": f"SELECT COUNT(*), SUM(NEED_UNITS) FROM {A}V_DRY_GOODS_NEED WHERE PLAN_SOURCE = %s",
    "dry_cov": f"SELECT COUNT(*), SUM(PROJECTED_UNITS) FROM {A}V_DRY_GOODS_COVERAGE WHERE PLAN_SOURCE = %s",
    "alloc": f"SELECT COUNT(*) FROM {A}V_SUPPLY_ALLOCATION WHERE PLAN_SOURCE = %s",
    "fill": f"SELECT COUNT(*) FROM {A}V_LIQUID_FILL_RATIO WHERE %s IS NOT NULL",
}

params = load_connection()
params.setdefault("role", "ACCOUNTADMIN")
conn = snowflake.connector.connect(**params)
cur = conn.cursor()
cur.execute("ALTER SESSION SET USE_CACHED_RESULT = FALSE")
for name, sql in QUERIES.items():
    best = 99.0
    for _ in range(2):
        t = time.time()
        cur.execute(sql, (SRC,))
        cur.fetchone()
        best = min(best, time.time() - t)
    print(f"{name:11s} {best:5.2f}s")
conn.close()
