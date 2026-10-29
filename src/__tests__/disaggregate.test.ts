/**
 * Tests for hierarchy disaggregation.
 *
 * The property that matters is EXACTNESS: children must sum back to the parent
 * delta at 2dp, for every basis, with locked children held and the zero floor
 * respected. A proportional split that is merely close would silently break the
 * reconciliation invariant the hierarchy page asserts.
 */
import {
  apportion, disaggregate, disaggregateByPercent,
  type DisaggChild, type DisaggMethod,
} from "@/lib/disaggregate";

const child = (
  id: string, currentUnits: number, statUnits = currentUnits, locked = false,
): DisaggChild => ({ id, currentUnits, statUnits, locked });

const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;

describe("apportion", () => {
  it("distributes a total exactly across equal weights", () => {
    const parts = apportion(100, [1, 1, 1]);
    expect(sum(parts)).toBe(100);
  });

  it("sums exactly where naive rounding would not", () => {
    // 100/3 = 33.333..., which rounds to 33.33 x 3 = 99.99, losing a cent.
    const parts = apportion(100, [1, 1, 1]);
    expect(sum(parts)).toBe(100);
    expect(parts.filter((p) => p === 33.34).length).toBe(1);
    expect(parts.filter((p) => p === 33.33).length).toBe(2);
  });

  it("handles negative totals exactly", () => {
    const parts = apportion(-100, [1, 1, 1]);
    expect(sum(parts)).toBe(-100);
  });

  it("respects proportional weights", () => {
    const parts = apportion(1000, [3, 1]);
    expect(sum(parts)).toBe(1000);
    expect(parts[0]).toBeCloseTo(750, 2);
    expect(parts[1]).toBeCloseTo(250, 2);
  });

  it("splits equally when every weight is zero", () => {
    const parts = apportion(90, [0, 0, 0]);
    expect(sum(parts)).toBe(90);
    expect(parts).toEqual([30, 30, 30]);
  });

  it("returns nothing for no children", () => {
    expect(apportion(50, [])).toEqual([]);
  });

  it("is exact across many awkward totals and weightings", () => {
    // A property test: whatever the split, the parts must reconstitute the total.
    let checked = 0;
    for (let n = 1; n <= 9; n++) {
      for (const total of [1, 7.77, -13.31, 1000.01, -0.03, 99999.99]) {
        const weights = Array.from({ length: n }, (_, i) => (i * 7 + 1) % 11);
        expect(sum(apportion(total, weights))).toBeCloseTo(total, 2);
        checked++;
      }
    }
    expect(checked).toBe(54);
  });
});

