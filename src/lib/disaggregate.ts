/**
 * Disaggregating a parent-node edit down to its children.
 *
 * PURE. No I/O. Used by the hierarchy edit API, the agent when it proposes at a
 * node rather than a series, and the tests.
 *
 * This looks like a one-line proportional split and is not. Three things make
 * it a correctness problem rather than an arithmetic one:
 *
 *  1. ROUNDING DOES NOT SUM. Splitting a delta proportionally and rounding each
 *     share to 2dp leaves the children not adding up to the parent. The
 *     hierarchy page exists to assert that children reconcile to their parent,
 *     so a naive split would silently break the very invariant the page is for.
 *     Fixed with largest-remainder apportionment.
 *
 *  2. LOCKED CHILDREN CANNOT MOVE. Their volume must be held and the whole
 *     delta absorbed by the rest, which changes every other child's share.
 *
 *  3. A PLAN CANNOT GO NEGATIVE. A large reduction can push a small child below
 *     zero. Clamping it there orphans the difference, so the excess has to be
 *     redistributed across the children that still have room — iteratively,
 *     because redistributing can push the next child under too.
 *
 *     Worth knowing WHEN this bites: on the 'current_plan' basis it cannot.
 *     Each child's share is proportional to its own value, so
 *     new_i = v_i * (1 + D/V), which stays non-negative for any target >= 0.
 *     Clamping is a 'statistical' basis concern, where a child's share of the
 *     change is unrelated to how much plan it actually holds.
 *
 * If the requested total is unreachable (every eligible child floored at zero),
 * the result says so via `feasible: false` and reports the `shortfall` rather
 * than quietly returning something that does not add up.
 */

export type DisaggMethod = "statistical" | "current_plan";

export interface DisaggChild {
  /** Stable key — a series id, or a series+week composite. */
  id: string;
  /** The committed plan value this child holds today. */
  currentUnits: number;
  /** The statistical baseline for this child, used by the 'statistical' basis. */
  statUnits: number;
  locked: boolean;
}

export interface DisaggChildResult {
  id: string;
  currentUnits: number;
  newUnits: number;
  deltaUnits: number;
  locked: boolean;
  /** True when this child received nothing: locked, or no basis to share on. */
  excluded: boolean;
  /** True when the zero floor bit and this child absorbed less than its share. */
  clamped: boolean;
}

export interface DisaggOutcome {
  children: DisaggChildResult[];
  parentCurrent: number;
  parentTarget: number;
  /** What we set out to move. */
  targetDelta: number;
  /** What the children actually absorbed. Equals targetDelta when feasible. */
  appliedDelta: number;
  /** Non-zero only when the request could not be satisfied. */
  shortfall: number;
  lockedCount: number;
  lockedUnits: number;
  eligibleCount: number;
  basis: DisaggMethod;
  feasible: boolean;
}

/** Money-safe rounding to 2dp, avoiding the usual float surprises. */
function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Largest-remainder apportionment at 2dp.
 *
 * Distributes `total` across `weights` so the parts sum to `total` EXACTLY at
 * 2dp. Works for negative totals: flooring toward negative infinity keeps every
 * remainder in [0,1), so the same "give the spare units to the largest
 * remainders" rule applies unchanged.
 */
