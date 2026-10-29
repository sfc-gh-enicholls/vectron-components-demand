"""
WI-24 demo tests (Prove). Read the committed plan, create a SCRATCH scenario,
and show that supply follows it -- without ever touching FACT_DEMAND_PLAN.

  1. US Jameson +30% (weeks 1-20): Ireland Line 2 (75cl/1.75L) live load rises
     on the very next read; the committed plan checksum is unchanged.
  2. Solving the scratch scenario gives a larger supply gap than the committed
     plan's last solve (the "US surge shows a gap" story).
  3. The Glenlivet 12 liquid requirement (12yo) moves with its plan in the same
     scratch scenario (+30% on its US series), live through V_LIQUID_NEED.

The scratch scenario and its solve rows are deleted at the end, whatever happens.
Usage: SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/demo_supply_tests.py
"""
import sys
import uuid
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

UPLIFT = 1.30
SCRATCH = "wi24-demo-" + uuid.uuid4().hex[:8]
results = []


def check(name, ok, detail):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")


params = load_connection()
params.setdefault("role", "ACCOUNTADMIN")
conn = snowflake.connector.connect(**params)
cur = conn.cursor()
cur.execute("USE DATABASE VECTRON_DEMAND")
cur.execute("ALTER SESSION SET USE_CACHED_RESULT = FALSE")


def one(sql, binds=None):
    cur.execute(sql, binds or ())
    return cur.fetchone()


def committed_checksum():
    return one("SELECT COUNT(*), TO_VARCHAR(HASH_AGG(SERIES_ID, WEEK_ID, PLAN_UNITS)) FROM CORE.FACT_DEMAND_PLAN")


def line_load(source, line):
    return float(one("""SELECT COALESCE(SUM(ORDER_UNITS), 0) FROM APP.V_PLANNED_ORDERS
                        WHERE PLAN_SOURCE = %s AND LINE_ID = %s""", (source, line))[0])


def liquid(source, family):
    return float(one("""SELECT COALESCE(SUM(NEED_LPA), 0) FROM APP.V_LIQUID_NEED
                        WHERE PLAN_SOURCE = %s AND LIQUID_FAMILY = %s""", (source, family))[0])


