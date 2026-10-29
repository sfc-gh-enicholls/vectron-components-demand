/**
 * Server side of formulas-as-data: loads the measure catalogue and the leaf
 * inputs, then builds the planning-grid matrix and the reconciliation check.
 * All arithmetic is in src/lib/measure-model.ts (pure, unit-tested).
 *
 * LEAF INPUTS (one per series x week)
 * ------------------------------------
 * - BASELINE / EVENT / PROMO / STREAM come from APP.V_PLAN_CONTRIBUTION, the
 *   additive spine (accepted stream input only).
 * - PRICE_CHANGE_PCT is 0 unless the scenario has a driver override;
 *   PRICE_RESPONSE is priceMultiplier() from src/lib/scenario.ts, the same
 *   elasticity function the agent and the scenario tests use.
 * - PLANNER_UNITS is the residual that makes the chain reproduce the plan
 *   exactly: (plan before price) minus everything attributed above it. For the
 *   committed plan that is PLANNER_DELTA + AGENT_DELTA; under a scenario the
 *   plan is the scenario's units divided by its price response.
 * - Per-case assumptions come from APP.V_LANDED_COST, so the value lines use
 *   the same build-up as /value's landed-cost tab.
 */
import { query } from "@/lib/snowflake";
import { dataVersion, versionedCache } from "@/lib/data-version";
import { priceMultiplier } from "@/lib/scenario";
import {
  addInto,
  buildMeasureModel,
  emptySums,
  evaluateLeaf,
  evaluateNode,
  ratioMeasures,
  type MeasureCatalogRow,
  type MeasureDef,
  type MeasureModel,
  type Values,
} from "@/lib/measure-model";
import { ALT_LEVELS } from "@/lib/dimensions";
import {
  hierarchyPredicate,
  pathLevelOrder,
  type HierarchyPathServer,
  type PathLevel,
} from "@/lib/hierarchy-path";

let modelCache: { model: MeasureModel; loadedAt: number } | null = null;
const MODEL_TTL_MS = 60_000;

export async function loadMeasureModel(force = false): Promise<MeasureModel> {
  if (!force && modelCache && Date.now() - modelCache.loadedAt < MODEL_TTL_MS) return modelCache.model;
  const rows = await query<MeasureCatalogRow>(
    `SELECT MEASURE_CODE, MEASURE_LABEL, UNIT, MEASURE_GROUP, CALC_TYPE, IS_VISIBLE,
            IS_EDITABLE, DISPLAY_ORDER, SOURCE, DESCRIPTION, VERSION_NO, EXPRESSION, AGG_EXPRESSION
     FROM APP.V_MEASURE_CATALOG`,
  );
  if (rows.length === 0) throw new Error("No measures defined. Run snowflake/14-formulas.sql.");
  const model = buildMeasureModel(rows);
  modelCache = { model, loadedAt: Date.now() };
  return model;
}

/** A grid row level: any level of the drill order in use, or the series. */
export type RowLevel = PathLevel | "SERIES_ID";

interface LeafRow {
  SERIES_ID: string;
  WEEK_ID: string;
  SERIES_LABEL: string;
  CATEGORY_NAME: string;
  PRODUCT_NAME: string;
  CUSTOMER_NAME: string;
  CHANNEL_NAME: string;
  PRICE_TIER: string;
  PRODUCT_LINE: string;
  REGION: string;
  ROUTE_TO_CUSTOMER: string;
  DELIVERY_MODE: string;
  CHANNEL_GROUP: string;
  FISCAL_YEAR: number;
  FISCAL_QUARTER: string;
  CALENDAR_MONTH: number;
  CALENDAR_MONTH_NAME: string;
  BASELINE_UNITS: number;
  EVENT_UNITS: number;
  PROMO_UNITS: number;
  STREAM_UNITS: number;
  PLAN_UNITS: number;
  STREAM_VIEW_UNITS: number;
  SCENARIO_UNITS: number | null;
  PRICE_CHANGE_PCT: number | null;
  IS_LOCKED: boolean;
  UNIT_PRICE_EUR: number;
  PART_WEIGHT_KG: number;
  FREIGHT_EUR_PER_CASE: number;
  IMPORT_TARIFF_PCT: number;
  EXCISE_EUR_PER_LPA: number;
  AD_VALOREM_PCT: number;
}

