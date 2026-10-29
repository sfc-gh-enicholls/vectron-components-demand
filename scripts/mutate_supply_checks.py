"""
Mutation test for the supply integrity checks: corrupt one row inside a
transaction, confirm the intended check catches it, then ROLL BACK. Nothing is
committed. Usage: SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/mutate_supply_checks.py
"""
import sys
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

MUTATIONS = [
    ("supply_order_mass_balance",
     """UPDATE CORE.FACT_SUPPLY_PLAN SET ON_TIME_UNITS = ON_TIME_UNITS + 10
        WHERE RUN_ID = (SELECT RUN_ID FROM CORE.FACT_SUPPLY_SOLVE_RUN WHERE PLAN_SOURCE = 'COMMITTED')
          AND SKU_ID = (SELECT MIN(SKU_ID) FROM CORE.FACT_SUPPLY_PLAN WHERE PLAN_SOURCE = 'COMMITTED')
          AND PLAN_SOURCE = 'COMMITTED' AND REQUESTED_UNITS > 100"""),
    ("supply_line_over_capacity",
     """UPDATE CORE.FACT_SUPPLY_LINE_WEEK SET PRODUCED_UNITS = CAPACITY_UNITS * 2
        WHERE PLAN_SOURCE = 'COMMITTED' AND LINE_ID = 'IRL-L2' AND WEEK_NO = 10"""),
    ("supply_mix_sums_to_one",
     """UPDATE CORE.CUSTOMER_FORMAT_MIX SET SHARE = SHARE + 0.01
        WHERE CUSTOMER_ID = 'MKT-US' AND CATEGORY_ID = 'CAT-IRISH' AND CALENDAR_MONTH = 3 AND FORMAT_ID = 'F75'"""),
    ("supply_order_cache_matches_live",
     """UPDATE CORE.SUPPLY_ORDER_CACHE SET ORDER_UNITS = ORDER_UNITS + 5
        WHERE PLAN_SOURCE = 'COMMITTED' AND RECEIPT_WEEK_NO = 20"""),
    ("supply_dry_lead_time_respected",
     """UPDATE CORE.DIM_DRY_GOOD SET BASE_SUPPLY_UNITS_WEEK = SUPPLY_UNITS_WEEK + 1
        WHERE ITEM_ID = 'GLS-70'"""),
]

params = load_connection()
params.setdefault("role", "ACCOUNTADMIN")
conn = snowflake.connector.connect(**params)
cur = conn.cursor()
cur.execute("USE DATABASE VECTRON_DEMAND")
cur.execute("ALTER SESSION SET USE_CACHED_RESULT = FALSE")
failed = 0
for check, mutation in MUTATIONS:
    cur.execute("BEGIN")
    try:
        cur.execute("SELECT VIOLATIONS FROM APP.V_INTEGRITY_SUPPLY WHERE CHECK_NAME = %s", (check,))
        before = cur.fetchone()[0]
        cur.execute(mutation)
        touched = cur.rowcount
        cur.execute("SELECT VIOLATIONS FROM APP.V_INTEGRITY_SUPPLY WHERE CHECK_NAME = %s", (check,))
        after = cur.fetchone()[0]
    finally:
        cur.execute("ROLLBACK")
    cur.execute("SELECT VIOLATIONS FROM APP.V_INTEGRITY_SUPPLY WHERE CHECK_NAME = %s", (check,))
    restored = cur.fetchone()[0]
    ok = before == 0 and after > 0 and restored == 0 and touched > 0
    failed += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {check}: {before} -> {after} after mutating {touched} row(s); "
          f"{restored} after rollback")
conn.close()
sys.exit(1 if failed else 0)