try:
    before_plan = committed_checksum()
    base_irl = line_load("COMMITTED", "IRL-L2")
    base_glv = liquid("COMMITTED", "LF-MALT-GLENLIVET")

    # Scratch scenario: US Jameson Original and The Glenlivet 12, weeks 1-20, +30%.
    cur.execute("""INSERT INTO CORE.DIM_SCENARIO (SCENARIO_ID, SCENARIO_NAME, DESCRIPTION, STATUS,
                     BASE_PLAN_WEEK, CREATED_BY)
                   SELECT %s, 'WI-24 demo: US surge (scratch)', 'Deleted by demo_supply_tests.py',
                          'draft', HISTORY_END_WEEK, 'demo_supply_tests' FROM APP.V_CONTEXT""", (SCRATCH,))
    cur.execute("""INSERT INTO CORE.FACT_SCENARIO_EDIT (SCENARIO_ID, SERIES_ID, WEEK_ID, BASE_UNITS,
                     EDIT_UNITS, DELTA_UNITS, ORIGIN, REASON_CODE, NOTE, EDIT_GROUP_ID, DISAGG_METHOD, EDITED_BY)
                   SELECT %s, d.SERIES_ID, d.WEEK_ID, d.PLAN_UNITS, ROUND(d.PLAN_UNITS * %s, 2),
                          ROUND(d.PLAN_UNITS * %s, 2) - d.PLAN_UNITS, 'planner', 'CUST_INTEL',
                          'WI-24 demo test', %s, 'direct', 'demo_supply_tests'
                   FROM CORE.FACT_DEMAND_PLAN d
                   JOIN CORE.DIM_SERIES s ON s.SERIES_ID = d.SERIES_ID
                   JOIN APP.V_PLAN_WEEK pw ON pw.WEEK_ID = d.WEEK_ID
                   WHERE s.CUSTOMER_ID = 'MKT-US' AND s.PRODUCT_ID IN ('BRD-JAMOR', 'BRD-GLV12')
                     AND pw.WEEK_NO <= 20""", (SCRATCH, UPLIFT, UPLIFT, SCRATCH))
    edited = cur.rowcount

    # --- Test 1: live recompute, committed untouched -------------------------
    new_irl = line_load(SCRATCH, "IRL-L2")
    check("1a live line load follows the plan", new_irl > base_irl * 1.01,
          f"IRL-L2 planned production {base_irl:,.0f} -> {new_irl:,.0f} units "
          f"({(new_irl / base_irl - 1) * 100:+.1f}%) after editing {edited} series-weeks")
    check("1b committed plan untouched", committed_checksum() == before_plan,
          f"FACT_DEMAND_PLAN rows/checksum {before_plan[0]} / unchanged")

    # --- Test 3: aged liquid moves with the plan -----------------------------
    new_glv = liquid(SCRATCH, "LF-MALT-GLENLIVET")
    check("3  12yo liquid requirement follows the plan", new_glv > base_glv * 1.001,
          f"Glenlivet liquid draw {base_glv:,.0f} -> {new_glv:,.0f} LPA "
          f"({(new_glv / base_glv - 1) * 100:+.2f}%)")

    # --- Test 2: the solve shows the gap --------------------------------------
    cur.execute("CALL APP.SP_SUPPLY_SOLVE(%s)", (SCRATCH,))
    gap = lambda src: float(one("""SELECT SUM(REQUESTED_UNITS - ON_TIME_UNITS)
                                   FROM CORE.FACT_SUPPLY_PLAN WHERE PLAN_SOURCE = %s""", (src,))[0])
    us_late = lambda src: float(one("""SELECT SUM(REQUESTED_UNITS - ON_TIME_UNITS) FROM CORE.FACT_SUPPLY_PLAN
                                       WHERE PLAN_SOURCE = %s AND LINE_ID = 'IRL-L2'""", (src,))[0])
    g_c, g_s = gap("COMMITTED"), gap(SCRATCH)
    l_c, l_s = us_late("COMMITTED"), us_late(SCRATCH)
    check("2a surge scenario shows a larger supply gap", g_s > g_c,
          f"gap {g_c:,.0f} -> {g_s:,.0f} units; on IRL-L2 {l_c:,.0f} -> {l_s:,.0f}")
    check("2b committed plan still untouched after solve", committed_checksum() == before_plan,
          "FACT_DEMAND_PLAN unchanged")
    stale = one("SELECT IS_STALE FROM APP.V_SUPPLY_SOLVE_STATUS WHERE PLAN_SOURCE = %s", (SCRATCH,))[0]
    check("2c fresh solve is not stale", stale is False, f"IS_STALE={stale}")
finally:
    for t in ("FACT_SUPPLY_PLAN", "FACT_SUPPLY_LINE_WEEK", "FACT_SUPPLY_ITEM_WEEK", "FACT_SUPPLY_SOLVE_RUN"):
        cur.execute(f"DELETE FROM CORE.{t} WHERE PLAN_SOURCE = %s", (SCRATCH,))
    cur.execute("DELETE FROM CORE.FACT_SCENARIO_EDIT WHERE SCENARIO_ID = %s", (SCRATCH,))
    cur.execute("DELETE FROM CORE.DIM_SCENARIO WHERE SCENARIO_ID = %s", (SCRATCH,))
    left = one("SELECT COUNT(*) FROM CORE.DIM_SCENARIO WHERE SCENARIO_ID = %s", (SCRATCH,))[0]
    print(f"cleanup: scratch scenario {SCRATCH} removed ({left} rows left)")
    conn.close()

failed = [n for n, ok in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