export interface LeafCell {
  seriesId: string;
  weekId: string;
  attrs: Record<RowLevel, string>;
  label: string;
  priceTier: string;
  period: { fiscalYear: number; quarter: string; month: number; monthName: string };
  locked: boolean;
  /** The committed plan for this cell, whatever the scenario says. */
  committedUnits: number;
  inputs: Values;
}

const n = (value: unknown) => Number(value) || 0;

/**
 * Every table the leaf query reads, through V_PLAN_CONTRIBUTION, V_SERIES,
 * V_LANDED_COST and the scenario joins (from GET_OBJECT_REFERENCES). The leaf
 * query costs 2-7 s, almost all of it compiling the nested views, so results
 * are reused while none of these tables has changed. Keep in step with the
 * query below and the views it reads.
 */
const LEAF_TABLES = [
  "CORE.DIM_SERIES", "CORE.DIM_PRODUCT", "CORE.DIM_CATEGORY", "CORE.DIM_CUSTOMER", "CORE.DIM_CHANNEL",
  "CORE.DIM_WEEK", "CORE.DIM_REASON_CODE", "CORE.DIM_DUTY", "CORE.FACT_POS_WEEKLY",
  "ML.FACT_FORECAST", "CORE.FACT_DEMAND_PLAN", "CORE.FACT_PLAN_INPUT", "CORE.FACT_PLAN_EFFECT",
  "CORE.FACT_AGENT_PROPOSAL", "CORE.FACT_AGENT_PROPOSAL_WEEK", "CORE.FACT_AGENT_DECISION",
  "CORE.FACT_SCENARIO_EDIT", "CORE.FACT_SCENARIO_DRIVER",
] as const;
const leafCache = versionedCache<LeafCell[]>(40);

export async function loadLeafCells(params: {
  path: HierarchyPathServer;
  seriesId?: string | null;
  scenarioId?: string | null;
  /** When set, STREAM_VIEW_UNITS is that stream's accepted input for the live cycle, else the statistical forecast. */
  streamId?: string | null;
  weekFrom?: string | null;
  weekTo?: string | null;
}): Promise<LeafCell[]> {
  const key = JSON.stringify([
    params.path, params.seriesId ?? null, params.scenarioId ?? null, params.streamId ?? null,
    params.weekFrom ?? null, params.weekTo ?? null,
  ]);
  const version = await dataVersion(LEAF_TABLES);
  return leafCache(key, version, () => loadLeafCellsUncached(params));
}

