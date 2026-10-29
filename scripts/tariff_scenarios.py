#!/usr/bin/env python3
"""
Create the named tariff and localisation scenarios for Vectron.

WHY THESE THREE
---------------
Two are live exposures for a European Tier 1, the third is the structural
answer to the first:

  * US tariff on Mexican-built auto parts. Vectron's San Luis Potosí plant
    supplies Ford's North American flows. Under USMCA those parts enter the US
    at zero; a Section 232-style 25% duty on parts creates a rate from nothing,
    and it lands on an OEM customer that buys direct, where Vectron's
    ex-works price is almost all of the delivered cost, so there is no margin
    or tax layer to dilute it.
  * Aluminium surcharge spike. Castings, knuckles, control arms and e-axle
    housings carry a material surcharge per kg. A doubling of the index (as in
    2022) moves delivered cost most on heavy, cheap parts, where the surcharge
    is a large share of price.
  * Localise to USMCA content. Re-sourcing castings and forgings into North
    America lifts regional value content so the parts qualify for zero duty
    again, at a localisation cost per piece. It belongs beside the shock so
    the two can be compared.

HOW THE DELIVERED-COST MOVE IS DERIVED
--------------------------------------
Not by reimplementing the build-up. Brokerage, distributor margin and VAT are
all multiplicative on the duty-paid cost,

    delivered = duty_paid * (1+brokerage) * (1+margin) * (1+vat)

so a change in duty-paid cost moves delivered cost by the same PROPORTION:

    pct_change = delta_duty_paid / duty_paid

Every layer above cancels, so the impact is computed from DUTY_PAID_EUR_CASE
and CIF on V_LANDED_COST alone (column names are inherited; see
10-duty.sql for what each means for Vectron). There is no second copy of the
build-up to drift out of step.

ELASTICITY IS READ, NOT REDEFINED
---------------------------------
src/lib/elasticity.json is the single source of truth, shared with
src/lib/scenario.ts and scripts/agent.py. The OE channel multiplier is near
zero: an OEM does not build fewer cars because a part costs more this year,
so the volume response on OE series is small and the cost lands as margin
pressure. That is the honest result, and the scenarios show it.
"""
from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

import snowflake.connector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _conn import load_connection  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ASSUMPTIONS = json.loads((ROOT / "src" / "lib" / "elasticity.json").read_text())
TIER_ELASTICITY = ASSUMPTIONS["tierElasticity"]
CHANNEL_MULTIPLIER = ASSUMPTIONS["channelPriceMultiplier"]

# Categories built largely from aluminium castings, and therefore exposed to
# the aluminium surcharge.
ALUMINIUM_CATEGORIES = ("Chassis & suspension", "Steering", "E-drive")

USMCA_LOCALISATION_COST = 0.06   # of EXW per piece, after re-sourcing castings
ALU_SURCHARGE_MULTIPLE = 2.0     # the per-kg surcharge doubles


