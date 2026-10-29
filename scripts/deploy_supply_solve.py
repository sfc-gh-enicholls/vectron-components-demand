"""
Register scripts/supply_solve.py as VECTRON_DEMAND.APP.SP_SUPPLY_SOLVE.

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python3 scripts/deploy_supply_solve.py [--run]

--run also solves the committed plan once and prints the summary.
"""
import sys
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection  # noqa: E402

code = (Path(__file__).parent / "supply_solve.py").read_text()
if "$$" in code:
    raise SystemExit("supply_solve.py contains $$, which would end the procedure body")

DDL = (
    "CREATE OR REPLACE PROCEDURE VECTRON_DEMAND.APP.SP_SUPPLY_SOLVE(PLAN_SOURCE VARCHAR)\n"
    "RETURNS VARCHAR\n"
    "LANGUAGE PYTHON\n"
    "RUNTIME_VERSION = '3.11'\n"
    "PACKAGES = ('snowflake-snowpark-python')\n"
    "HANDLER = 'run'\n"
    "EXECUTE AS CALLER\n"
    "AS $$\n" + code + "\n$$"
)

params = load_connection()
params.setdefault("role", "ACCOUNTADMIN")
conn = snowflake.connector.connect(**params)
cur = conn.cursor()
try:
    # paramstyle is pyformat, so pass no params: '%' in the code must not be parsed.
    cur.execute(DDL, _no_results=False)
    print("registered VECTRON_DEMAND.APP.SP_SUPPLY_SOLVE")
    if "--run" in sys.argv:
        cur.execute("CALL VECTRON_DEMAND.APP.SP_SUPPLY_SOLVE('COMMITTED')")
        print(cur.fetchone()[0])
finally:
    cur.close()
    conn.close()
