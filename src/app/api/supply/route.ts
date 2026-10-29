import { NextRequest, NextResponse } from "next/server";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import { hierarchyPredicate, parseHierarchyPath, pickLevels } from "@/lib/hierarchy-path";
import { query } from "@/lib/snowflake";
import { ensureOrderCache, getSolveJob, isValidPlanSource, lastSolve } from "@/lib/supply";

export const dynamic = "force-dynamic";

/**
 * Supply review. Two layers, labelled as such in the UI:
 *   LIVE   — recomputed from the plan on this request (APP.V_PLANNED_ORDERS and
 *            friends). Unconstrained: what supply would have to do.
 *   SOLVED — the last constrained solve for this plan source
 *            (CORE.FACT_SUPPLY_*). What supply can actually deliver.
 * Supply runs at SKU x customer, so scope honours category, product and customer;
 * channel does not exist at that grain and the page says so.
 */
const SUPPLY_LEVELS = ["CATEGORY_NAME", "PRODUCT_NAME", "CUSTOMER_NAME"] as const;

/** A constant: the scoped universe the hierarchy options are drawn from. */
const OPTIONS_SOURCE = "APP.V_SERIES";

type LiveRow = {
  KIND: "LINE" | "LIQUID" | "CUSTOMER";
  K1: string;
  K2: string | null;
  WEEK_NO: number | null;
  V1: number;
  V2: number | null;
  V3: number | null;
};

