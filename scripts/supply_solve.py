"""
Constrained supply solve for Meridian (MRP-lite).

The live views in 19-supply-netting.sql do everything closed-form. This does
the steps where each week depends on the previous week's DECISION, which no
view can express:

  * liquid availability   aged liquid that does not exist in a year is LOST
                          for that year (it cannot be backordered), so a
                          planned order is capped by the product's fill ratio
  * priority allocation   line capacity and dry goods are given to strategic
                          products first, then pro-rata within a tier
  * carry-forward         what a line cannot make this week joins next
                          week's queue, and arrives late
  * lot sizing            production is rounded up to the line's lot size;
                          the excess goes to stock, never to a customer, so
                          allocation can never exceed demand
  * supplier lead time    inside a dry good's lead time only the base rate
                          already on order arrives; the supplier's headroom
                          is available from the week after (same rule as
                          APP.V_DRY_GOODS_DELIVERY)

`solve()` is pure (no Snowflake) so it can be unit-tested. `run()` is the
Snowpark stored-procedure handler; `scripts/deploy_supply_solve.py` registers
it as VECTRON_DEMAND.APP.SP_SUPPLY_SOLVE(PLAN_SOURCE).

It reads demand only and writes only FACT_SUPPLY_SOLVE_RUN / FACT_SUPPLY_PLAN.
It never writes FACT_DEMAND_PLAN.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field

HORIZON = 52


@dataclass
class Order:
    key: int
    sku_id: str
    product_id: str
    customer_id: str
    site_id: str
    line_id: str | None          # None = co-packer, not line-constrained
    priority: int                # 1 = strategic
    release_week: int
    receipt_week: int
    lead_weeks: int
    units: float
    year: int                    # calendar year of the release week (matches V_LIQUID_FILL_RATIO)
    bom: dict = field(default_factory=dict)   # item -> units per case (own sites)


@dataclass
class Result:
    key: int
    requested: float = 0.0
    liquid_short: float = 0.0
    produced: float = 0.0
    on_time: float = 0.0
    late: float = 0.0
    unmet: float = 0.0
    first_prod_week: int | None = None
    last_prod_week: int | None = None
    binding: str = ""            # what held it back, if anything


def solve(orders: list[Order], capacity: dict, changeover: dict, lot_size: dict,
          dry_supply: dict, dry_opening: dict, fill_ratio: dict,
          horizon: int = HORIZON, dry_base: dict | None = None,
          dry_lead: dict | None = None):
    """Return (results by order key, line-week rows, item-week rows).

    dry_supply is the flexed weekly delivery; dry_base and dry_lead (both
    optional) give the base rate delivered in weeks 1..lead instead.
    """
    dry_base = dry_base or {}
    dry_lead = dry_lead or {}
    res = {o.key: Result(o.key, requested=o.units) for o in orders}
    by_release = defaultdict(list)
    for o in orders:
        by_release[min(max(o.release_week, 1), horizon)].append(o)

    remaining = {}            # order key -> units still to make
    item_stock = dict(dry_opening)
    line_rows, item_rows = [], []
    # Lot excess is tracked at the line, by SKU, for reporting only.
    lot_stock = defaultdict(float)

    for w in range(1, horizon + 1):
        # 1. Release this week's orders, capped by liquid availability.
        for o in by_release.get(w, []):
            ratio = fill_ratio.get((o.product_id, o.year), 1.0)
            ok = o.units * ratio
            if ratio < 1.0:
                res[o.key].liquid_short = o.units - ok
                res[o.key].binding = "liquid"
            remaining[o.key] = ok

        # Receive this week's dry-goods deliveries: the base rate within the
        # supplier lead time, the flexed rate after it.
        for item, qty in dry_supply.items():
            if w <= dry_lead.get(item, 0):
                qty = dry_base.get(item, qty)
            item_stock[item] = item_stock.get(item, 0.0) + qty

        open_orders = [o for o in orders if remaining.get(o.key, 0) > 1e-9]

        # Lot-size excess is NOT drawn down to fill later orders: it was made
        # without being charged against capacity or dry goods, so letting it
        # serve demand would create supply from nothing. It is reported as
        # line stock only (FACT_SUPPLY_LINE_WEEK.LOT_EXCESS_UNITS).
        # 2. Co-packers are not line-constrained: they make what is asked.
        for o in open_orders:
            if o.line_id is None and remaining.get(o.key, 0) > 1e-9:
                _produce(res[o.key], o, remaining[o.key], w)
                remaining[o.key] = 0.0

        # 3. Tier by tier ACROSS ALL LINES. Dry goods (gift cartons above all)
        # are shared between lines, so the tier loop must be outermost: if it
        # ran inside a line loop, lines visited first would spend cartons on
        # low-priority products before a later line's strategic products got any.
        queue = [o for o in open_orders
                 if o.line_id is not None and remaining.get(o.key, 0) > 1e-9]
        requested = defaultdict(float)
        for o in queue:
            requested[o.line_id] += remaining[o.key]
        cap_left = {l: capacity[l] * (1.0 - changeover.get(l, 0.0)) for l in capacity}
        made = defaultdict(float)
        made_by_sku = defaultdict(float)
        for tier in sorted({o.priority for o in queue}):
            tier_orders = [o for o in queue if o.priority == tier]
            want = defaultdict(float)
            for o in tier_orders:
                want[o.line_id] += remaining[o.key]
            f_line = {l: max(0.0, min(1.0, cap_left.get(l, 0.0) / n)) if n > 1e-9 else 1.0
                      for l, n in want.items()}
            # Dry-goods need of this tier at the line-feasible quantities, then
            # one factor per item shared pro-rata across the tier.
            need = defaultdict(float)
            for o in tier_orders:
                for item, per in o.bom.items():
                    need[item] += remaining[o.key] * f_line[o.line_id] * per
            f_item = {item: min(1.0, max(0.0, item_stock.get(item, 0.0)) / n)
                      for item, n in need.items() if n > 1e-9}
            for o in tier_orders:
                fd, worst = 1.0, ""
                for item in o.bom:
                    if f_item.get(item, 1.0) < fd:
                        fd, worst = f_item[item], item
                factor = f_line[o.line_id] * fd
                qty = remaining[o.key] * factor
                if qty > 1e-9:
                    _produce(res[o.key], o, qty, w)
                    remaining[o.key] -= qty
                    cap_left[o.line_id] -= qty
                    made[o.line_id] += qty
                    made_by_sku[(o.line_id, o.sku_id)] += qty
                    for item, per in o.bom.items():
                        item_stock[item] = item_stock.get(item, 0.0) - qty * per
                if remaining[o.key] > 1e-9 and not res[o.key].binding:
                    res[o.key].binding = ("dry:" + worst) if fd < 1.0 and fd <= f_line[o.line_id] \
                        else "capacity"

        # 4. Lot sizing: each SKU's run this week is rounded up to the line's
        # lot. The excess is stock at the line for later orders of the same
        # SKU, never an allocation to a customer. It is reported, not charged
        # against capacity: a demo simplification, stated in the app.
        excess = defaultdict(float)
        for (line_id, sku), qty in made_by_sku.items():
            lot = lot_size.get(line_id, 0)
            if lot:
                rounded = math.ceil(qty / lot - 1e-9) * lot
                lot_stock[(line_id, sku)] += rounded - qty
                excess[line_id] += rounded - qty
        for line_id in sorted(capacity):
            line_rows.append((line_id, w, capacity[line_id], requested[line_id],
                              made[line_id], excess[line_id]))

        for item, qty in item_stock.items():
            item_rows.append((item, w, qty))

    for k, rem in remaining.items():
        res[k].unmet = rem
    return res, line_rows, item_rows


def _produce(r: Result, o: Order, qty: float, week: int) -> None:
    r.produced += qty
    r.first_prod_week = week if r.first_prod_week is None else r.first_prod_week
    r.last_prod_week = week
    if week + o.lead_weeks <= o.receipt_week:
        r.on_time += qty
    else:
        r.late += qty


# ---------------------------------------------------------------------------
# Snowpark handler
# ---------------------------------------------------------------------------
def run(session, plan_source: str) -> str:
    import json
    import uuid

    def q(sql, params=None):
        return session.sql(sql, params=params).collect()

    # Bring the order cache up to this plan, then read orders and the version
    # they were built from in one statement, so the recorded version always
    # describes the orders actually solved.
    version = q("CALL VECTRON_DEMAND.APP.SP_REFRESH_ORDER_CACHE(?)", [plan_source])[0][0]
    rows = q("""SELECT po.SKU_ID, po.PRODUCT_ID, po.CUSTOMER_ID, po.SITE_ID, po.LINE_ID,
                       po.PRIORITY_TIER, po.RELEASE_WEEK_NO, po.RECEIPT_WEEK_NO,
                       po.LEAD_WEEKS, po.ORDER_UNITS, YEAR(pw.WEEK_START_DATE), po.RECEIPT_MONTH,
                       cv.PLAN_VERSION
                FROM VECTRON_DEMAND.CORE.SUPPLY_ORDER_CACHE po
                JOIN VECTRON_DEMAND.CORE.SUPPLY_ORDER_CACHE_VERSION cv
                  ON cv.PLAN_SOURCE = po.PLAN_SOURCE
                JOIN VECTRON_DEMAND.APP.V_PLAN_WEEK pw ON pw.WEEK_NO = po.RELEASE_WEEK_NO
                WHERE po.PLAN_SOURCE = ?""", [plan_source])
    if rows:
        version = rows[0][12]

    bom = defaultdict(dict)
    for r in q("""SELECT SKU_ID, ITEM_ID, QTY_PER_CASE FROM VECTRON_DEMAND.CORE.BOM_SKU
                  WHERE ITEM_ID <> 'LIQUID_LPA'"""):
        bom[r[0]][r[1]] = float(r[2])
    carton = {(r[0], int(r[1])): r[2] for r in q(
        "SELECT CUSTOMER_ID, CALENDAR_MONTH, CARTON_ID FROM VECTRON_DEMAND.CORE.CUSTOMER_GIFT_SEASON")}

    orders = []
    for i, r in enumerate(rows):
        own = r[3] != "SITE-OCP"
        b = {}
        if own:
            for item, per in bom[r[0]].items():
                b[carton[(r[2], int(r[11]))] if item == "GIFT_CARTON" else item] = per
        orders.append(Order(i, r[0], r[1], r[2], r[3], r[4], int(r[5]), int(r[6]),
                            int(r[7]), int(r[8]), float(r[9]), int(r[10]), b))

    capacity, changeover, lot = {}, {}, {}
    for r in q("""SELECT LINE_ID, CAPACITY_UNITS_WEEK, CHANGEOVER_LOSS, LOT_SIZE_UNITS
                  FROM VECTRON_DEMAND.CORE.DIM_LINE"""):
        capacity[r[0]], changeover[r[0]], lot[r[0]] = float(r[1]), float(r[2]), int(r[3])
    dry_supply, dry_open, dry_base, dry_lead = {}, {}, {}, {}
    for r in q("""SELECT ITEM_ID, SUPPLY_UNITS_WEEK, OPENING_UNITS,
                         BASE_SUPPLY_UNITS_WEEK, LEAD_WEEKS
                  FROM VECTRON_DEMAND.CORE.DIM_DRY_GOOD"""):
        dry_supply[r[0]], dry_open[r[0]] = float(r[1]), float(r[2])
        dry_base[r[0]], dry_lead[r[0]] = float(r[3]), int(r[4])
    fill = {(r[0], int(r[1])): float(r[2]) for r in q(
        "SELECT PRODUCT_ID, CALENDAR_YEAR, FILL_RATIO FROM VECTRON_DEMAND.APP.V_LIQUID_FILL_RATIO")}

    res, line_rows, item_rows = solve(orders, capacity, changeover, lot,
                                      dry_supply, dry_open, fill,
                                      dry_base=dry_base, dry_lead=dry_lead)

    run_id = str(uuid.uuid4())
    plan_rows = []
    for o in orders:
        r = res[o.key]
        plan_rows.append((run_id, plan_source, o.sku_id, o.product_id, o.customer_id,
                          o.site_id, o.line_id, o.priority, o.release_week,
                          o.receipt_week, o.lead_weeks, round(r.requested, 4),
                          round(r.liquid_short, 4), round(r.produced, 4),
                          round(r.on_time, 4), round(r.late, 4), round(r.unmet, 4),
                          r.first_prod_week, r.last_prod_week, r.binding or None))

    plan_cols = ["RUN_ID", "PLAN_SOURCE", "SKU_ID", "PRODUCT_ID", "CUSTOMER_ID", "SITE_ID",
                 "LINE_ID", "PRIORITY_TIER", "RELEASE_WEEK_NO", "RECEIPT_WEEK_NO",
                 "LEAD_WEEKS", "REQUESTED_UNITS", "LIQUID_SHORT_UNITS", "PRODUCED_UNITS",
                 "ON_TIME_UNITS", "LATE_UNITS", "UNMET_UNITS", "FIRST_PROD_WEEK_NO",
                 "LAST_PROD_WEEK_NO", "BINDING"]
    line_cols = ["LINE_ID", "WEEK_NO", "CAPACITY_UNITS", "REQUESTED_UNITS",
                 "PRODUCED_UNITS", "LOT_EXCESS_UNITS"]
    item_cols = ["ITEM_ID", "WEEK_NO", "STOCK_UNITS"]

    # Stage into temp tables, then swap this source's rows in one transaction
    # so a reader never sees a half-written solve. Explicit schemas: Snowpark
    # infers types per row and refuses to merge int and float.
    from snowflake.snowpark.types import (DoubleType, LongType, StringType,
                                          StructField, StructType)
    s, d, i = StringType(), DoubleType(), LongType()
    types = {"RUN_ID": s, "PLAN_SOURCE": s, "SKU_ID": s, "PRODUCT_ID": s,
             "CUSTOMER_ID": s, "SITE_ID": s, "LINE_ID": s, "BINDING": s, "ITEM_ID": s,
             "PRIORITY_TIER": i, "RELEASE_WEEK_NO": i, "RECEIPT_WEEK_NO": i,
             "LEAD_WEEKS": i, "FIRST_PROD_WEEK_NO": i, "LAST_PROD_WEEK_NO": i,
             "WEEK_NO": i}

    def stage(name, cols, data):
        schema = StructType([StructField(c, types.get(c, d)) for c in cols])
        rows = [tuple(float(v) if isinstance(v, int) and types.get(c, d) is d else v
                      for c, v in zip(cols, row)) for row in data]
        session.create_dataframe(rows, schema=schema).write.save_as_table(
            name, mode="overwrite", table_type="temporary")

    stage("TMP_SUPPLY_PLAN", plan_cols, plan_rows)
    stage("TMP_SUPPLY_LINE", line_cols, line_rows)
    stage("TMP_SUPPLY_ITEM", item_cols, item_rows)

    totals = {
        "requested": sum(r.requested for r in res.values()),
        "produced": sum(r.produced for r in res.values()),
        "on_time": sum(r.on_time for r in res.values()),
        "liquid_short": sum(r.liquid_short for r in res.values()),
        "unmet": sum(r.unmet for r in res.values()),
    }
    q("BEGIN")
    try:
        for t in ("FACT_SUPPLY_PLAN", "FACT_SUPPLY_LINE_WEEK", "FACT_SUPPLY_ITEM_WEEK"):
            q(f"DELETE FROM VECTRON_DEMAND.CORE.{t} WHERE PLAN_SOURCE = ?", [plan_source])
        q("DELETE FROM VECTRON_DEMAND.CORE.FACT_SUPPLY_SOLVE_RUN WHERE PLAN_SOURCE = ?",
          [plan_source])
        q(f"""INSERT INTO VECTRON_DEMAND.CORE.FACT_SUPPLY_PLAN ({', '.join(plan_cols)})
              SELECT {', '.join(plan_cols)} FROM TMP_SUPPLY_PLAN""")
        q(f"""INSERT INTO VECTRON_DEMAND.CORE.FACT_SUPPLY_LINE_WEEK
              (RUN_ID, PLAN_SOURCE, {', '.join(line_cols)})
              SELECT ?, ?, {', '.join(line_cols)} FROM TMP_SUPPLY_LINE""", [run_id, plan_source])
        q(f"""INSERT INTO VECTRON_DEMAND.CORE.FACT_SUPPLY_ITEM_WEEK
              (RUN_ID, PLAN_SOURCE, {', '.join(item_cols)})
              SELECT ?, ?, {', '.join(item_cols)} FROM TMP_SUPPLY_ITEM""", [run_id, plan_source])
        q("""INSERT INTO VECTRON_DEMAND.CORE.FACT_SUPPLY_SOLVE_RUN
             (RUN_ID, PLAN_SOURCE, PLAN_VERSION, SOLVED_AT, ORDER_COUNT, REQUESTED_UNITS,
              PRODUCED_UNITS, ON_TIME_UNITS, LIQUID_SHORT_UNITS, UNMET_UNITS)
             SELECT ?, ?, ?, CURRENT_TIMESTAMP(), ?, ?, ?, ?, ?, ?""",
          [run_id, plan_source, version, len(orders), totals["requested"],
           totals["produced"], totals["on_time"], totals["liquid_short"], totals["unmet"]])
        q("COMMIT")
    except Exception:
        q("ROLLBACK")
        raise
    return json.dumps({"runId": run_id, "planSource": plan_source,
                       "planVersion": version, "orders": len(orders),
                       **{k: round(v, 1) for k, v in totals.items()}})
