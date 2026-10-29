#!/usr/bin/env python3
"""
Ad-hoc query runner. Prints results as aligned text.

Usage:
    SNOWFLAKE_CONNECTION_NAME=snowplan python scripts/q.py "SELECT ..."
    SNOWFLAKE_CONNECTION_NAME=snowplan python scripts/q.py -f queries.sql
"""
from __future__ import annotations

import sys
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).parent))
from _conn import load_connection, split_statements  # noqa: E402


def show(cur, sql: str) -> None:
    cur.execute(sql)
    cols = [c[0] for c in cur.description]
    rows = cur.fetchall()
    widths = [
        max(len(str(c)), *(len(str(r[i])) for r in rows)) if rows else len(str(c))
        for i, c in enumerate(cols)
    ]
    widths = [min(w, 42) for w in widths]
    print(" | ".join(str(c)[:w].ljust(w) for c, w in zip(cols, widths)))
    print("-+-".join("-" * w for w in widths))
    for r in rows:
        print(" | ".join(str(v)[:w].ljust(w) for v, w in zip(r, widths)))
    print(f"({len(rows)} row(s))\n")


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    if args[0] == "-f":
        sqls = split_statements(Path(args[1]).read_text())
    else:
        sqls = [args[0]]

    params = load_connection()
    params.setdefault("role", "ACCOUNTADMIN")
    conn = snowflake.connector.connect(**params)
    cur = conn.cursor()
    try:
        for s in sqls:
            print(f"--- {s.strip()[:100]}")
            show(cur, s)
    finally:
        cur.close()
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
