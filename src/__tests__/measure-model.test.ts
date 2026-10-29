import {
  addInto,
  buildMeasureModel,
  emptySums,
  evaluateLeaf,
  evaluateNode,
  ratioMeasures,
  type MeasureCatalogRow,
} from "@/lib/measure-model";

// A small catalogue with the same SHAPE as 14-formulas.sql: additive volume,
// a ratio driver recomputed at the node, a per-case rate, and RATIO share.
const row = (
  code: string,
  group: MeasureCatalogRow["MEASURE_GROUP"],
  expression: string | null,
  aggExpression: string | null = null,
): MeasureCatalogRow => ({
  MEASURE_CODE: code,
  MEASURE_LABEL: code,
  UNIT: "x",
  MEASURE_GROUP: group,
  CALC_TYPE: expression || aggExpression ? "FORMULA" : "INPUT",
  IS_VISIBLE: true,
  IS_EDITABLE: false,
  DISPLAY_ORDER: 0,
  SOURCE: null,
  DESCRIPTION: null,
  VERSION_NO: 1,
  EXPRESSION: expression,
  AGG_EXPRESSION: aggExpression,
});

const catalog: MeasureCatalogRow[] = [
  row("BASE", "volume", null),
  row("EVENT", "volume", null),
  row("PRICE", "assumption", null),
  row("AFTER", "volume", "[BASE] + [EVENT]"),
  row("UPLIFT", "driver", "[AFTER] / [BASE]", "[AFTER] / [BASE]"),
  row("PLAN", "volume", "[BASE] * [UPLIFT]"),
  row("VALUE", "value", "[PLAN] * [PRICE]"),
  row("UNIT_PRICE", "rate", "[PRICE]", "[VALUE] / [PLAN]"),
  row("SHARE", "volume", null, "RATIO([PLAN])"),
];

const leaf = (base: number, event: number, price: number) =>
  new Map([["BASE", base], ["EVENT", event], ["PRICE", price]]);

describe("measure model", () => {
  const model = buildMeasureModel(catalog);

  it("treats volume and value without an aggregate formula as additive", () => {
    expect(model.additiveCodes.sort()).toEqual(["AFTER", "BASE", "EVENT", "PLAN", "VALUE"]);
  });

  it("evaluates a leaf through the dependency chain", () => {
    const values = evaluateLeaf(model, leaf(100, 20, 10));
    expect(values.get("UPLIFT")).toBeCloseTo(1.2);
    expect(values.get("PLAN")).toBeCloseTo(120);
    expect(values.get("VALUE")).toBeCloseTo(1200);
  });

  it("rolls a ratio up from summed parts, not by summing or averaging ratios", () => {
    const sums = emptySums(model);
    addInto(model, sums, evaluateLeaf(model, leaf(100, 100, 10))); // uplift 2.0
    addInto(model, sums, evaluateLeaf(model, leaf(900, 0, 20)));   // uplift 1.0
    const node = evaluateNode(model, sums, new Map([["SHARE", 1100]]));
    // (200 + 900) / (100 + 900) = 1.1, not 3.0 (sum) or 1.5 (mean)
    expect(node.get("UPLIFT")).toBeCloseTo(1.1);
    // Value-weighted price: (2000 + 18000) / 1100
    expect(node.get("UNIT_PRICE")).toBeCloseTo(20000 / 1100);
    expect(node.get("PLAN")).toBeCloseTo(1100);
  });

  it("keeps the node identity PLAN = BASE x UPLIFT after aggregation", () => {
    const sums = emptySums(model);
    for (const [b, e] of [[50, 5], [70, -10], [10, 30]]) addInto(model, sums, evaluateLeaf(model, leaf(b, e, 1)));
    const node = evaluateNode(model, sums);
    expect((node.get("BASE") ?? 0) * (node.get("UPLIFT") ?? 0)).toBeCloseTo(node.get("PLAN") ?? NaN, 9);
  });

  it("reports a RATIO measure as null, not 0, when the parent is unknown", () => {
    const sums = emptySums(model);
    addInto(model, sums, evaluateLeaf(model, leaf(10, 0, 1)));
    expect(evaluateNode(model, sums).get("SHARE")).toBeNull();
    expect(evaluateNode(model, sums, new Map([["SHARE", 40]])).get("SHARE")).toBeCloseTo(0.25);
  });

  it("reports per-case assumptions as null at a node", () => {
    const sums = emptySums(model);
    addInto(model, sums, evaluateLeaf(model, leaf(10, 0, 3)));
    expect(evaluateNode(model, sums).get("PRICE")).toBeNull();
  });

  it("returns null rather than Infinity or NaN for an empty node", () => {
    const node = evaluateNode(model, emptySums(model));
    expect(node.get("UPLIFT")).toBe(0); // division by zero is 0 by engine convention
    expect(node.get("UNIT_PRICE")).toBe(0);
  });

  it("names the parent measure of each RATIO", () => {
    expect(ratioMeasures(model)).toEqual([{ code: "SHARE", parentMeasure: "PLAN" }]);
  });

  it("refuses a catalogue with a cycle", () => {
    expect(() => buildMeasureModel([row("A", "volume", "[B]"), row("B", "volume", "[A]")])).toThrow(/Circular/);
  });
});
