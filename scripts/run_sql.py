#!/usr/bin/env python3
"""
Run one or more SQL files from vectron-demand/snowflake/ in order.

The database does not exist on the first run, so the connection is opened
without a database context and each file sets its own with USE.

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python scripts/run_sql.py 01-schema.sql
    SNOWFLAKE_CONNECTION_NAME=snowplan python scripts/run_sql.py 01 02 03
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection, split_statements  # noqa: E402

SQL_DIR = Path(__file__).parent.parent / "snowflake"


def resolve(arg: str) -> Path:
    """Accept a full filename or a numeric prefix like '02'."""
    direct = SQL_DIR / arg
    if direct.exists():
        return direct
    matches = sorted(SQL_DIR.glob(f"{arg}*.sql"))
    if not matches:
        raise FileNotFoundError(f"No SQL file matching '{arg}' in {SQL_DIR}")
    if len(matches) > 1:
        raise ValueError(f"'{arg}' is ambiguous: {[m.name for m in matches]}")
    return matches[0]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    files = [resolve(a) for a in sys.argv[1:]]

    params = load_connection()
    # The database may not exist yet on a cold run.
    params.pop("database", None)
    params.pop("schema", None)
    params.setdefault("role", "ACCOUNTADMIN")

    conn = snowflake.connector.connect(**params)
    cur = conn.cursor()
    try:
        for path in files:
            statements = split_statements(path.read_text())
            print(f"\n{path.name}: {len(statements)} statement(s)")
            for i, stmt in enumerate(statements, 1):
                preview = re.sub(r"\s+", " ", stmt)[:78]
                try:
                    cur.execute(stmt)
                except Exception as e:
                    print(f"  FAILED {i}/{len(statements)}: {preview}")
                    print(f"    {e}")
                    return 1
                print(f"  ok {i}/{len(statements)}: {preview}")
    finally:
        cur.close()
        conn.close()
    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
