/**
 * Scenario recalculation.
 *
 * PURE. No I/O, no database, no clock. The API route and the unit tests call
 * exactly this code, which is the property that stops a simulated result from
 * drifting away from a committed one.
 *
 * ON THE ELASTICITIES
 * -------------------
 * The coefficients below are ASSUMPTIONS held in one place, not estimates
 * fitted per series. They are deliberately the same assumptions the dataset
 * was generated from, so a scenario response is coherent with the driver
 * attribution shown on the review page — if they disagreed, the app would
 * explain a number one way and simulate it another.
 *
 * A production deployment would estimate a price elasticity per series from
 * its own price history and confidence-interval it. Anything derived from
 * these numbers inherits their status as assumptions, and the UI says so.
 */

import assumptions from "./elasticity.json";

/**
 * The constants below are re-exported from elasticity.json rather than written
 * here, because scripts/agent.py reads the same file to quantify its price
 * proposals. Two copies of an elasticity table would eventually disagree, and
 * the agent would then justify a number the UI explains differently.
 */

/** Price elasticity of demand by price tier. Negative: price up, volume down. */
export const TIER_ELASTICITY: Record<string, number> = assumptions.tierElasticity;

/**
 * Channel adjustment on price elasticity. OE volume is set by the OEM's build
 * schedule, not Vectron's price (near zero); garages buying through the
 * independent aftermarket shop around (above one).
 */
export const CHANNEL_PRICE_MULTIPLIER: Record<string, number> =
  assumptions.channelPriceMultiplier;

/**
 * Sensitivity of demand to a one-point move in vehicle sentiment, by tier.
 * Mechatronic content sits on premium trims and EVs, which are cut first in a
 * slowdown, so it is the most exposed.
 */
export const TIER_MACRO_SENSITIVITY: Record<string, number> =
  assumptions.tierMacroSensitivity;

/** Distribution response is strongly diminishing: doubling listings does not double volume. */
export const DISTRIBUTION_EXPONENT = assumptions.distributionExponent;

/** Incremental display and visibility effect of being on promotion, beyond the price cut. */
export const PROMO_VISIBILITY_UPLIFT = assumptions.promoVisibilityUplift;

export interface ScenarioLevers {
  /** Fractional change to list price, e.g. 0.05 for +5%. */
  priceChangePct: number;
  /** Promotional discount depth to apply, e.g. 0.20 for 20% off. 0 disables. */
  promoDepthPct: number;
  /** Fractional change in distribution points, e.g. -0.10 for a 10% listing loss. */
  distributionChangePct: number;
  /** Points of consumer-confidence shift, e.g. -8 for a downturn. */
  macroShiftPoints: number;
}

export const NO_CHANGE: ScenarioLevers = {
  priceChangePct: 0,
  promoDepthPct: 0,
  distributionChangePct: 0,
  macroShiftPoints: 0,
};

export interface ScenarioSeriesInput {
  seriesId: string;
  priceTier: string;
  channelName: string;
  exwPriceEurCase: number;
  /** Baseline committed plan per week, in pieces. */
  weeks: Array<{ weekId: string; planUnits: number; lower95: number | null; upper95: number | null }>;
}

export interface LeverEffect {
  lever: string;
  label: string;
  multiplier: number;
  deltaUnits: number;
}

export interface ScenarioSeriesResult {
  seriesId: string;
  baselineUnits: number;
  scenarioUnits: number;
  baselineValueEur: number;
  scenarioValueEur: number;
  effects: LeverEffect[];
  weeks: Array<{ weekId: string; baselineUnits: number; scenarioUnits: number }>;
}

/** Clamp a multiplier into a defensible range so an extreme lever cannot produce nonsense. */
function clampMultiplier(m: number): number {
  return Math.min(Math.max(m, 0.05), 5);
}

export function priceMultiplier(
  priceChangePct: number, priceTier: string, channelName: string,
): number {
  if (priceChangePct === 0) return 1;
  const elasticity =
    (TIER_ELASTICITY[priceTier] ?? -1.0) *
    (CHANNEL_PRICE_MULTIPLIER[channelName] ?? 1.0);
  // Constant-elasticity form: (1 + dP)^e. Preferred over the linear
  // approximation 1 + e*dP because it stays positive for large price moves.
  return clampMultiplier(Math.pow(1 + priceChangePct, elasticity));
}

export function promoMultiplier(
  promoDepthPct: number, priceTier: string, channelName: string,
): number {
  if (promoDepthPct <= 0) return 1;
  const elasticity =
    (TIER_ELASTICITY[priceTier] ?? -1.0) *
    (CHANNEL_PRICE_MULTIPLIER[channelName] ?? 1.0);
  // A discount is a price cut plus a visibility effect from being featured.
  const priceEffect = Math.pow(1 - promoDepthPct, elasticity);
  return clampMultiplier(priceEffect + PROMO_VISIBILITY_UPLIFT);
}

export function distributionMultiplier(distributionChangePct: number): number {
  if (distributionChangePct === 0) return 1;
  const ratio = Math.max(0.01, 1 + distributionChangePct);
  return clampMultiplier(Math.pow(ratio, DISTRIBUTION_EXPONENT));
}

