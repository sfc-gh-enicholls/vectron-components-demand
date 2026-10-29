import { findOverlaps, parseGridInput, type GridEdit } from "@/lib/grid-edits";

describe("parseGridInput", () => {
  it("parses plain numbers, thousands separators and decimals", () => {
    expect(parseGridInput("1234")).toBe(1234);
    expect(parseGridInput("1,234.5")).toBe(1234.5);
    expect(parseGridInput(" 0.25 ")).toBe(0.25);
  });

  it("expands k / m / bn suffixes", () => {
    expect(parseGridInput("12k")).toBe(12_000);
    expect(parseGridInput("1.5m")).toBe(1_500_000);
    expect(parseGridInput("2bn")).toBe(2_000_000_000);
  });

  it("evaluates arithmetic with the formula parser, not eval", () => {
    expect(parseGridInput("1200 * 1.05")).toBeCloseTo(1260);
    expect(parseGridInput("(10 + 2) / 4")).toBe(3);
    expect(parseGridInput("-5")).toBe(-5);
  });

  it("treats a trailing % as a percentage", () => {
    expect(parseGridInput("5%")).toBeCloseTo(0.05);
    expect(parseGridInput("-2.5%")).toBeCloseTo(-0.025);
  });

  it("does NOT round: factors and shares keep their precision", () => {
    expect(parseGridInput("1.0375")).toBe(1.0375);
  });

  it("rejects anything that is not arithmetic", () => {
    for (const bad of ["", "abc", "alert(1)", "1;2", "[A]+1", "1e3", "constructor"]) {
      expect(parseGridInput(bad)).toBeNull();
    }
  });
});

describe("findOverlaps", () => {
  const edit = (rowKey: string, isTotal: boolean, weekId: string, measure = "PLAN_UNITS"): GridEdit => ({
    rowKey,
    isTotal,
    weekId,
    measure,
    value: 1,
    previous: 0,
  });

  it("allows sibling rows and different weeks", () => {
    expect(findOverlaps([edit("A", false, "W1"), edit("B", false, "W1"), edit("A", false, "W2")])).toEqual([]);
  });

  it("refuses the node total and a child in the same week", () => {
    expect(findOverlaps([edit("__node__", true, "W1"), edit("A", false, "W1")])).toEqual(["W1"]);
  });

  it("allows the node total and a child in different weeks", () => {
    expect(findOverlaps([edit("__node__", true, "W1"), edit("A", false, "W2")])).toEqual([]);
  });

  it("refuses a total and a child in the same week even on different measures", () => {
    expect(findOverlaps([edit("__node__", true, "W1", "PRICE_CHANGE_PCT"), edit("A", false, "W1")])).toEqual(["W1"]);
  });

  it("refuses a Plan edit and a Price change on the same row and week", () => {
    expect(findOverlaps([edit("A", false, "W1"), edit("A", false, "W1", "PRICE_CHANGE_PCT")])).toEqual(["W1"]);
  });

  it("allows a Plan edit on one row and a Price change on its sibling", () => {
    expect(findOverlaps([edit("A", false, "W1"), edit("B", false, "W1", "PRICE_CHANGE_PCT")])).toEqual([]);
  });
});