def scenario_specs() -> list[dict]:
    """
    Each scenario supplies a SQL predicate selecting the series it touches, and
    the arithmetic for the new duty-paid cost. Keeping both as SQL means the
    delivered-cost move is computed against the same view the app reads.
    """
    return [
        {
            "name": "US 25% tariff on Mexican-built parts",
            "description": (
                "A 25% duty on Ford's parts built in San Luis Potosí, against "
                "the USMCA zero they enter at today. Ford buys direct, so "
                "Vectron's price is nearly all of the delivered cost and the "
                "tariff has no margin or tax layer to hide behind. Ford's "
                "build schedule barely moves; the cost lands as a commercial "
                "negotiation."
            ),
            "predicate": (
                "lc.CUSTOMER_ID = 'OEM-FORD' AND lc.CATEGORY_NAME IN "
                "('Brake systems', 'Chassis & suspension')"
            ),
            "new_duty_paid": (
                "lc.DUTY_PAID_EUR_CASE - lc.TARIFF_EUR_CASE "
                "+ lc.CIF_EUR_CASE * 0.25"
            ),
            "extra_pre_tax": "0",
        },
        {
            "name": "Aluminium surcharge doubles",
            "description": (
                "The per-kg aluminium surcharge doubles, as it did in 2022, on "
                "every aluminium-intensive part family. The move is largest on "
                "heavy, low-value parts and in the aftermarket, where garages "
                "respond to price."
            ),
            "predicate": (
                "lc.CATEGORY_NAME IN "
                f"({', '.join(chr(39) + c + chr(39) for c in ALUMINIUM_CATEGORIES)})"
            ),
            "new_duty_paid": (
                f"lc.DUTY_PAID_EUR_CASE + lc.EXCISE_EUR_CASE * ({ALU_SURCHARGE_MULTIPLE} - 1)"
            ),
            "extra_pre_tax": "0",
        },
        {
            "name": "Localise Ford parts to USMCA content",
            "description": (
                "Re-source castings and forgings into North America so Ford's "
                "parts meet USMCA regional value content and stay duty-free "
                "under a parts tariff. A localisation cost per piece replaces "
                "the tariff. This is the structural answer to the first "
                "scenario rather than a forecast of one."
            ),
            "predicate": (
                "lc.CUSTOMER_ID = 'OEM-FORD' AND lc.CATEGORY_NAME IN "
                "('Brake systems', 'Chassis & suspension')"
            ),
            "new_duty_paid": (
                f"lc.DUTY_PAID_EUR_CASE + lc.UNIT_PRICE_EUR * {USMCA_LOCALISATION_COST}"
            ),
            "extra_pre_tax": "0",
        },
    ]


def build_sql(spec: dict) -> str:
    """
    One statement per scenario: compute the delivered-cost move, apply elasticity, and
    write the edits.

    The volume response is elasticity x channel multiplier x delivered-cost change. Tier
    elasticity and the channel multiplier are injected from elasticity.json as
    CASE expressions rather than hardcoded, so this cannot silently disagree with
    the rest of the app.
    """
    tier_case = " ".join(
        f"WHEN '{tier}' THEN {value}" for tier, value in TIER_ELASTICITY.items()
    )
    channel_case = " ".join(
        f"WHEN '{channel}' THEN {value}"
        for channel, value in CHANNEL_MULTIPLIER.items()
    )
    return f"""
    INSERT INTO CORE.FACT_SCENARIO_EDIT
      (SCENARIO_ID, SERIES_ID, WEEK_ID, BASE_UNITS, EDIT_UNITS, DELTA_UNITS,
       ORIGIN, REASON_CODE, NOTE, EDIT_GROUP_ID, PARENT_LEVEL, PARENT_KEY,
       DISAGG_METHOD, EDITED_BY, EDITED_AT)
    WITH moved AS (
      SELECT
        lc.SERIES_ID,
        -- Proportional delivered-cost move. See the module docstring for why this is the
        -- change in duty-paid cost over duty-paid cost.
        (({spec['new_duty_paid']}) - lc.DUTY_PAID_EUR_CASE)
          / NULLIF(lc.DUTY_PAID_EUR_CASE, 0)
          + ({spec['extra_pre_tax']}) / NULLIF(lc.PRE_TAX_SHELF_EUR_CASE, 0)
                                                        AS SHELF_PCT_CHANGE,
        CASE lc.PRICE_TIER {tier_case} ELSE -1.0 END     AS ELASTICITY,
        CASE lc.CHANNEL_NAME {channel_case} ELSE 1.0 END AS CHANNEL_MULT
      FROM APP.V_LANDED_COST lc
      WHERE {spec['predicate']}
    ),
    responded AS (
      SELECT
        SERIES_ID,
        -- Response is floored at -0.90: elasticity is a local approximation and
        -- extrapolating it to a total collapse of demand would be dishonest
        -- about what the assumption can support.
        --
        -- NOTE: no bare percent sign anywhere in this statement, including in
        -- comments. The connector runs pyformat substitution over the whole
        -- string before sending it, so a lone percent character followed by a
        -- colon or a quote is read as a malformed format specifier and raises
        -- before the query is ever sent. Percent signs that must survive into
        -- the SQL have to be written doubled.
        GREATEST(-0.90, ELASTICITY * CHANNEL_MULT * SHELF_PCT_CHANGE)
          AS VOLUME_RESPONSE,
        SHELF_PCT_CHANGE
      FROM moved
    )
    SELECT
      %(scenario_id)s,
      p.SERIES_ID,
      p.WEEK_ID,
      p.PLAN_UNITS,
      ROUND(p.PLAN_UNITS * (1 + r.VOLUME_RESPONSE), 2),
      ROUND(p.PLAN_UNITS * (1 + r.VOLUME_RESPONSE), 2) - p.PLAN_UNITS,
      'planner',
      'DUTY_CHANGE',
      'Shelf price ' || TO_VARCHAR(ROUND(r.SHELF_PCT_CHANGE * 100, 1))
        || '%%, volume response '
        || TO_VARCHAR(ROUND(r.VOLUME_RESPONSE * 100, 1)) || '%%',
      %(group_id)s,
      NULL, NULL,
      'duty_elasticity',
      'ENICHOLLS',
      CURRENT_TIMESTAMP()
    FROM CORE.FACT_DEMAND_PLAN p
    JOIN responded r ON r.SERIES_ID = p.SERIES_ID
    """