export function macroMultiplier(macroShiftPoints: number, priceTier: string): number {
  if (macroShiftPoints === 0) return 1;
  const sensitivity = TIER_MACRO_SENSITIVITY[priceTier] ?? 0.007;
  return clampMultiplier(1 + sensitivity * macroShiftPoints);
}

/**
 * Apply the levers to one series.
 *
 * Effects are reported the same way the driver attribution decomposes history:
 * sequentially, each lever credited with its incremental effect given the
 * levers already applied. The order is fixed and the split is not symmetric,
 * which the UI states rather than implying a Shapley-style allocation.
 */
export function applyScenarioToSeries(
  input: ScenarioSeriesInput, levers: ScenarioLevers,
): ScenarioSeriesResult {
  const baselineUnits = input.weeks.reduce((s, w) => s + w.planUnits, 0);

  const steps: Array<{ lever: string; label: string; multiplier: number }> = [
    {
      lever: "price",
      label: "Price change",
      multiplier: priceMultiplier(levers.priceChangePct, input.priceTier, input.channelName),
    },
    {
      lever: "promo",
      label: "Promotional depth",
      multiplier: promoMultiplier(levers.promoDepthPct, input.priceTier, input.channelName),
    },
    {
      lever: "distribution",
      label: "Distribution change",
      multiplier: distributionMultiplier(levers.distributionChangePct),
    },
    {
      lever: "macro",
      label: "Consumer confidence",
      multiplier: macroMultiplier(levers.macroShiftPoints, input.priceTier),
    },
  ];

  let running = baselineUnits;
  const effects: LeverEffect[] = steps.map((s) => {
    const delta = running * (s.multiplier - 1);
    running += delta;
    return { ...s, deltaUnits: delta };
  });

  const totalMultiplier = baselineUnits > 0 ? running / baselineUnits : 1;
  const scenarioPrice = input.exwPriceEurCase * (1 + levers.priceChangePct) *
    (1 - levers.promoDepthPct);

  return {
    seriesId: input.seriesId,
    baselineUnits,
    scenarioUnits: running,
    baselineValueEur: baselineUnits * input.exwPriceEurCase,
    // Value moves with BOTH volume and realised price. Showing a volume gain
    // from a discount without the price give-back would flatter every scenario.
    scenarioValueEur: running * scenarioPrice,
    effects,
    weeks: input.weeks.map((w) => ({
      weekId: w.weekId,
      baselineUnits: w.planUnits,
      scenarioUnits: w.planUnits * totalMultiplier,
    })),
  };
}

export interface ScenarioTotals {
  baselineUnits: number;
  scenarioUnits: number;
  deltaUnits: number;
  deltaUnitsPct: number;
  baselineValueEur: number;
  scenarioValueEur: number;
  deltaValueEur: number;
  deltaValuePct: number;
  effects: LeverEffect[];
  weeks: Array<{ weekId: string; baselineUnits: number; scenarioUnits: number }>;
  seriesCount: number;
}

/** Aggregate a scenario across many series. */
export function runScenario(
  inputs: ScenarioSeriesInput[], levers: ScenarioLevers,
): { totals: ScenarioTotals; perSeries: ScenarioSeriesResult[] } {
  const perSeries = inputs.map((i) => applyScenarioToSeries(i, levers));

  const effectMap = new Map<string, LeverEffect>();
  const weekMap = new Map<string, { baselineUnits: number; scenarioUnits: number }>();

  let baselineUnits = 0, scenarioUnits = 0;
  let baselineValueEur = 0, scenarioValueEur = 0;

  for (const r of perSeries) {
    baselineUnits += r.baselineUnits;
    scenarioUnits += r.scenarioUnits;
    baselineValueEur += r.baselineValueEur;
    scenarioValueEur += r.scenarioValueEur;
    for (const e of r.effects) {
      const cur = effectMap.get(e.lever);
      if (cur) {
        cur.deltaUnits += e.deltaUnits;
      } else {
        effectMap.set(e.lever, { ...e });
      }
    }
    for (const w of r.weeks) {
      const cur = weekMap.get(w.weekId);
      if (cur) {
        cur.baselineUnits += w.baselineUnits;
        cur.scenarioUnits += w.scenarioUnits;
      } else {
        weekMap.set(w.weekId, { ...w });
      }
    }
  }

  return {
    totals: {
      baselineUnits,
      scenarioUnits,
      deltaUnits: scenarioUnits - baselineUnits,
      deltaUnitsPct: baselineUnits > 0 ? scenarioUnits / baselineUnits - 1 : 0,
      baselineValueEur,
      scenarioValueEur,
      deltaValueEur: scenarioValueEur - baselineValueEur,
      deltaValuePct: baselineValueEur > 0 ? scenarioValueEur / baselineValueEur - 1 : 0,
      // The aggregate multiplier differs per series, so a single blended
      // multiplier is not meaningful here; only the case deltas aggregate.
      effects: Array.from(effectMap.values()).map((e) => ({ ...e, multiplier: NaN })),
      weeks: Array.from(weekMap.entries())
        .map(([weekId, v]) => ({ weekId, ...v }))
        .sort((a, b) => a.weekId.localeCompare(b.weekId)),
      seriesCount: perSeries.length,
    },
    perSeries,
  };
}
