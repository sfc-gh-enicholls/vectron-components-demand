import { query } from "@/lib/snowflake";
import { hierarchyPredicate, pickLevels, type HierarchyPathServer } from "@/lib/hierarchy-path";

/**
 * The constrained supply solve (APP.SP_SUPPLY_SOLVE) takes ~25 s on the demo
 * warehouse, too long to hold an HTTP request or an approval click open. So
 * it runs in the background: callers start it and the page polls status.
 *
 * One solve per plan source at a time. Starting a source that is already
 * running returns the running job rather than a second CALL, because two
 * concurrent solves of the same source would race on its result rows.
 *
 * In-memory on purpose: a demo has one server process. A restart loses only
 * the "running" flag; the last COMPLETED solve is always read from
 * CORE.FACT_SUPPLY_SOLVE_RUN, which is the source of truth.
 */

export type SolveTrigger = "manual" | "promotion" | "scenario_edit";

export type SolveJob = {
  planSource: string;
  trigger: SolveTrigger;
  requestedBy: string;
  startedAt: string;
  status: "running" | "done" | "failed";
  finishedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
};

const jobs = new Map<string, SolveJob>();

const SOURCE_PATTERN = /^[0-9A-Za-z_-]{1,60}$/;

/** COMMITTED, or a live scenario id. Bound, never interpolated. */
export async function isValidPlanSource(source: string): Promise<boolean> {
  if (source === "COMMITTED") return true;
  if (!SOURCE_PATTERN.test(source)) return false;
  const rows = await query<{ N: number }>(
    `SELECT COUNT(*) AS N FROM CORE.DIM_SCENARIO
     WHERE SCENARIO_ID = ? AND STATUS <> 'discarded'`,
    [source],
  );
  return Number(rows[0]?.N ?? 0) > 0;
}

export function getSolveJob(source: string): SolveJob | null {
  return jobs.get(source) ?? null;
}

/** In-flight cache rebuilds, so concurrent readers of one source share one. */
const cacheRefreshes = new Map<string, Promise<string | null>>();

/**
 * Make CORE.SUPPLY_ORDER_CACHE current for a plan source and return the plan
 * version it holds. The version check is cheap; the rebuild (APP.
 * SP_REFRESH_ORDER_CACHE, 2-3 s) only runs when the plan has moved, so a read
 * after an edit still sees the edit and an unchanged plan costs one lookup.
 */
export async function ensureOrderCache(source: string): Promise<string | null> {
  const rows = await query<{ CURRENT_VERSION: string | null; CACHED_VERSION: string | null }>(
    `SELECT v.PLAN_VERSION AS CURRENT_VERSION, c.PLAN_VERSION AS CACHED_VERSION
     FROM APP.V_PLAN_VERSION v
     LEFT JOIN CORE.SUPPLY_ORDER_CACHE_VERSION c ON c.PLAN_SOURCE = v.PLAN_SOURCE
     WHERE v.PLAN_SOURCE = ?`,
    [source],
  );
  const row = rows[0];
  if (row && row.CURRENT_VERSION && row.CURRENT_VERSION === row.CACHED_VERSION) {
    return row.CURRENT_VERSION;
  }
  let pending = cacheRefreshes.get(source);
  if (!pending) {
    pending = query<{ SP_REFRESH_ORDER_CACHE: string | null }>(
      "CALL APP.SP_REFRESH_ORDER_CACHE(?)",
      [source],
    )
      .then((r) => r[0]?.SP_REFRESH_ORDER_CACHE ?? null)
      .finally(() => cacheRefreshes.delete(source));
    cacheRefreshes.set(source, pending);
  }
  return pending;
}

/**
 * Rebuild a source's order cache in the background after its plan changes,
 * so the next supply read is a lookup rather than a 3-10 s rebuild. Never
 * throws: a failed warm only means that read rebuilds the cache itself.
 */
export function warmOrderCache(source: string): void {
  ensureOrderCache(source).catch((err) => console.error("order cache warm failed:", err));
}

