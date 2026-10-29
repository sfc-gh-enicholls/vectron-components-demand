/**
 * Measure model: the formulas-as-data catalogue (snowflake/14-formulas.sql)
 * compiled into two formula sets and evaluated over planning cells.
 *
 * PURE: no I/O. The server loader (src/lib/measures.ts) supplies catalogue rows
 * and leaf inputs; this module does the arithmetic, so it can be unit-tested
 * and so the grid and the reconciliation check use exactly the same maths.
 *
 * How a node's value is formed
 * ----------------------------
 * 1. Every leaf cell (series x week) is evaluated with the LEAF formulas
 *    (EXPRESSION). Measures with no leaf expression are inputs.
 * 2. A node (any set of leaves: a category in a week, a series over a month)
 *    first SUMS the additive measures (groups volume and value) across its
 *    leaves.
 * 3. It then evaluates the AGGREGATE formulas (AGG_EXPRESSION) on those sums.
 *    That is how a ratio rolls up correctly: a category's event uplift is its
 *    summed after-event volume over its summed baseline, never a sum or mean
 *    of its series' uplifts.
 * 4. A measure with neither an aggregate formula nor an additive group (a
 *    per-case assumption such as freight) has no value at a node and is null.
 */
import {
  compileFormulas,
  evaluateCompiled,
  type CompiledFormulas,
  type FormulaRow,
} from "@/lib/calc-engine";

export type MeasureGroup = "volume" | "driver" | "value" | "rate" | "assumption";

export interface MeasureCatalogRow {
  MEASURE_CODE: string;
  MEASURE_LABEL: string;
  UNIT: string;
  MEASURE_GROUP: MeasureGroup;
  CALC_TYPE: "INPUT" | "FORMULA";
  IS_VISIBLE: boolean;
  IS_EDITABLE: boolean;
  DISPLAY_ORDER: number;
  SOURCE: string | null;
  DESCRIPTION: string | null;
  VERSION_NO: number | null;
  EXPRESSION: string | null;
  AGG_EXPRESSION: string | null;
}

export interface MeasureDef {
  code: string;
  label: string;
  unit: string;
  group: MeasureGroup;
  calcType: "INPUT" | "FORMULA";
  visible: boolean;
  editable: boolean;
  order: number;
  source: string | null;
  description: string | null;
  version: number | null;
  expression: string | null;
  aggExpression: string | null;
  /** Summed across leaves when a node is formed. */
  additive: boolean;
}

export interface MeasureModel {
  measures: MeasureDef[];
  byCode: Map<string, MeasureDef>;
  leaf: CompiledFormulas;
  aggregate: CompiledFormulas;
  additiveCodes: string[];
}

const ADDITIVE_GROUPS: MeasureGroup[] = ["volume", "value"];

export function toMeasureDefs(rows: MeasureCatalogRow[]): MeasureDef[] {
  return rows
    .map((row) => ({
      code: row.MEASURE_CODE,
      label: row.MEASURE_LABEL,
      unit: row.UNIT,
      group: row.MEASURE_GROUP,
      calcType: row.CALC_TYPE,
      visible: Boolean(row.IS_VISIBLE),
      editable: Boolean(row.IS_EDITABLE),
      order: Number(row.DISPLAY_ORDER) || 0,
      source: row.SOURCE,
      description: row.DESCRIPTION,
      version: row.VERSION_NO == null ? null : Number(row.VERSION_NO),
      expression: row.EXPRESSION,
      aggExpression: row.AGG_EXPRESSION,
      // A measure with an aggregate formula is recomputed at the node, not summed.
      additive: ADDITIVE_GROUPS.includes(row.MEASURE_GROUP) && !row.AGG_EXPRESSION,
    }))
    .sort((left, right) => left.order - right.order || left.code.localeCompare(right.code));
}

export function buildMeasureModel(rows: MeasureCatalogRow[]): MeasureModel {
  const measures = toMeasureDefs(rows);
  const leafRows: FormulaRow[] = measures
    .filter((measure) => measure.expression)
    .map((measure) => ({ code: measure.code, calcType: "FORMULA", expression: measure.expression, isActive: true }));
  const aggRows: FormulaRow[] = measures
    .filter((measure) => measure.aggExpression)
    .map((measure) => ({ code: measure.code, calcType: "FORMULA", expression: measure.aggExpression, isActive: true }));
  return {
    measures,
    byCode: new Map(measures.map((measure) => [measure.code, measure])),
    leaf: compileFormulas(leafRows),
    aggregate: compileFormulas(aggRows),
    additiveCodes: measures.filter((measure) => measure.additive).map((measure) => measure.code),
  };
}

export type Values = Map<string, number>;

/** Evaluate one leaf cell from its input values. */
export function evaluateLeaf(model: MeasureModel, inputs: Values): Values {
  return evaluateCompiled(model.leaf, inputs).values;
}

/** Running sums of the additive measures, built up leaf by leaf. */
export function emptySums(model: MeasureModel): Values {
  return new Map(model.additiveCodes.map((code) => [code, 0]));
}

export function addInto(model: MeasureModel, sums: Values, leaf: Values): void {
  for (const code of model.additiveCodes) {
    sums.set(code, (sums.get(code) ?? 0) + (leaf.get(code) ?? 0));
  }
}

/**
 * Evaluate a node from the sums of its leaves. `parentPlan` is the parent
 * node's value for every RATIO formula; pass it whenever one is known. Without
 * it, measures that need a parent come back null rather than as a wrong 0.
 */
export function evaluateNode(
  model: MeasureModel,
  sums: Values,
  parentTotals?: Map<string, number>,
): Map<string, number | null> {
  const needsParent = [...model.aggregate.formulas.entries()]
    .filter(([, formula]) => formula.needsParent)
    .map(([code]) => code);
  const totals = new Map(parentTotals ?? []);
  // A RATIO formula with no parent supplied is evaluated against 0 (returns 0)
  // and then reported as null, so the engine never throws for a missing parent
  // and the caller never sees a fabricated share.
  const missingParent = needsParent.filter((code) => !totals.has(code));
  for (const code of missingParent) totals.set(code, 0);

  const { values } = evaluateCompiled(model.aggregate, sums, { parentTotals: totals });
  const out = new Map<string, number | null>();
  for (const measure of model.measures) {
    if (missingParent.includes(measure.code)) {
      out.set(measure.code, null);
    } else if (measure.aggExpression || measure.additive) {
      const value = values.get(measure.code);
      out.set(measure.code, value === undefined || !Number.isFinite(value) ? null : value);
    } else {
      out.set(measure.code, null);
    }
  }
  return out;
}

/** The measures whose aggregate formula needs a parent total (RATIO). */
export function ratioMeasures(model: MeasureModel): { code: string; parentMeasure: string }[] {
  return [...model.aggregate.formulas.entries()]
    .filter(([, formula]) => formula.needsParent)
    .map(([code, formula]) => ({ code, parentMeasure: formula.refs[0] ?? "PLAN_UNITS" }));
}
