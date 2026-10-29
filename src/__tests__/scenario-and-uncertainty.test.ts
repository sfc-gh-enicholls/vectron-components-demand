/**
 * Correctness tests for the two pieces of maths that would be least visible
 * if they were wrong: scenario recalculation and prediction-interval
 * aggregation. Both produce plausible-looking numbers when broken.
 */
import {
  applyScenarioToSeries, runScenario, priceMultiplier, promoMultiplier,
  distributionMultiplier, macroMultiplier, NO_CHANGE,
  TIER_ELASTICITY, type ScenarioSeriesInput, type ScenarioLevers,
} from "@/lib/scenario";
import {
  emptyInterval, addInterval, resolveInterval, ERROR_CORRELATION,
} from "@/lib/uncertainty";

const series = (over: Partial<ScenarioSeriesInput> = {}): ScenarioSeriesInput => ({
  seriesId: "P-TEST|OEM-XX|CH-IAM",
  priceTier: "Commodity",
  channelName: "Independent aftermarket",
  exwPriceEurCase: 100,
  weeks: [
    { weekId: "2026-W38", planUnits: 1000, lower95: 800, upper95: 1200 },
    { weekId: "2026-W39", planUnits: 1000, lower95: 800, upper95: 1200 },
  ],
  ...over,
});

const levers = (over: Partial<ScenarioLevers> = {}): ScenarioLevers => ({
  ...NO_CHANGE, ...over,
});

describe("scenario levers", () => {
  it("leaves the plan untouched when no lever is moved", () => {
    const r = applyScenarioToSeries(series(), NO_CHANGE);
    expect(r.scenarioUnits).toBeCloseTo(r.baselineUnits, 6);
    expect(r.scenarioValueEur).toBeCloseTo(r.baselineValueEur, 6);
  });

  it("reduces volume when price rises, and raises it when price falls", () => {
    const up = applyScenarioToSeries(series(), levers({ priceChangePct: 0.1 }));
    const down = applyScenarioToSeries(series(), levers({ priceChangePct: -0.1 }));
    expect(up.scenarioUnits).toBeLessThan(up.baselineUnits);
    expect(down.scenarioUnits).toBeGreaterThan(down.baselineUnits);
  });

  it("makes commodity parts more price-sensitive than mechatronic", () => {
    const standard = priceMultiplier(0.1, "Commodity", "Independent aftermarket");
    const prestige = priceMultiplier(0.1, "Mechatronic", "Independent aftermarket");
    // Both fall, but commodity falls further.
    expect(standard).toBeLessThan(prestige);
    expect(prestige).toBeLessThan(1);
  });

  it("makes the aftermarket more price-sensitive than OE series", () => {
    const off = priceMultiplier(0.1, "Engineered", "Independent aftermarket");
    const on = priceMultiplier(0.1, "Engineered", "OE series production");
    expect(off).toBeLessThan(on);
  });

  it("never returns a negative or zero multiplier, even at extreme price moves", () => {
    for (const tier of Object.keys(TIER_ELASTICITY)) {
      for (const dp of [-0.5, -0.25, 0.25, 0.5]) {
        const m = priceMultiplier(dp, tier, "Independent aftermarket");
        expect(m).toBeGreaterThan(0);
        expect(Number.isFinite(m)).toBe(true);
      }
    }
  });

  it("raises volume on promotion but gives back realised price in value", () => {
    const r = applyScenarioToSeries(series(), levers({ promoDepthPct: 0.2 }));
    expect(r.scenarioUnits).toBeGreaterThan(r.baselineUnits);
    // This is the trap the UI is built to expose: a 20% discount on a
    // standard-tier off-trade series lifts units but must not be allowed to
    // look like a value win unless the volume genuinely pays for the discount.
    const volumeGain = r.scenarioUnits / r.baselineUnits;
    const priceGiveBack = 0.8;
    expect(r.scenarioValueEur).toBeCloseTo(
      r.baselineValueEur * volumeGain * priceGiveBack, 4,
    );
  });

  it("treats distribution response as strongly diminishing", () => {
    // Doubling distribution must deliver far less than double the volume.
    const m = distributionMultiplier(1.0);
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThan(1.5);
  });

  it("is symmetric in sign for distribution loss versus gain", () => {
    expect(distributionMultiplier(-0.1)).toBeLessThan(1);
    expect(distributionMultiplier(0.1)).toBeGreaterThan(1);
  });

  it("exposes mechatronic more than commodity to a sentiment shock", () => {
    const prestige = macroMultiplier(-10, "Mechatronic");
    const standard = macroMultiplier(-10, "Commodity");
    expect(prestige).toBeLessThan(standard);
    expect(standard).toBeLessThan(1);
  });

  it("decomposes the total change additively across levers", () => {
    const r = applyScenarioToSeries(
      series(),
      levers({ priceChangePct: 0.05, promoDepthPct: 0.1,
               distributionChangePct: -0.05, macroShiftPoints: -5 }),
    );
    const summed = r.baselineUnits + r.effects.reduce((s, e) => s + e.deltaUnits, 0);
    // Sequential decomposition telescopes exactly to the final value.
    expect(summed).toBeCloseTo(r.scenarioUnits, 6);
  });

  it("keeps per-week values consistent with the series total", () => {
    const r = applyScenarioToSeries(series(), levers({ priceChangePct: -0.05 }));
    const weekSum = r.weeks.reduce((s, w) => s + w.scenarioUnits, 0);
    expect(weekSum).toBeCloseTo(r.scenarioUnits, 6);
  });

  it("promo has no effect at zero depth", () => {
    expect(promoMultiplier(0, "Commodity", "Independent aftermarket")).toBe(1);
  });
});

