"""Time the plan-grid leaf query pieces server-side. Usage: python3 scripts/profile_leaf.py"""
import sys
import time
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

QUERIES = {
    "plan_forward": "SELECT COUNT(*) FROM VECTRON_DEMAND.APP.V_PLAN_FORWARD",
    "effect": "SELECT COUNT(*), COUNT(DISTINCT SERIES_ID, WEEK_ID) FROM VECTRON_DEMAND.CORE.FACT_PLAN_EFFECT",
    "input": "SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_PLAN_INPUT",
    "agent_week": "SELECT COUNT(*) FROM VECTRON_DEMAND.CORE.FACT_AGENT_PROPOSAL_WEEK",
    "series": "SELECT COUNT(*) FROM VECTRON_DEMAND.APP.V_SERIES",
    "contrib": "SELECT COUNT(*) FROM VECTRON_DEMAND.APP.V_PLAN_CONTRIBUTION",
}

params = load_connection()
params.setdefault("role", "ACCOUNTADMIN")
params.setdefault("database", "VECTRON_DEMAND")
conn = snowflake.connector.connect(**params)
cur = conn.cursor()
cur.execute("USE DATABASE VECTRON_DEMAND")
cur.execute("ALTER SESSION SET USE_CACHED_RESULT = FALSE")
for name, sql in QUERIES.items():
    t = time.time()
    cur.execute(sql)
    rows = cur.fetchall()
    print(f"{name:14s} {time.time() - t:5.2f}s rows={len(rows)} first={rows[0] if len(rows) == 1 else ''}")
conn.close()