type LineRow = {
  LINE_ID: string; SITE_ID: string; SITE_NAME: string; LINE_NAME: string;
  CAPACITY_UNITS_WEEK: number; CHANGEOVER_LOSS: number; LOT_SIZE_UNITS: number;
};
type WeekRow = { WEEK_NO: number; WEEK_ID: string; WEEK_START_DATE: string };
type DryRow = {
  ITEM_ID: string; ITEM_NAME: string; ITEM_TYPE: string; LEAD_WEEKS: number;
  SUPPLY_UNITS_WEEK: number; BASE_SUPPLY_UNITS_WEEK: number; WEEK_NO: number;
  NEED_UNITS: number; PROJECTED_UNITS: number;
};
type SolvedLineRow = { LINE_ID: string; WEEK_NO: number; PRODUCED_UNITS: number; REQUESTED_UNITS: number };
type AllocRow = {
  CUSTOMER_NAME: string; PRIORITY_TIER: number; REQUESTED_UNITS: number; ON_TIME_UNITS: number;
  LATE_UNITS: number; LIQUID_SHORT_UNITS: number; UNMET_UNITS: number;
};
type BindingRow = { BINDING: string; ITEM: string | null; UNITS: number };
type FillRow = { PRODUCT_NAME: string; CALENDAR_YEAR: number; FILL_RATIO: number; LIQUID_FAMILY: string };
type SourceRow = { PLAN_SOURCE: string; PLAN_SOURCE_NAME: string };

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const source = params.get("source") ?? "COMMITTED";
    if (!(await isValidPlanSource(source))) {
      return NextResponse.json({ error: "Unknown plan source." }, { status: 400 });
    }
    const path = pickLevels(parseHierarchyPath(params), [...SUPPLY_LEVELS]);
    const scope = hierarchyPredicate(path, "o");
    const allocScope = hierarchyPredicate(path, "a");
    const liquidScope = hierarchyPredicate(pickLevels(path, ["CATEGORY_NAME", "PRODUCT_NAME"]), "x");

    // The live layer reads the planned-order cache, brought up to this plan
    // version first (a lookup when unchanged, a rebuild when the plan moved).
    // The reads that do not need it start at once, in parallel.
    const cacheReady = ensureOrderCache(source);
    // One statement for the live layer: planned orders are read once.
    const livePromise = cacheReady.then(() => query<LiveRow>(
      `WITH o AS (
         SELECT po.*, b.PRODUCT_NAME, c.CATEGORY_NAME, m.CUSTOMER_NAME
         FROM CORE.SUPPLY_ORDER_CACHE po
         JOIN CORE.DIM_PRODUCT b    ON b.PRODUCT_ID = po.PRODUCT_ID
         JOIN CORE.DIM_CATEGORY c ON c.CATEGORY_ID = po.CATEGORY_ID
         JOIN CORE.DIM_CUSTOMER m   ON m.CUSTOMER_ID = po.CUSTOMER_ID
         WHERE po.PLAN_SOURCE = ?
       ), scoped AS (SELECT * FROM o WHERE ${scope.sql})
       SELECT 'LINE' AS KIND, LINE_ID AS K1, NULL AS K2, RELEASE_WEEK_NO AS WEEK_NO,
              SUM(ORDER_UNITS) AS V1, SUM(IFF(IS_PAST_DUE, ORDER_UNITS, 0)) AS V2, NULL AS V3
       FROM scoped WHERE LINE_ID IS NOT NULL GROUP BY 2, 4
       UNION ALL
       SELECT 'LIQUID', ba.LIQUID_FAMILY, NULL, s.RELEASE_WEEK_NO,
              SUM(s.ORDER_UNITS * ba.COMPONENT_QTY), NULL, NULL
       FROM scoped s
       JOIN CORE.DIM_PRODUCT_AGE ba ON ba.PRODUCT_ID = s.PRODUCT_ID
       GROUP BY 2, 4
       UNION ALL
       SELECT 'CUSTOMER', CUSTOMER_NAME, NULL, NULL, SUM(ORDER_UNITS),
              SUM(IFF(IS_PAST_DUE, ORDER_UNITS, 0)), COUNT(*)
       FROM scoped GROUP BY 2`,
      [source, ...scope.binds],
    ));

    const [live, lines, weeks, dry, solvedLines, alloc, binding, fill, sources, options, solve] =
      await Promise.all([
        livePromise,
        query<LineRow>(
          `SELECT l.LINE_ID, l.SITE_ID, s.SITE_NAME, l.LINE_NAME, l.CAPACITY_UNITS_WEEK,
                  l.CHANGEOVER_LOSS, l.LOT_SIZE_UNITS
           FROM CORE.DIM_LINE l JOIN CORE.DIM_SUPPLY_SITE s ON s.SITE_ID = l.SITE_ID
           ORDER BY l.SITE_ID, l.LINE_ID`,
        ),
        query<WeekRow>(
          `SELECT WEEK_NO, WEEK_ID, TO_VARCHAR(WEEK_START_DATE) AS WEEK_START_DATE
           FROM APP.V_PLAN_WEEK ORDER BY WEEK_NO`,
        ),
        // Bought components are shared across the portfolio, so they are never scoped.
        cacheReady.then(() => query<DryRow>(
          `SELECT ITEM_ID, ITEM_NAME, ITEM_TYPE, LEAD_WEEKS, SUPPLY_UNITS_WEEK,
                  BASE_SUPPLY_UNITS_WEEK, WEEK_NO, NEED_UNITS, PROJECTED_UNITS
           FROM APP.V_DRY_GOODS_COVERAGE WHERE PLAN_SOURCE = ?
           ORDER BY ITEM_ID, WEEK_NO`,
          [source],
        )),
        query<SolvedLineRow>(
          `SELECT LINE_ID, WEEK_NO, PRODUCED_UNITS, REQUESTED_UNITS
           FROM CORE.FACT_SUPPLY_LINE_WEEK WHERE PLAN_SOURCE = ? ORDER BY LINE_ID, WEEK_NO`,
          [source],
        ),
        query<AllocRow>(
          `SELECT a.CUSTOMER_NAME, a.PRIORITY_TIER,
                  SUM(a.REQUESTED_UNITS) AS REQUESTED_UNITS, SUM(a.ON_TIME_UNITS) AS ON_TIME_UNITS,
                  SUM(a.LATE_UNITS) AS LATE_UNITS, SUM(a.LIQUID_SHORT_UNITS) AS LIQUID_SHORT_UNITS,
                  SUM(a.UNMET_UNITS) AS UNMET_UNITS
           FROM (SELECT sa.*, b.PRODUCT_NAME, c.CATEGORY_NAME, m.CUSTOMER_NAME
                 FROM APP.V_SUPPLY_ALLOCATION sa
                 JOIN CORE.DIM_PRODUCT b    ON b.PRODUCT_ID = sa.PRODUCT_ID
                 JOIN CORE.DIM_CATEGORY c ON c.CATEGORY_ID = b.CATEGORY_ID
                 JOIN CORE.DIM_CUSTOMER m   ON m.CUSTOMER_ID = sa.CUSTOMER_ID
                 WHERE sa.PLAN_SOURCE = ?) a
           WHERE ${allocScope.sql}
           GROUP BY 1, 2 ORDER BY 1, 2`,
          [source, ...allocScope.binds],
        ),
        query<BindingRow>(
          `SELECT SPLIT_PART(a.BINDING, ':', 1) AS BINDING,
                  NULLIF(SPLIT_PART(a.BINDING, ':', 2), '') AS ITEM,
                  SUM(a.LATE_UNITS + a.UNMET_UNITS + a.LIQUID_SHORT_UNITS) AS UNITS
           FROM (SELECT sp.*, b.PRODUCT_NAME, c.CATEGORY_NAME, m.CUSTOMER_NAME
                 FROM CORE.FACT_SUPPLY_PLAN sp
                 JOIN CORE.DIM_PRODUCT b    ON b.PRODUCT_ID = sp.PRODUCT_ID
                 JOIN CORE.DIM_CATEGORY c ON c.CATEGORY_ID = b.CATEGORY_ID
                 JOIN CORE.DIM_CUSTOMER m   ON m.CUSTOMER_ID = sp.CUSTOMER_ID
                 WHERE sp.PLAN_SOURCE = ? AND sp.BINDING IS NOT NULL) a
           WHERE ${allocScope.sql}
           GROUP BY 1, 2 ORDER BY 3 DESC`,
          [source, ...allocScope.binds],
        ),
        // Allocated components are held by family, not customer (a supplier
        // allocation is not split by OEM), so only category and part scope it.
        query<FillRow>(
          `SELECT x.PRODUCT_NAME, x.CALENDAR_YEAR, x.FILL_RATIO, x.LIQUID_FAMILY
           FROM (SELECT b.PRODUCT_NAME, c.CATEGORY_NAME, f.CALENDAR_YEAR, f.FILL_RATIO,
                        lf.FAMILY_LABEL AS LIQUID_FAMILY
                 FROM APP.V_LIQUID_FILL_RATIO f
                 JOIN CORE.DIM_PRODUCT b          ON b.PRODUCT_ID = f.PRODUCT_ID
                 JOIN CORE.DIM_CATEGORY c       ON c.CATEGORY_ID = b.CATEGORY_ID
                 JOIN CORE.DIM_LIQUID_FAMILY lf ON lf.LIQUID_FAMILY = f.LIQUID_FAMILY
                 WHERE f.CALENDAR_YEAR IN (2026, 2027)) x
           WHERE ${liquidScope.sql}
           ORDER BY x.FILL_RATIO, x.PRODUCT_NAME, x.CALENDAR_YEAR`,
          liquidScope.binds,
        ),
        query<SourceRow>(
          `SELECT PLAN_SOURCE, PLAN_SOURCE_NAME FROM APP.V_PLAN_SOURCE
           ORDER BY IFF(PLAN_SOURCE = 'COMMITTED', 0, 1), PLAN_SOURCE_NAME`,
        ),
        loadHierarchyOptions(OPTIONS_SOURCE, path, [...SUPPLY_LEVELS]),
        lastSolve(source),
      ]);

    return NextResponse.json({
      source,
      sources: sources.map((s) => ({ id: s.PLAN_SOURCE, name: s.PLAN_SOURCE_NAME })),
      illustrative: true,
      weeks: weeks.map((w) => ({ weekNo: Number(w.WEEK_NO), weekId: w.WEEK_ID, start: w.WEEK_START_DATE })),
      hierarchyOptions: options,
      lines: lines.map((l) => ({
        lineId: l.LINE_ID,
        siteId: l.SITE_ID,
        siteName: l.SITE_NAME,
        lineName: l.LINE_NAME,
        capacity: Number(l.CAPACITY_UNITS_WEEK),
        effectiveCapacity: Number(l.CAPACITY_UNITS_WEEK) * (1 - Number(l.CHANGEOVER_LOSS)),
        lotSize: Number(l.LOT_SIZE_UNITS),
      })),
      liveLineLoad: live
        .filter((r) => r.KIND === "LINE")
        .map((r) => ({ lineId: r.K1, weekNo: Number(r.WEEK_NO), load: Number(r.V1), pastDue: Number(r.V2 ?? 0) })),
      liveLiquid: live
        .filter((r) => r.KIND === "LIQUID")
        .map((r) => ({ family: r.K1, weekNo: Number(r.WEEK_NO), lpa: Number(r.V1) })),
      liveByCustomer: live
        .filter((r) => r.KIND === "CUSTOMER")
        .map((r) => ({ customer: r.K1, orderUnits: Number(r.V1), pastDueUnits: Number(r.V2 ?? 0), orders: Number(r.V3 ?? 0) }))
        .sort((a, b) => b.orderUnits - a.orderUnits),
      dryGoods: groupDry(dry),
      solvedLineLoad: solvedLines.map((r) => ({
        lineId: r.LINE_ID, weekNo: Number(r.WEEK_NO), produced: Number(r.PRODUCED_UNITS), requested: Number(r.REQUESTED_UNITS),
      })),
      allocation: alloc.map((r) => ({
        customer: r.CUSTOMER_NAME,
        tier: Number(r.PRIORITY_TIER),
        requested: Number(r.REQUESTED_UNITS),
        onTime: Number(r.ON_TIME_UNITS),
        late: Number(r.LATE_UNITS),
        liquidShort: Number(r.LIQUID_SHORT_UNITS),
        unmet: Number(r.UNMET_UNITS),
      })),
      binding: binding.map((r) => ({ kind: r.BINDING, item: r.ITEM, units: Number(r.UNITS) })),
      liquidFill: fill.map((r) => ({
        product: r.PRODUCT_NAME, year: Number(r.CALENDAR_YEAR), fillRatio: Number(r.FILL_RATIO), family: r.LIQUID_FAMILY,
      })),
      solve: solve
        ? {
            runId: solve.RUN_ID,
            solvedAt: solve.SOLVED_AT,
            trigger: solve.TRIGGER_NAME,
            isStale: Boolean(solve.IS_STALE),
            requested: Number(solve.REQUESTED_UNITS),
            produced: Number(solve.PRODUCED_UNITS),
            onTime: Number(solve.ON_TIME_UNITS),
            liquidShort: Number(solve.LIQUID_SHORT_UNITS),
            unmet: Number(solve.UNMET_UNITS),
          }
        : null,
      job: getSolveJob(source),
    });
  } catch (err) {
    console.error("supply GET failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to load supply" }, { status: 500 });
  }
}

function groupDry(rows: DryRow[]) {
  const byItem = new Map<string, {
    itemId: string; name: string; type: string; leadWeeks: number; supplyPerWeek: number;
    baseSupplyPerWeek: number;
    projected: number[]; need: number[]; firstShortWeek: number | null;
  }>();
  for (const r of rows) {
    let item = byItem.get(r.ITEM_ID);
    if (!item) {
      item = {
        itemId: r.ITEM_ID, name: r.ITEM_NAME, type: r.ITEM_TYPE, leadWeeks: Number(r.LEAD_WEEKS),
        supplyPerWeek: Number(r.SUPPLY_UNITS_WEEK), baseSupplyPerWeek: Number(r.BASE_SUPPLY_UNITS_WEEK),
        projected: [], need: [], firstShortWeek: null,
      };
      byItem.set(r.ITEM_ID, item);
    }
    item.projected.push(Number(r.PROJECTED_UNITS));
    item.need.push(Number(r.NEED_UNITS));
    if (item.firstShortWeek === null && Number(r.PROJECTED_UNITS) < 0) item.firstShortWeek = Number(r.WEEK_NO);
  }
  return [...byItem.values()];
}