export function apportion(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];

  const weightSum = weights.reduce((s, w) => s + w, 0);
  // With no basis to divide on, share equally rather than dividing by zero.
  const effective = weightSum > 0 ? weights : new Array<number>(n).fill(1);
  const effectiveSum = weightSum > 0 ? weightSum : n;

  // Work in integer hundredths so the sum constraint is exact.
  const targetUnits = Math.round(total * 100);
  const rawUnits = effective.map((w) => (targetUnits * w) / effectiveSum);
  const floored = rawUnits.map((u) => Math.floor(u));
  const distributed = floored.reduce((s, u) => s + u, 0);

  let remaining = targetUnits - distributed;
  // remaining is in [0, n) by construction, so this terminates.
  const order = rawUnits
    .map((u, i) => ({ i, frac: u - Math.floor(u) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = floored.slice();
  let k = 0;
  while (remaining > 0 && k < order.length) {
    out[order[k].i] += 1;
    remaining -= 1;
    k += 1;
  }
  // Defensive: if rounding left more units than children, keep going round.
  while (remaining > 0) {
    out[order[remaining % order.length].i] += 1;
    remaining -= 1;
  }

  return out.map((u) => u / 100);
}

/**
 * Spread a new parent total across its children.
 *
 * `parentTarget` is the absolute total wanted for the node, including any locked
 * children — that is what a planner types into the box.
 */
export function disaggregate(
  parentTarget: number,
  children: DisaggChild[],
  method: DisaggMethod,
): DisaggOutcome {
  const parentCurrent = round2(
    children.reduce((s, c) => s + c.currentUnits, 0),
  );
  const locked = children.filter((c) => c.locked);
  const lockedUnits = round2(locked.reduce((s, c) => s + c.currentUnits, 0));
  const targetDelta = round2(parentTarget - parentCurrent);

  const eligible = children.filter((c) => !c.locked);

  // Nothing can move: report honestly instead of pretending.
  if (eligible.length === 0) {
    return {
      children: children.map((c) => ({
        id: c.id,
        currentUnits: c.currentUnits,
        newUnits: c.currentUnits,
        deltaUnits: 0,
        locked: c.locked,
        excluded: true,
        clamped: false,
      })),
      parentCurrent,
      parentTarget,
      targetDelta,
      appliedDelta: 0,
      shortfall: targetDelta,
      lockedCount: locked.length,
      lockedUnits,
      eligibleCount: 0,
      basis: method,
      feasible: targetDelta === 0,
    };
  }

  const basisOf = (c: DisaggChild) =>
    Math.max(0, method === "statistical" ? c.statUnits : c.currentUnits);

  // Iteratively apportion, clamping any child that would go negative and
  // re-apportioning its unabsorbed share across those still able to move.
  const clampedIds = new Set<string>();
  const assigned = new Map<string, number>();
  let feasible = true;

  for (let pass = 0; pass < eligible.length + 1; pass++) {
    const movable = eligible.filter((c) => !clampedIds.has(c.id));
    if (movable.length === 0) {
      feasible = false;
      break;
    }

    // Volume already fixed by clamped children this pass.
    const clampedDelta = eligible
      .filter((c) => clampedIds.has(c.id))
      .reduce((s, c) => s + (assigned.get(c.id) ?? 0), 0);

    const remainingDelta = round2(targetDelta - clampedDelta);
    const parts = apportion(remainingDelta, movable.map(basisOf));

    let newlyClamped = false;
    movable.forEach((c, i) => {
      const delta = parts[i];
      if (c.currentUnits + delta < 0) {
        // Take this child to exactly zero and freeze it.
        assigned.set(c.id, round2(-c.currentUnits));
        clampedIds.add(c.id);
        newlyClamped = true;
      } else {
        assigned.set(c.id, delta);
      }
    });

    if (!newlyClamped) break;
  }

  const results: DisaggChildResult[] = children.map((c) => {
    if (c.locked) {
      return {
        id: c.id,
        currentUnits: c.currentUnits,
        newUnits: c.currentUnits,
        deltaUnits: 0,
        locked: true,
        excluded: true,
        clamped: false,
      };
    }
    const delta = assigned.get(c.id) ?? 0;
    return {
      id: c.id,
      currentUnits: c.currentUnits,
      newUnits: round2(c.currentUnits + delta),
      deltaUnits: delta,
      locked: false,
      excluded: delta === 0 && targetDelta !== 0 && basisOf(c) === 0,
      clamped: clampedIds.has(c.id),
    };
  });

  const appliedDelta = round2(
    results.reduce((s, r) => s + r.deltaUnits, 0),
  );

  return {
    children: results,
    parentCurrent,
    parentTarget,
    targetDelta,
    appliedDelta,
    shortfall: round2(targetDelta - appliedDelta),
    lockedCount: locked.length,
    lockedUnits,
    eligibleCount: eligible.length,
    basis: method,
    feasible: feasible && round2(targetDelta - appliedDelta) === 0,
  };
}

/**
 * Convenience wrapper for a percentage edit, which is how a planner usually
 * thinks ("take Indian Whisky down five percent").
 */
export function disaggregateByPercent(
  pct: number,
  children: DisaggChild[],
  method: DisaggMethod,
): DisaggOutcome {
  const parentCurrent = children.reduce((s, c) => s + c.currentUnits, 0);
  return disaggregate(round2(parentCurrent * (1 + pct)), children, method);
}