async function loadLeafCellsUncached(params: {
  path: HierarchyPathServer;
  seriesId?: string | null;
  scenarioId?: string | null;
  /** When set, STREAM_VIEW_UNITS is that stream's accepted input for the live cycle, else the statistical forecast. */
  streamId?: string | null;
  weekFrom?: string | null;
  weekTo?: string | null;
}): Promise<LeafCell[]> {
  const predicate = hierarchyPredicate(params.path, "c");
  const binds: (string | null)[] = [params.streamId ?? null, params.scenarioId ?? null, params.scenarioId ?? null];
  let weekSql = "";
  if (params.seriesId) {
    weekSql += " AND c.SERIES_ID = ?";
    binds.push(params.seriesId);
  }
  if (params.weekFrom) {
    weekSql += " AND c.WEEK_ID >= ?";
    binds.push(params.weekFrom);
  }
  if (params.weekTo) {
    weekSql += " AND c.WEEK_ID <= ?";
    binds.push(params.weekTo);
  }
  binds.push(...predicate.binds);

  const rows = await query<LeafRow>(
    `SELECT c.SERIES_ID, c.WEEK_ID, s.SERIES_LABEL,
            c.CATEGORY_NAME, c.PRODUCT_NAME, c.CUSTOMER_NAME, c.CHANNEL_NAME, s.PRICE_TIER,
            s.PRODUCT_LINE, s.REGION, s.ROUTE_TO_CUSTOMER, s.DELIVERY_MODE, s.CHANNEL_GROUP,
            w.FISCAL_YEAR, w.FISCAL_QUARTER, w.CALENDAR_MONTH, w.CALENDAR_MONTH_NAME,
            c.BASELINE_UNITS, c.EVENT_UNITS, c.PROMO_UNITS,
            c.SALES_DELTA + c.MARKETING_DELTA + c.FINANCE_DELTA AS STREAM_UNITS,
            c.PLAN_UNITS,
            COALESCE(si.INPUT_UNITS, c.STAT_UNITS) AS STREAM_VIEW_UNITS,
            e.EDIT_UNITS AS SCENARIO_UNITS,
            d.DRIVER_VALUE AS PRICE_CHANGE_PCT,
            p.IS_LOCKED,
            lc.UNIT_PRICE_EUR, lc.PART_WEIGHT_KG, lc.FREIGHT_EUR_PER_CASE, lc.IMPORT_TARIFF_PCT,
            lc.EXCISE_EUR_PER_LPA, lc.AD_VALOREM_PCT
     FROM APP.V_PLAN_CONTRIBUTION c
     JOIN APP.V_SERIES s ON s.SERIES_ID = c.SERIES_ID
     JOIN CORE.DIM_WEEK w ON w.WEEK_ID = c.WEEK_ID
     JOIN CORE.FACT_DEMAND_PLAN p ON p.SERIES_ID = c.SERIES_ID AND p.WEEK_ID = c.WEEK_ID
     JOIN APP.V_LANDED_COST lc ON lc.SERIES_ID = c.SERIES_ID
     LEFT JOIN CORE.FACT_PLAN_INPUT si
       ON si.STREAM_ID = ? AND si.SERIES_ID = c.SERIES_ID AND si.WEEK_ID = c.WEEK_ID
      AND si.CYCLE_WEEK = (SELECT HISTORY_END_WEEK FROM APP.V_CONTEXT)
     LEFT JOIN CORE.FACT_SCENARIO_EDIT e
       ON e.SCENARIO_ID = ? AND e.SERIES_ID = c.SERIES_ID AND e.WEEK_ID = c.WEEK_ID
     LEFT JOIN CORE.FACT_SCENARIO_DRIVER d
       ON d.SCENARIO_ID = ? AND d.SERIES_ID = c.SERIES_ID AND d.WEEK_ID = c.WEEK_ID
      AND d.MEASURE_CODE = 'PRICE_CHANGE_PCT'
      -- A price driver only counts while the scenario still edits that cell:
      -- an edit reverted to the committed plan takes its price with it.
      AND e.SERIES_ID IS NOT NULL
     WHERE 1 = 1 ${weekSql} AND ${predicate.sql}
     ORDER BY c.SERIES_ID, c.WEEK_ID`,
    binds,
  );

  return rows.map((row) => {
    const priceChange = row.PRICE_CHANGE_PCT == null ? 0 : n(row.PRICE_CHANGE_PCT);
    const priceResponse = priceMultiplier(priceChange, row.PRICE_TIER, row.CHANNEL_NAME);
    const effective = row.SCENARIO_UNITS == null ? n(row.PLAN_UNITS) : n(row.SCENARIO_UNITS);
    const beforePrice = priceResponse !== 0 ? effective / priceResponse : effective;
    const attributed = n(row.BASELINE_UNITS) + n(row.EVENT_UNITS) + n(row.PROMO_UNITS) + n(row.STREAM_UNITS);
    return {
      seriesId: row.SERIES_ID,
      weekId: row.WEEK_ID,
      label: row.SERIES_LABEL,
      priceTier: row.PRICE_TIER,
      committedUnits: n(row.PLAN_UNITS),
      attrs: {
        CATEGORY_NAME: row.CATEGORY_NAME,
        PRODUCT_NAME: row.PRODUCT_NAME,
        CUSTOMER_NAME: row.CUSTOMER_NAME,
        CHANNEL_NAME: row.CHANNEL_NAME,
        // Alternate-tree attributes, so rows can be keyed under any roll-up.
        ...Object.fromEntries(ALT_LEVELS.map((level) => [level, row[level]])) as Record<(typeof ALT_LEVELS)[number], string>,
        SERIES_ID: row.SERIES_ID,
      },
      period: {
        fiscalYear: n(row.FISCAL_YEAR),
        quarter: row.FISCAL_QUARTER,
        month: n(row.CALENDAR_MONTH),
        monthName: row.CALENDAR_MONTH_NAME,
      },
      locked: Boolean(row.IS_LOCKED),
      inputs: new Map([
        ["BASELINE_UNITS", n(row.BASELINE_UNITS)],
        ["EVENT_UNITS", n(row.EVENT_UNITS)],
        ["PROMO_UNITS", n(row.PROMO_UNITS)],
        ["STREAM_UNITS", n(row.STREAM_UNITS)],
        ["PLANNER_UNITS", beforePrice - attributed],
        ["STREAM_VIEW_UNITS", params.streamId ? n(row.STREAM_VIEW_UNITS) : 0],
        ["PRICE_CHANGE_PCT", priceChange],
        ["PRICE_RESPONSE", priceResponse],
        ["UNIT_PRICE_EUR", n(row.UNIT_PRICE_EUR)],
        ["PART_WEIGHT_KG", n(row.PART_WEIGHT_KG)],
        ["FREIGHT_EUR_CASE", n(row.FREIGHT_EUR_PER_CASE)],
        ["TARIFF_PCT", n(row.IMPORT_TARIFF_PCT)],
        ["EXCISE_EUR_PER_LPA", n(row.EXCISE_EUR_PER_LPA)],
        ["AD_VALOREM_PCT", n(row.AD_VALOREM_PCT)],
      ]),
    };
  });
}