describe("scenario aggregation", () => {
  const inputs = [
    series({ seriesId: "a", priceTier: "Commodity", channelName: "Independent aftermarket" }),
    series({ seriesId: "b", priceTier: "Mechatronic", channelName: "OE series production",
             exwPriceEurCase: 700 }),
  ];

  it("sums baseline and scenario across series", () => {
    const { totals, perSeries } = runScenario(inputs, levers({ priceChangePct: 0.05 }));
    expect(perSeries).toHaveLength(2);
    expect(totals.baselineUnits).toBeCloseTo(
      perSeries.reduce((s, r) => s + r.baselineUnits, 0), 6);
    expect(totals.scenarioUnits).toBeCloseTo(
      perSeries.reduce((s, r) => s + r.scenarioUnits, 0), 6);
  });

  it("aggregates weeks without losing or duplicating volume", () => {
    const { totals } = runScenario(inputs, levers({ promoDepthPct: 0.15 }));
    const weekSum = totals.weeks.reduce((s, w) => s + w.scenarioUnits, 0);
    expect(weekSum).toBeCloseTo(totals.scenarioUnits, 6);
    expect(totals.weeks.map((w) => w.weekId)).toEqual(["2026-W38", "2026-W39"]);
  });

  it("reports a zero delta for an untouched scenario", () => {
    const { totals } = runScenario(inputs, NO_CHANGE);
    expect(totals.deltaUnits).toBeCloseTo(0, 6);
    expect(totals.deltaUnitsPct).toBeCloseTo(0, 6);
    expect(totals.deltaValueEur).toBeCloseTo(0, 6);
  });

  it("can move volume and value in opposite directions", () => {
    // The whole reason the trade-off callout exists.
    const { totals } = runScenario(inputs, levers({ promoDepthPct: 0.3 }));
    expect(totals.deltaUnits).toBeGreaterThan(0);
    expect(totals.deltaValueEur).toBeLessThan(0);
  });
});

describe("prediction-interval aggregation", () => {
  /**
   * The failure this guards against is real and was hit during the build:
   * quadrature (independent errors) collapsed a 16% band to 1.6% across a few
   * hundred series, which would have understated planning risk by tenfold.
   */
  function aggregate(n: number, rho?: number) {
    const acc = emptyInterval();
    for (let i = 0; i < n; i++) addInterval(acc, 100, 80, 120);
    return resolveInterval(acc, 100 * n, rho);
  }

  it("returns null when nothing has been accumulated", () => {
    expect(resolveInterval(emptyInterval(), 0)).toBeNull();
  });

  it("reproduces the single-series interval exactly at n = 1", () => {
    const band = aggregate(1)!;
    expect(band[0]).toBeCloseTo(80, 6);
    expect(band[1]).toBeCloseTo(120, 6);
  });

  it("sits strictly between quadrature and linear summing", () => {
    const n = 400;
    const blended = aggregate(n)!;
    const quadrature = aggregate(n, 0)!;   // assumes independence
    const linear = aggregate(n, 1)!;       // assumes perfect correlation
    const width = (b: [number, number]) => b[1] - b[0];

    expect(width(quadrature)).toBeLessThan(width(blended));
    expect(width(blended)).toBeLessThan(width(linear));
  });

  it("does not let the relative band collapse as series count grows", () => {
    // Under quadrature the relative band would shrink like 1/sqrt(n) and be
    // essentially zero by 400 series. Under the blend it must stay material.
    const total = 100 * 400;
    const band = aggregate(400)!;
    const relative = (band[1] - band[0]) / total;
    expect(relative).toBeGreaterThan(0.05);
  });

  it("uses a correlation strictly between the two degenerate extremes", () => {
    expect(ERROR_CORRELATION).toBeGreaterThan(0);
    expect(ERROR_CORRELATION).toBeLessThan(1);
  });

  it("never returns a negative lower bound", () => {
    const acc = emptyInterval();
    addInterval(acc, 10, 0, 500);
    const band = resolveInterval(acc, 10)!;
    expect(band[0]).toBeGreaterThanOrEqual(0);
  });

  it("widens monotonically as correlation increases", () => {
    const widths = [0, 0.2, 0.5, 0.8, 1].map((rho) => {
      const b = aggregate(100, rho)!;
      return b[1] - b[0];
    });
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    }
  });
});
