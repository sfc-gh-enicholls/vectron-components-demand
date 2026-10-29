import {
  compileFormulas,
  evaluate,
  evaluateAll,
  evaluateCompiled,
  parseExpression,
  topoSort,
  validateFormula,
  type FormulaRow,
} from "@/lib/calc-engine";

const f = (code: string, expression: string | null, calcType: FormulaRow["calcType"] = "FORMULA"): FormulaRow => ({
  code,
  calcType,
  expression,
  isActive: true,
});

const run = (expression: string, values: Record<string, number> = {}) => {
  const parsed = parseExpression(expression);
  if (!parsed.ast) throw new Error(parsed.error ?? "no ast");
  return evaluate(parsed.ast, new Map(Object.entries(values)));
};

describe("parser", () => {
  it("respects precedence and parentheses", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("10 - 4 - 3")).toBe(3);
    expect(run("12 / 3 / 2")).toBe(2);
  });

  it("handles unary minus, including repeated", () => {
    expect(run("-[A] * [B]", { A: 2, B: 5 })).toBe(-10);
    expect(run("--[A]", { A: 4 })).toBe(4);
    expect(run("[A] - -1", { A: 4 })).toBe(5);
  });

  it("extracts every reference once", () => {
    expect(parseExpression("SUM([A], [B] * [A], LAG([C], 1))").refs.sort()).toEqual(["A", "B", "C"]);
  });

  it("FIX 2: rejects trailing tokens instead of ignoring them", () => {
    expect(parseExpression("[A] [B]").error).toMatch(/after the end/);
    expect(parseExpression("[A] )").error).toMatch(/after the end/);
  });

  it("FIX 3: rejects a malformed number", () => {
    expect(parseExpression("1.2.3").error).toMatch(/Malformed number/);
  });

  it("FIX 4: requires bracketed references, so a hyphen is always subtraction", () => {
    expect(parseExpression("UNITS-RETURNS").error).toMatch(/Wrap measure references in brackets/);
    expect(run("[UNITS]-[RETURNS]", { UNITS: 10, RETURNS: 3 })).toBe(7);
    // Codes with hyphens are still fine INSIDE brackets.
    expect(run("[rev-gross] * 2", { "rev-gross": 5 })).toBe(10);
  });

  it("FIX 5: LAG and CUMULATE take a single reference", () => {
    expect(parseExpression("LAG([A] + [B], 1)").error).toMatch(/single \[reference\]/);
    expect(parseExpression("CUMULATE(2 * [A])").error).toMatch(/single \[reference\]/);
    expect(parseExpression("LAG([A], 0)").error).toMatch(/positive whole number/);
    expect(parseExpression("LAG([A], 1.5)").error).toMatch(/positive whole number/);
  });

  it("reports unknown functions and empty references", () => {
    expect(parseExpression("MAX([A])").error).toMatch(/not a function/);
    expect(parseExpression("[] + 1").error).toMatch(/Empty reference/);
    expect(parseExpression("[A").error).toMatch(/Unclosed/);
  });
});

describe("evaluate", () => {
  it("returns 0 on division by zero and for unknown references", () => {
    expect(run("[A] / [B]", { A: 5, B: 0 })).toBe(0);
    expect(run("[MISSING] + 1")).toBe(1);
  });

  it("evaluates IIF on non-zero", () => {
    expect(run("IIF([A], 10, 20)", { A: 0 })).toBe(20);
    expect(run("IIF([A], 10, 20)", { A: -1 })).toBe(10);
  });

  it("reads LAG by period and CUMULATE as prior cumulative plus current", () => {
    const parsed = parseExpression("LAG([A], 2) + CUMULATE([A])");
    const value = evaluate(parsed.ast!, new Map([["A", 5]]), {
      lagValues: new Map([["A@2", 100], ["A__cumulate", 40]]),
    });
    expect(value).toBe(145);
  });
});

describe("topoSort", () => {
  it("orders dependencies before dependants, in tiers", () => {
    const { tiers, cycles } = topoSort(new Map([
      ["C", ["A", "B"]],
      ["B", ["A"]],
      ["A", []],
    ]));
    expect(cycles).toEqual([]);
    expect(tiers).toEqual([["A"], ["B"], ["C"]]);
  });

  it("counts a dependency referenced twice only once", () => {
    const { order, cycles } = topoSort(new Map([["B", ["A", "A"]], ["A", []]]));
    expect(cycles).toEqual([]);
    expect(order).toEqual(["A", "B"]);
  });

  it("reports the cycle itself, not nodes downstream of it", () => {
    const { cycles } = topoSort(new Map([
      ["A", ["B"]],
      ["B", ["A"]],
      ["C", ["A"]],
    ]));
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(["A", "B"]));
  });
});