def main() -> int:
    conn = snowflake.connector.connect(**load_connection())
    cur = conn.cursor()
    cur.execute("USE ROLE ACCOUNTADMIN")
    cur.execute("USE DATABASE VECTRON_DEMAND")
    cur.execute("USE SCHEMA CORE")

    cur.execute("SELECT MAX(WEEK_ID) FROM CORE.FACT_POS_WEEKLY")
    base_week = cur.fetchone()[0]

    for spec in scenario_specs():
        # Idempotent: drop any previous run of the same named scenario so this
        # script can be re-run without stacking duplicates.
        cur.execute(
            "SELECT SCENARIO_ID FROM CORE.DIM_SCENARIO WHERE SCENARIO_NAME = %s",
            (spec["name"],),
        )
        for (old_id,) in cur.fetchall():
            cur.execute(
                "DELETE FROM CORE.FACT_SCENARIO_EDIT WHERE SCENARIO_ID = %s",
                (old_id,),
            )
            cur.execute(
                "DELETE FROM CORE.DIM_SCENARIO WHERE SCENARIO_ID = %s", (old_id,)
            )

        scenario_id = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO CORE.DIM_SCENARIO
              (SCENARIO_ID, SCENARIO_NAME, DESCRIPTION, STATUS, BASE_PLAN_WEEK,
               CREATED_BY, CREATED_AT, UPDATED_AT)
            VALUES (%s, %s, %s, 'draft', %s, 'ENICHOLLS',
                    CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
            """,
            (scenario_id, spec["name"], spec["description"], base_week),
        )
        cur.execute(
            build_sql(spec),
            {"scenario_id": scenario_id, "group_id": str(uuid.uuid4())},
        )
        cur.execute(
            """
            SELECT COUNT(*), COUNT(DISTINCT SERIES_ID),
                   ROUND(SUM(DELTA_UNITS), 0)
            FROM CORE.FACT_SCENARIO_EDIT WHERE SCENARIO_ID = %s
            """,
            (scenario_id,),
        )
        rows, series, delta = cur.fetchone()
        print(f"  {spec['name']}")
        print(f"    {rows:,} edits over {series} series, "
              f"delta {float(delta or 0):,.0f} units")

    cur.execute("""
        SELECT CHECK_NAME, VIOLATIONS FROM APP.V_INTEGRITY_ALL
        WHERE VIOLATIONS > 0
    """)
    bad = cur.fetchall()
    if bad:
        print("INTEGRITY FAILURES:")
        for name, violations in bad:
            print(f"  FAIL {name}: {violations}")
    else:
        print("integrity: all checks 0")

    conn.close()
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