export function startSolve(
  planSource: string,
  trigger: SolveTrigger,
  requestedBy: string,
): SolveJob {
  const existing = jobs.get(planSource);
  if (existing?.status === "running") return existing;

  const job: SolveJob = {
    planSource,
    trigger,
    requestedBy,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  jobs.set(planSource, job);

  void (async () => {
    try {
      const rows = await query<{ SP_SUPPLY_SOLVE: string }>(
        "CALL APP.SP_SUPPLY_SOLVE(?)",
        [planSource],
      );
      const payload = JSON.parse(rows[0]?.SP_SUPPLY_SOLVE ?? "{}") as Record<string, unknown>;
      if (typeof payload.runId === "string") {
        await query(
          `UPDATE CORE.FACT_SUPPLY_SOLVE_RUN SET TRIGGER_NAME = ?
           WHERE RUN_ID = ? AND PLAN_SOURCE = ?`,
          [`${trigger}:${requestedBy}`.slice(0, 40), payload.runId, planSource],
        );
      }
      // The agent's supply signal reads the committed solve, so rebuild it
      // whenever that solve changes; a stale signal would argue from old supply.
      if (planSource === "COMMITTED") {
        await query("CALL APP.SP_REFRESH_SUPPLY_SIGNAL()");
      }
      job.result = payload;
      job.status = "done";
    } catch (err) {
      job.status = "failed";
      job.error = (err as Error).message ?? "Solve failed";
      console.error("supply solve failed:", job.error);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

export type SolveStatusRow = {
  RUN_ID: string;
  PLAN_SOURCE: string;
  SOLVED_AT: string;
  TRIGGER_NAME: string | null;
  ORDER_COUNT: number;
  REQUESTED_UNITS: number;
  PRODUCED_UNITS: number;
  ON_TIME_UNITS: number;
  LIQUID_SHORT_UNITS: number;
  UNMET_UNITS: number;
  IS_STALE: boolean;
};

/** The last completed solve for a source, and whether the plan has moved since. */
export async function lastSolve(source: string): Promise<SolveStatusRow | null> {
  const rows = await query<SolveStatusRow>(
    `SELECT RUN_ID, PLAN_SOURCE, TO_VARCHAR(SOLVED_AT, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS SOLVED_AT,
            TRIGGER_NAME, ORDER_COUNT, REQUESTED_UNITS, PRODUCED_UNITS, ON_TIME_UNITS,
            LIQUID_SHORT_UNITS, UNMET_UNITS, IS_STALE
     FROM APP.V_SUPPLY_SOLVE_STATUS WHERE PLAN_SOURCE = ?`,
    [source],
  );
  return rows[0] ?? null;
}

export type SupplyLine = {
  /** Which plan the solve was for: the grid's scenario, or the committed plan. */
  planSource: string;
  solvedAt: string | null;
  isStale: boolean;
  /** Channel is not a supply grain; when the scope names one it is ignored. */
  channelIgnored: boolean;
  /** Per grid column key: units the solve delivers on time, and late. */
  byColumn: Record<string, { onTime: number; late: number; requested: number }>;
};

export type SupplyWeeks = {
  planSource: string;
  solvedAt: string;
  isStale: boolean;
  channelIgnored: boolean;
  byWeek: Map<string, { onTime: number; late: number; requested: number }>;
};

/**
 * Read-only supply line for the planning grid: what the last constrained solve
 * of this plan delivers, by receipt week. Never written to and never part of
 * the measure chain; null when this plan has no solve yet. Scope honours
 * category, product and customer only. Independent of the grid's columns so the
 * route can run it in parallel with the matrix and roll it up afterwards.
 */
export async function planSupplyWeeks(
  source: string,
  path: HierarchyPathServer,
): Promise<SupplyWeeks | null> {
  const scope = hierarchyPredicate(pickLevels(path, ["CATEGORY_NAME", "PRODUCT_NAME", "CUSTOMER_NAME"]), "a");
  const [solve, rows] = await Promise.all([
    lastSolve(source),
    query<{ WEEK_ID: string; ON_TIME: number; LATE: number; REQUESTED: number }>(
      `SELECT a.RECEIPT_WEEK_ID AS WEEK_ID, SUM(a.ON_TIME_UNITS) AS ON_TIME,
              SUM(a.LATE_UNITS) AS LATE, SUM(a.REQUESTED_UNITS) AS REQUESTED
       FROM (SELECT sa.*, b.PRODUCT_NAME, c.CATEGORY_NAME, m.CUSTOMER_NAME
             FROM APP.V_SUPPLY_ALLOCATION sa
             JOIN CORE.DIM_PRODUCT b    ON b.PRODUCT_ID = sa.PRODUCT_ID
             JOIN CORE.DIM_CATEGORY c ON c.CATEGORY_ID = b.CATEGORY_ID
             JOIN CORE.DIM_CUSTOMER m   ON m.CUSTOMER_ID = sa.CUSTOMER_ID
             WHERE sa.PLAN_SOURCE = ?) a
       WHERE ${scope.sql}
       GROUP BY 1`,
      [source, ...scope.binds],
    ),
  ]);
  if (!solve) return null;
  return {
    planSource: source,
    solvedAt: solve.SOLVED_AT,
    isStale: Boolean(solve.IS_STALE),
    channelIgnored: Boolean(path.CHANNEL_NAME),
    byWeek: new Map(rows.map((r) => [r.WEEK_ID, {
      onTime: Number(r.ON_TIME), late: Number(r.LATE), requested: Number(r.REQUESTED),
    }])),
  };
}

/** Roll the weekly supply line into the grid's own columns. Pure. */
export function supplyByColumn(
  weeks: SupplyWeeks | null,
  columns: { key: string; weeks: string[] }[],
): SupplyLine | null {
  if (!weeks) return null;
  const byColumn: SupplyLine["byColumn"] = {};
  for (const column of columns) {
    let onTime = 0, late = 0, requested = 0;
    for (const week of column.weeks) {
      const r = weeks.byWeek.get(week);
      if (!r) continue;
      onTime += r.onTime; late += r.late; requested += r.requested;
    }
    byColumn[column.key] = { onTime, late, requested };
  }
  return {
    planSource: weeks.planSource,
    solvedAt: weeks.solvedAt,
    isStale: weeks.isStale,
    channelIgnored: weeks.channelIgnored,
    byColumn,
  };
}

export type SupplyGap = {
  planSource: string;
  solvedAt: string;
  isStale: boolean;
  /** Net requirement the plan puts on supply (after stock and safety stock). */
  requestedUnits: number;
  onTimeUnits: number;
  /** Requested minus delivered on time: late, lost to a component allocation, or unmet. */
  gapUnits: number;
  /** The gap at each product's ex-works price per piece. */
  gapValueEur: number;
};

/**
 * The supply gap of a plan source from its last constrained solve: what the
 * plan asks of supply that supply cannot deliver on time. Null when the source
 * has never been solved, so the page can prompt for a solve instead of
 * implying there is no gap.
 */
export async function supplyGap(source: string): Promise<SupplyGap | null> {
  const [solve, rows] = await Promise.all([
    lastSolve(source),
    query<{ REQUESTED: number; ON_TIME: number; GAP_EUR: number }>(
      `SELECT SUM(sp.REQUESTED_UNITS) AS REQUESTED, SUM(sp.ON_TIME_UNITS) AS ON_TIME,
              SUM((sp.REQUESTED_UNITS - sp.ON_TIME_UNITS) * b.UNIT_PRICE_EUR) AS GAP_EUR
       FROM CORE.FACT_SUPPLY_PLAN sp
       JOIN CORE.DIM_PRODUCT b ON b.PRODUCT_ID = sp.PRODUCT_ID
       WHERE sp.PLAN_SOURCE = ?`,
      [source],
    ),
  ]);
  if (!solve) return null;
  const r = rows[0];
  const requested = Number(r?.REQUESTED ?? 0);
  const onTime = Number(r?.ON_TIME ?? 0);
  return {
    planSource: source,
    solvedAt: solve.SOLVED_AT,
    isStale: Boolean(solve.IS_STALE),
    requestedUnits: requested,
    onTimeUnits: onTime,
    gapUnits: requested - onTime,
    gapValueEur: Number(r?.GAP_EUR ?? 0),
  };
}