/** The level the grid rows sit at: the first level of the drill order the path has not fixed. */
export function childLevelFor(path: HierarchyPathServer): RowLevel {
  return pathLevelOrder(path).find((level) => !path[level]) ?? "SERIES_ID";
}

export interface GridColumn {
  key: string;
  label: string;
  kind: "week" | "month" | "quarter" | "total";
  weeks: string[];
}

export interface GridRow {
  key: string;
  label: string;
  level: RowLevel | "NODE";
  isTotal: boolean;
  /** Per column key: per measure code, value (null where not defined at this grain). */
  cells: Record<string, Record<string, number | null>>;
  /** Per column key: share of the column's leaves that are locked (0..1). */
  locked: Record<string, number>;
  leafCount: number;
}

export interface GridMatrix {
  measures: MeasureDef[];
  columns: GridColumn[];
  rows: GridRow[];
  rowLevel: RowLevel;
  leafCount: number;
}

function buildColumns(cells: LeafCell[], rollup: "none" | "month" | "quarter"): GridColumn[] {
  const weeks = [...new Set(cells.map((cell) => cell.weekId))].sort();
  const periodOf = new Map(cells.map((cell) => [cell.weekId, cell.period]));
  const columns: GridColumn[] = [];
  const pushGroup = (key: string, label: string, kind: GridColumn["kind"], groupWeeks: string[]) =>
    columns.push({ key, label, kind, weeks: groupWeeks });

  if (rollup === "none") {
    for (const week of weeks) pushGroup(week, week, "week", [week]);
  } else {
    // Weeks stay visible; a roll-up column follows each month / fiscal quarter.
    let groupKey: string | null = null;
    let groupLabel = "";
    let groupWeeks: string[] = [];
    const flush = () => {
      if (groupKey) pushGroup(groupKey, groupLabel, rollup, groupWeeks);
    };
    for (const week of weeks) {
      const period = periodOf.get(week)!;
      const key = rollup === "month"
        ? `M:${period.fiscalYear}-${String(period.month).padStart(2, "0")}`
        : `Q:FY${period.fiscalYear}-${period.quarter}`;
      const label = rollup === "month" ? period.monthName : `FY${String(period.fiscalYear).slice(2)} ${period.quarter}`;
      if (key !== groupKey) {
        flush();
        groupKey = key;
        groupLabel = label;
        groupWeeks = [];
      }
      groupWeeks.push(week);
      pushGroup(week, week, "week", [week]);
    }
    flush();
  }
  pushGroup("TOTAL", "Horizon", "total", weeks);
  return columns;
}

