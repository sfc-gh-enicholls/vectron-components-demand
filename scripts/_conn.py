"""
Shared Snowflake connection helper for the bootstrap and deploy scripts.

Reads ~/.snowflake/config.toml (the same file the snow CLI uses), looks up the
named connection, and produces a kwargs dict for snowflake.connector.connect().

Keypair auth is supported transparently: if `private_key_path` is set in the
connection block, the file is read and converted to DER PKCS8 bytes.

Usage:
    from _conn import load_connection, split_statements

    params = load_connection("eu_demo40")
    conn = snowflake.connector.connect(**params)
"""
from __future__ import annotations

import os
import re
import tomllib
from pathlib import Path

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    load_pem_private_key,
)


DEFAULT_CONFIG_PATH = "~/.snowflake/config.toml"


def load_connection(name: str | None = None, config_path: str | None = None) -> dict:
    """
    Load a connection block from ~/.snowflake/config.toml and return kwargs
    suitable for snowflake.connector.connect().

    The connection name defaults to env var SNOWFLAKE_CONNECTION_NAME
    (matching the snow CLI convention).
    """
    name = name or os.getenv("SNOWFLAKE_CONNECTION_NAME")
    if not name:
        raise RuntimeError(
            "No connection name supplied. Set SNOWFLAKE_CONNECTION_NAME or pass name=..."
        )

    path = os.path.expanduser(config_path or DEFAULT_CONFIG_PATH)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Snowflake config not found at {path}. Create one with a [connections.<name>] block."
        )

    with open(path, "rb") as f:
        cfg = tomllib.load(f)

    conn = dict(cfg.get("connections", {}).get(name, {}))
    if not conn:
        available = list(cfg.get("connections", {}).keys())
        raise ValueError(
            f"Connection '{name}' not found in {path}. "
            f"Available: {available or '(none)'}"
        )

    pkp = conn.pop("private_key_path", None)
    if pkp:
        pkp = os.path.expanduser(pkp)
        with open(pkp, "rb") as f:
            private_key = load_pem_private_key(
                f.read(), password=None, backend=default_backend()
            )
        conn["private_key"] = private_key.private_bytes(
            Encoding.DER, PrivateFormat.PKCS8, NoEncryption()
        )

    # Sensible defaults for this app
    conn.setdefault("database", "VECTRON_DEMAND")
    conn.setdefault("schema", "CORE")
    return conn


def split_statements(sql: str) -> list[str]:
    """
    Split SQL on top-level ';' but respect dollar-quoted blocks like $tag$...$tag$
    and single-quoted string literals (with '' as an escaped quote).
    Inline `--` comments are stripped before splitting (only outside quotes).
    Mirrors the splitter used by the existing run_*.py scripts.
    """
    cleaned_lines: list[str] = []
    in_str = False
    in_dollar_block = False
    dollar_tag = ""

    for line in sql.splitlines():
        out = []
        i = 0
        while i < len(line):
            ch = line[i]
            if not in_str and not in_dollar_block:
                if ch == "$":
                    m = re.match(r"\$([A-Za-z0-9_]*)\$", line[i:])
                    if m:
                        dollar_tag = m.group(0)
                        in_dollar_block = True
                        out.append(dollar_tag)
                        i += len(dollar_tag)
                        continue
                if ch == "'":
                    in_str = True
                    out.append(ch)
                    i += 1
                    continue
                if ch == "-" and i + 1 < len(line) and line[i + 1] == "-":
                    break
                out.append(ch)
                i += 1
                continue
            if in_str:
                if ch == "'":
                    if i + 1 < len(line) and line[i + 1] == "'":
                        out.append("''")
                        i += 2
                        continue
                    in_str = False
                    out.append(ch)
                    i += 1
                    continue
                out.append(ch)
                i += 1
                continue
            # in_dollar_block
            if line[i:].startswith(dollar_tag):
                in_dollar_block = False
                out.append(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = ""
                continue
            out.append(ch)
            i += 1
        cleaned_lines.append("".join(out))

    cleaned = "\n".join(cleaned_lines)

    statements: list[str] = []
    buf: list[str] = []
    i = 0
    in_str = False
    in_dollar_block = False
    dollar_tag = ""
    while i < len(cleaned):
        ch = cleaned[i]
        if not in_str and not in_dollar_block:
            if ch == "$":
                m = re.match(r"\$([A-Za-z0-9_]*)\$", cleaned[i:])
                if m:
                    dollar_tag = m.group(0)
                    in_dollar_block = True
                    buf.append(dollar_tag)
                    i += len(dollar_tag)
                    continue
            if ch == "'":
                in_str = True
                buf.append(ch)
                i += 1
                continue
            if ch == ";":
                stmt = "".join(buf).strip()
                if stmt:
                    statements.append(stmt)
                buf = []
                i += 1
                continue
            buf.append(ch)
            i += 1
            continue
        if in_str:
            if ch == "'":
                if i + 1 < len(cleaned) and cleaned[i + 1] == "'":
                    buf.append("''")
                    i += 2
                    continue
                in_str = False
                buf.append(ch)
                i += 1
                continue
            buf.append(ch)
            i += 1
            continue
        # in_dollar_block
        if cleaned[i:].startswith(dollar_tag):
            in_dollar_block = False
            buf.append(dollar_tag)
            i += len(dollar_tag)
            dollar_tag = ""
            continue
        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


def exec_sql_file(cur, sql_path: Path, label: str | None = None) -> None:
    """Execute every statement in a SQL file, skipping USE DATABASE/SCHEMA."""
    label = label or sql_path.name
    sql = sql_path.read_text()
    statements = split_statements(sql)
    runnable = [s for s in statements if not re.match(r"USE\s+(DATABASE|SCHEMA)\b", s, re.I)]
    print(f"  {label}: {len(runnable)} statement(s)")
    for i, stmt in enumerate(runnable, 1):
        preview = re.sub(r"\s+", " ", stmt)[:90]
        try:
            cur.execute(stmt)
        except Exception as e:
            raise RuntimeError(
                f"Failed in {label} on statement {i}/{len(runnable)}: {preview}...\n  {e}"
            ) from e