describe("evaluateAll", () => {
  const formulas = [
    f("UNITS", null, "INPUT"),
    f("PRICE", null, "INPUT"),
    f("REVENUE", "[UNITS] * [PRICE]"),
    f("NET", "[REVENUE] - [DISCOUNT]"),
    f("DISCOUNT", "[REVENUE] * 0.1"),
  ];

  it("evaluates in dependency order regardless of row order", () => {
    const { values, order } = evaluateAll(formulas, new Map([["UNITS", 10], ["PRICE", 20]]));
    expect(values.get("REVENUE")).toBe(200);
    expect(values.get("DISCOUNT")).toBe(20);
    expect(values.get("NET")).toBe(180);
    expect(order.indexOf("DISCOUNT")).toBeLessThan(order.indexOf("NET"));
  });

  it("records lineage with the input values each formula saw", () => {
    const { lineage } = evaluateAll(formulas, new Map([["UNITS", 10], ["PRICE", 20]]), { withLineage: true });
    const net = lineage.find((entry) => entry.code === "NET");
    expect(net).toMatchObject({ inputs: { REVENUE: 200, DISCOUNT: 20 }, result: 180 });
  });

  it("throws on a cycle", () => {
    expect(() => evaluateAll([f("A", "[B] + 1"), f("B", "[A] + 1")], new Map())).toThrow(/Circular dependency/);
    expect(() => evaluateAll([f("A", "[A] + 1")], new Map())).toThrow(/Circular dependency/);
  });

  it("FIX 6: throws on an unparseable formula instead of skipping it", () => {
    expect(() => evaluateAll([f("A", "[B] +"), f("C", "[A] * 2")], new Map())).toThrow(/Formula \[A\] does not parse/);
  });

  it("FIX 7: throws on duplicate active codes, ignores inactive ones", () => {
    expect(() => evaluateAll([f("A", "1"), f("A", "2")], new Map())).toThrow(/Duplicate active formula/);
    const values = evaluateAll([f("A", "1"), { ...f("A", "2"), isActive: false }], new Map()).values;
    expect(values.get("A")).toBe(1);
  });

  it("ignores inactive formulas", () => {
    const { values } = evaluateAll([{ ...f("A", "5"), isActive: false }], new Map([["A", 1]]));
    expect(values.get("A")).toBe(1);
  });

  it("compiles once and evaluates many cells identically", () => {
    const compiled = compileFormulas(formulas);
    const cells = [[1, 2], [3, 4], [0, 9]].map(([units, price]) =>
      evaluateCompiled(compiled, new Map([["UNITS", units], ["PRICE", price]])).values.get("NET"),
    );
    expect(cells).toEqual([1.8, 10.8, 0]);
  });
});

describe("RATIO (FIX 1)", () => {
  const share = [f("UNITS", null, "INPUT"), f("SHARE", "RATIO([UNITS])")];

  it("divides by the parent total supplied for the formula", () => {
    const { values } = evaluateAll(share, new Map([["UNITS", 25]]), {
      parentTotals: new Map([["SHARE", 200]]),
    });
    expect(values.get("SHARE")).toBe(0.125);
  });

  it("throws when no parent total is supplied, instead of answering 0", () => {
    expect(() => evaluateAll(share, new Map([["UNITS", 25]]))).toThrow(/no parent total was supplied/);
  });

  it("returns 0 for a zero parent, consistent with division by zero", () => {
    const { values } = evaluateAll(share, new Map([["UNITS", 25]]), { parentTotals: new Map([["SHARE", 0]]) });
    expect(values.get("SHARE")).toBe(0);
  });

  it("finds RATIO nested inside other expressions", () => {
    const nested = [f("UNITS", null, "INPUT"), f("SHARE_PCT", "100 * IIF(1, RATIO([UNITS]), 0)")];
    expect(() => evaluateAll(nested, new Map([["UNITS", 1]]))).toThrow(/RATIO/);
  });
});

describe("validateFormula", () => {
  const existing = [f("B", "[A] * 2"), f("C", "[B] + 1")];
  const known = new Set(["A", "B", "C", "D"]);

  it("accepts a valid formula and reports its tier", () => {
    expect(validateFormula("D", "[C] * 3", known, existing)).toMatchObject({ valid: true, tier: 3 });
  });

  it("rejects unknown references and self-reference", () => {
    expect(validateFormula("D", "[Z] + 1", known, existing).errors[0]).toMatch(/Unknown measure reference: \[Z\]/);
    expect(validateFormula("D", "[D] + 1", known, existing).errors[0]).toMatch(/cannot reference itself/);
  });

  it("FIX 8: catches a cycle the candidate itself would create", () => {
    // Redefining A in terms of C closes A -> C -> B -> A.
    const result = validateFormula("A", "[C] - 1", known, existing);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Circular dependency/);
  });

  it("reports parse errors", () => {
    expect(validateFormula("D", "[A] *", known, existing).errors[0]).toMatch(/Parse error/);
  });
});