/**
 * The grid: one total row for the selected node plus one row per child, with
 * a cell per week (and optional month / quarter roll-ups and a horizon total).
 */
export async function buildGridMatrix(params: {
  path: HierarchyPathServer;
  scenarioId?: string | null;
  streamId?: string | null;
  weekFrom?: string | null;
  weekTo?: string | null;
  rollup?: "none" | "month" | "quarter";
  measureCodes?: string[];
  nodeLabel: string;
}): Promise<GridMatrix> {
  const [model, cells] = await Promise.all([loadMeasureModel(), loadLeafCells(params)]);
  const rowLevel = childLevelFor(params.path);
  const columns = buildColumns(cells, params.rollup ?? "none");
  const shareMeasures = ratioMeasures(model);

  // Evaluate each leaf once, then accumulate into (row, column) buckets.
  const evaluated = cells.map((cell) => ({ cell, values: evaluateLeaf(model, cell.inputs) }));
  const childKeys = new Map<string, string>();
  for (const { cell } of evaluated) {
    const key = cell.attrs[rowLevel];
    if (!childKeys.has(key)) childKeys.set(key, rowLevel === "SERIES_ID" ? cell.label : key);
  }
  const columnsOfWeek = new Map<string, string[]>();
  for (const column of columns) {
    for (const week of column.weeks) {
      columnsOfWeek.set(week, [...(columnsOfWeek.get(week) ?? []), column.key]);
    }
  }

  type Bucket = { sums: Values; leaves: number; locked: number };
  const buckets = new Map<string, Map<string, Bucket>>();
  const bucket = (rowKey: string, columnKey: string): Bucket => {
    let byColumn = buckets.get(rowKey);
    if (!byColumn) buckets.set(rowKey, (byColumn = new Map()));
    let entry = byColumn.get(columnKey);
    if (!entry) byColumn.set(columnKey, (entry = { sums: emptySums(model), leaves: 0, locked: 0 }));
    return entry;
  };
  const TOTAL_ROW = "__node__";
  for (const { cell, values } of evaluated) {
    for (const columnKey of columnsOfWeek.get(cell.weekId) ?? []) {
      for (const rowKey of [TOTAL_ROW, cell.attrs[rowLevel]]) {
        const entry = bucket(rowKey, columnKey);
        addInto(model, entry.sums, values);
        entry.leaves += 1;
        if (cell.locked) entry.locked += 1;
      }
    }
  }

  const wanted = new Set(params.measureCodes?.length ? params.measureCodes : model.measures.filter((m) => m.visible).map((m) => m.code));
  const measures = model.measures.filter((measure) => wanted.has(measure.code));

  const rowFor = (rowKey: string, label: string, isTotal: boolean): GridRow => {
    const cellsOut: GridRow["cells"] = {};
    const lockedOut: GridRow["locked"] = {};
    let leafCount = 0;
    for (const column of columns) {
      const entry = buckets.get(rowKey)?.get(column.key);
      const parent = isTotal ? null : buckets.get(TOTAL_ROW)?.get(column.key);
      const parentTotals = new Map<string, number>();
      if (parent) {
        const parentValues = evaluateNode(model, parent.sums);
        for (const share of shareMeasures) {
          const value = parentValues.get(share.parentMeasure);
          if (value != null) parentTotals.set(share.code, value);
        }
      }
      const values = entry ? evaluateNode(model, entry.sums, parentTotals) : null;
      cellsOut[column.key] = Object.fromEntries(measures.map((m) => [m.code, values?.get(m.code) ?? null]));
      lockedOut[column.key] = entry && entry.leaves > 0 ? entry.locked / entry.leaves : 0;
      if (column.kind === "total") leafCount = entry?.leaves ?? 0;
    }
    return { key: isTotal ? "__node__" : rowKey, label, level: isTotal ? "NODE" : rowLevel, isTotal, cells: cellsOut, locked: lockedOut, leafCount };
  };

  const rows: GridRow[] = [rowFor(TOTAL_ROW, params.nodeLabel, true)];
  for (const [key, label] of [...childKeys.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    rows.push(rowFor(key, label, false));
  }
  return { measures, columns, rows, rowLevel, leafCount: cells.length };
}

export interface ReconcileCheck {
  measure: string;
  engine: number;
  reference: number;
  difference: number;
  tolerance: number;
  ok: boolean;
  source: string;
}

/**
 * Independent check that the formulas reproduce the numbers the SQL views
 * already publish, for the committed plan across the whole forward horizon.
 * The reference figures come from different views than the engine's inputs
 * wherever possible, so agreement is evidence, not tautology.
 */
export async function reconcileMeasures(): Promise<{ ok: boolean; checks: ReconcileCheck[]; worstLeafPlanError: number; leaves: number }> {
  const [model, cells, reference] = await Promise.all([
    loadMeasureModel(true),
    loadLeafCells({ path: {} }),
    query<{ PLAN_UNITS: number; PLAN_VALUE_EUR: number; PLAN_LPA: number; DUTY_EUR: number; LANDED_COST_EUR: number }>(
      `SELECT SUM(p.PLAN_UNITS)                         AS PLAN_UNITS,
              SUM(p.PLAN_VALUE_EUR)                     AS PLAN_VALUE_EUR,
              SUM(p.PLAN_UNITS * lc.LPA_PER_CASE)       AS PLAN_LPA,
              SUM(p.PLAN_UNITS * (lc.TARIFF_EUR_CASE + lc.EXCISE_EUR_CASE + lc.AD_VALOREM_EUR_CASE)) AS DUTY_EUR,
              SUM(p.PLAN_UNITS * lc.LANDED_EUR_CASE)    AS LANDED_COST_EUR
       FROM APP.V_PLAN_FORWARD p
       JOIN APP.V_LANDED_COST lc ON lc.SERIES_ID = p.SERIES_ID`,
    ),
  ]);

  const sums = emptySums(model);
  let worstLeafPlanError = 0;
  const planBySeriesWeek = new Map<string, number>();
  const committed = await query<{ SERIES_ID: string; WEEK_ID: string; PLAN_UNITS: number }>(
    `SELECT SERIES_ID, WEEK_ID, PLAN_UNITS FROM CORE.FACT_DEMAND_PLAN`,
  );
  for (const row of committed) planBySeriesWeek.set(`${row.SERIES_ID}|${row.WEEK_ID}`, n(row.PLAN_UNITS));
  for (const cell of cells) {
    const values = evaluateLeaf(model, cell.inputs);
    addInto(model, sums, values);
    const expected = planBySeriesWeek.get(`${cell.seriesId}|${cell.weekId}`) ?? 0;
    worstLeafPlanError = Math.max(worstLeafPlanError, Math.abs((values.get("PLAN_UNITS") ?? 0) - expected));
  }
  const node = evaluateNode(model, sums);
  const ref = reference[0];
  const sources: Record<string, string> = {
    PLAN_UNITS: "V_PLAN_FORWARD.PLAN_UNITS",
    PLAN_VALUE_EUR: "V_PLAN_FORWARD.PLAN_VALUE_EUR",
    PLAN_LPA: "plan x V_LANDED_COST.LPA_PER_CASE",
    DUTY_EUR: "plan x V_LANDED_COST tariff + excise + ad valorem",
    LANDED_COST_EUR: "plan x V_LANDED_COST.LANDED_EUR_CASE",
  };
  const checks = (Object.keys(sources) as (keyof typeof ref)[]).map((measure) => {
    const engine = node.get(measure) ?? NaN;
    const referenceValue = n(ref?.[measure]);
    const tolerance = Math.max(1, Math.abs(referenceValue) * 1e-9);
    const difference = engine - referenceValue;
    return {
      measure,
      engine,
      reference: referenceValue,
      difference,
      tolerance,
      ok: Number.isFinite(engine) && Math.abs(difference) <= tolerance,
      source: sources[measure],
    };
  });
  return {
    ok: checks.every((check) => check.ok) && worstLeafPlanError < 0.005,
    checks,
    worstLeafPlanError,
    leaves: cells.length,
  };
}
