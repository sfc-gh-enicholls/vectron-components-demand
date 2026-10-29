"""Time the data-version probe used by the plan-grid leaf cache. Usage: python3 scripts/profile_version.py"""
import sys
import time
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

TABLES = ["CORE.DIM_SERIES", "CORE.DIM_PRODUCT", "CORE.DIM_CATEGORY", "CORE.DIM_CUSTOMER",
          "CORE.DIM_CHANNEL", "CORE.FACT_POS_WEEKLY", "CORE.DIM_WEEK", "ML.FACT_FORECAST",
          "CORE.FACT_DEMAND_PLAN", "CORE.DIM_REASON_CODE", "CORE.FACT_PLAN_INPUT",
          "CORE.FACT_PLAN_EFFECT", "CORE.FACT_AGENT_PROPOSAL", "CORE.FACT_AGENT_PROPOSAL_WEEK",
          "CORE.FACT_AGENT_DECISION", "CORE.DIM_DUTY", "CORE.FACT_SCENARIO_EDIT",
          "CORE.FACT_SCENARIO_DRIVER"]
SQL = "SELECT " + " || '/' || ".join(
    f"SYSTEM$LAST_CHANGE_COMMIT_TIME('VECTRON_DEMAND.{t}')" for t in TABLES) + " AS V"

params = load_connection()
params.setdefault("role", "ACCOUNTADMIN")
conn = snowflake.connector.connect(**params)
cur = conn.cursor()
cur.execute("ALTER SESSION SET USE_CACHED_RESULT = FALSE")
for _ in range(3):
    t = time.time()
    cur.execute(SQL)
    v = cur.fetchone()[0]
    print(f"{time.time() - t:5.2f}s {v[:60]}...")
conn.close()