describe("disaggregate", () => {
  const kids = () => [
    child("a", 5000, 4800),
    child("b", 3000, 3200),
    child("c", 2000, 2000),
  ];

  it("reports the parent's current total from its children", () => {
    const r = disaggregate(10000, kids(), "current_plan");
    expect(r.parentCurrent).toBe(10000);
    expect(r.targetDelta).toBe(0);
    expect(r.appliedDelta).toBe(0);
    expect(r.feasible).toBe(true);
  });

  it.each<DisaggMethod>(["statistical", "current_plan"])(
    "applies the full delta exactly on the %s basis", (method) => {
      const r = disaggregate(9500, kids(), method);
      expect(r.targetDelta).toBe(-500);
      expect(r.appliedDelta).toBe(-500);
      expect(r.shortfall).toBe(0);
      expect(r.feasible).toBe(true);
      expect(sum(r.children.map((c) => c.deltaUnits))).toBe(-500);
    },
  );

  it("makes children sum to the requested parent total", () => {
    const r = disaggregate(12345.67, kids(), "statistical");
    expect(sum(r.children.map((c) => c.newUnits))).toBe(12345.67);
  });

  it("splits on the statistical baseline, not the current plan", () => {
    // b's statistical share exceeds its plan share, so on the statistical
    // basis it must absorb proportionally more of an increase.
    const stat = disaggregate(11000, kids(), "statistical");
    const plan = disaggregate(11000, kids(), "current_plan");
    const bStat = stat.children.find((c) => c.id === "b")!.deltaUnits;
    const bPlan = plan.children.find((c) => c.id === "b")!.deltaUnits;
    expect(bStat).toBeGreaterThan(bPlan);
  });

  it("holds locked children and absorbs the delta across the rest", () => {
    const withLock = [
      child("a", 5000, 5000),
      child("b", 3000, 3000),
      child("c", 2000, 2000, true),   // locked
    ];
    const r = disaggregate(9000, withLock, "current_plan");
    const c = r.children.find((x) => x.id === "c")!;
    expect(c.deltaUnits).toBe(0);
    expect(c.newUnits).toBe(2000);
    expect(c.excluded).toBe(true);
    expect(r.lockedCount).toBe(1);
    expect(r.lockedUnits).toBe(2000);
    // The full -1000 still lands, just only on a and b.
    expect(r.appliedDelta).toBe(-1000);
    expect(r.feasible).toBe(true);
  });

  it("changes the other children's shares when one is locked", () => {
    const free = disaggregate(9000, kids(), "current_plan");
    const locked = disaggregate(9000, [
      child("a", 5000, 4800), child("b", 3000, 3200), child("c", 2000, 2000, true),
    ], "current_plan");
    const aFree = free.children.find((c) => c.id === "a")!.deltaUnits;
    const aLocked = locked.children.find((c) => c.id === "a")!.deltaUnits;
    // a must take a bigger share once c is held.
    expect(Math.abs(aLocked)).toBeGreaterThan(Math.abs(aFree));
  });

  it("never drives a child below zero, and redistributes the excess", () => {
    // Clamping needs the STATISTICAL basis to bite. On the current-plan basis
    // each child's share is proportional to its own value, so
    // new_i = v_i * (1 + D/V) stays non-negative for any target >= 0 and no
    // child can ever be pushed under. Here "thin" has a large statistical
    // baseline but almost no committed plan, so its proportional share of a
    // reduction is far larger than it can absorb.
    const uneven = [
      child("thick", 10000, 5000),
      child("thin", 10, 5000),
    ];
    const r = disaggregate(5010, uneven, "statistical");
    expect(r.targetDelta).toBe(-5000);

    const thin = r.children.find((c) => c.id === "thin")!;
    expect(thin.newUnits).toBe(0);
    expect(thin.clamped).toBe(true);
    // Its unabsorbed share moved to the child that had room.
    const thick = r.children.find((c) => c.id === "thick")!;
    expect(thick.newUnits).toBe(5010);

    for (const c of r.children) expect(c.newUnits).toBeGreaterThanOrEqual(0);
    expect(r.appliedDelta).toBe(-5000);
    expect(r.feasible).toBe(true);
    expect(sum(r.children.map((c) => c.newUnits))).toBe(5010);
  });

  it("cannot clamp on the current-plan basis for a non-negative target", () => {
    // Documenting the property that makes the case above necessary.
    const r = disaggregate(1, [child("big", 10000), child("tiny", 5)], "current_plan");
    expect(r.children.some((c) => c.clamped)).toBe(false);
    expect(r.feasible).toBe(true);
    for (const c of r.children) expect(c.newUnits).toBeGreaterThanOrEqual(0);
  });

  it("flags the clamped child so the UI can explain it", () => {
    const r = disaggregate(
      600, [child("a", 10000, 1000), child("b", 50, 1000)], "statistical",
    );
    expect(r.children.some((c) => c.clamped)).toBe(true);
    expect(r.feasible).toBe(true);
  });

  it("cascades clamping across several children that cannot absorb their share", () => {
    // Three thin children all need clamping before the thick one takes the rest.
    const many = [
      child("thick", 20000, 1000),
      child("t1", 5, 1000),
      child("t2", 5, 1000),
      child("t3", 5, 1000),
    ];
    const r = disaggregate(4015, many, "statistical");
    expect(r.targetDelta).toBe(-16000);
    expect(r.children.filter((c) => c.clamped).length).toBe(3);
    expect(r.appliedDelta).toBe(-16000);
    expect(r.feasible).toBe(true);
    expect(sum(r.children.map((c) => c.newUnits))).toBe(4015);
    for (const c of r.children) expect(c.newUnits).toBeGreaterThanOrEqual(0);
  });

  it("reports infeasible rather than silently under-applying", () => {
    // Asking for a total below zero cannot be met by children floored at zero.
    const r = disaggregate(-500, kids(), "current_plan");
    expect(r.feasible).toBe(false);
    expect(r.shortfall).not.toBe(0);
    // Every child is at the floor, and nothing went negative.
    for (const c of r.children) expect(c.newUnits).toBe(0);
  });

  it("holds everything and reports infeasible when all children are locked", () => {
    const allLocked = kids().map((c) => ({ ...c, locked: true }));
    const r = disaggregate(9000, allLocked, "current_plan");
    expect(r.eligibleCount).toBe(0);
    expect(r.appliedDelta).toBe(0);
    expect(r.shortfall).toBe(-1000);
    expect(r.feasible).toBe(false);
  });

  it("treats an all-locked no-change request as feasible", () => {
    const allLocked = kids().map((c) => ({ ...c, locked: true }));
    const r = disaggregate(10000, allLocked, "current_plan");
    expect(r.feasible).toBe(true);
  });

  it("shares equally when the chosen basis is zero for everyone", () => {
    const noStat = [child("a", 100, 0), child("b", 100, 0)];
    const r = disaggregate(300, noStat, "statistical");
    expect(r.appliedDelta).toBe(100);
    expect(r.children[0].deltaUnits).toBe(50);
    expect(r.children[1].deltaUnits).toBe(50);
  });

  it("gives a zero-basis child nothing and marks it excluded", () => {
    const mixed = [child("a", 1000, 1000), child("z", 500, 0)];
    const r = disaggregate(1800, mixed, "statistical");
    const z = r.children.find((c) => c.id === "z")!;
    expect(z.deltaUnits).toBe(0);
    expect(z.excluded).toBe(true);
    expect(r.appliedDelta).toBe(300);
  });

  it("handles a single child by giving it the whole delta", () => {
    const r = disaggregate(1500, [child("only", 1000)], "current_plan");
    expect(r.children[0].deltaUnits).toBe(500);
    expect(r.appliedDelta).toBe(500);
  });

  it("is exact over a realistic 18-child Indian Whisky style split", () => {
    const many = Array.from({ length: 18 }, (_, i) =>
      child(`s${i}`, 1000 + i * 137.13, 900 + i * 151.7, i % 7 === 0));
    for (const pct of [-0.05, -0.011, 0.037, 0.5]) {
      const r = disaggregateByPercent(pct, many, "statistical");
      expect(r.appliedDelta).toBe(r.targetDelta);
      expect(r.shortfall).toBe(0);
      expect(sum(r.children.map((c) => c.newUnits)))
        .toBeCloseTo(r.parentTarget, 2);
    }
  });
});

describe("disaggregateByPercent", () => {
  it("converts a percentage into the right absolute target", () => {
    const r = disaggregateByPercent(-0.05, [child("a", 1000), child("b", 1000)], "current_plan");
    expect(r.parentTarget).toBe(1900);
    expect(r.targetDelta).toBe(-100);
    expect(r.appliedDelta).toBe(-100);
  });

  it("treats zero percent as no change", () => {
    const r = disaggregateByPercent(0, [child("a", 1234.56)], "current_plan");
    expect(r.targetDelta).toBe(0);
    expect(r.children[0].newUnits).toBe(1234.56);
  });
});
