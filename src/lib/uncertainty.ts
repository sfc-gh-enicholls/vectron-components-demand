/**
 * Aggregating prediction intervals.
 *
 * FACT_STATISTICAL_FORECAST carries a 95% interval per (product, customer, month).
 * Charts show monthly totals across hundreds of those series, so the per-series
 * intervals have to be combined — and how you combine them matters a lot.
 *
 * The two naive options are both wrong:
 *
 *   - Summing the bounds assumes every series errs in the same direction at the
 *     same time (perfect correlation). It overstates aggregate uncertainty badly.
 *   - Combining in quadrature — sqrt of the sum of squares — assumes the series
 *     are statistically independent. It understates it just as badly: on this
 *     dataset it collapses a ~16% per-series interval to ~3% at the total level,
 *     which renders as no band at all.
 *
 * Neither assumption holds. Demand series share seasonality, macro conditions,
 * promotional calendars and supply shocks, so their errors are positively but
 * imperfectly correlated. For a sum of series with average pairwise correlation
 * rho, the variance of the total is:
 *
 *     Var(sum) = (1 - rho) * sum(sigma_i^2) + rho * (sum(sigma_i))^2
 *
 * which degrades gracefully to quadrature at rho = 0 and to linear summing at
 * rho = 1. We therefore accumulate BOTH sum-of-squares and sum-of-sigma per
 * bucket and blend them at the end.
 *
 * Lower and upper half-widths are tracked separately because the model's
 * intervals are not symmetric about the forecast.
 */

/**
 * Assumed average pairwise correlation between per-series forecast errors.
 *
 * 0.2 is a deliberately conservative middle estimate, not a fitted value. It is
 * exposed as a named constant so it can be replaced with an empirical figure:
 * the honest way to derive it is to regress realised aggregate error against
 * realised per-series errors using FACT_SALES_HISTORY, which requires more
 * actuals history than the demo dataset currently holds.
 */
export const ERROR_CORRELATION = 0.2;

export interface IntervalAccumulator {
  /** Sum of squared lower half-widths. */
  loSq: number;
  /** Sum of squared upper half-widths. */
  hiSq: number;
  /** Sum of lower half-widths. */
  loSum: number;
  /** Sum of upper half-widths. */
  hiSum: number;
  /** True once at least one series has contributed an interval. */
  present: boolean;
}

export function emptyInterval(): IntervalAccumulator {
  return { loSq: 0, hiSq: 0, loSum: 0, hiSum: 0, present: false };
}

/**
 * Fold one series' 95% interval into an accumulator.
 * Bounds are taken relative to that series' own point forecast.
 */
export function addInterval(
  acc: IntervalAccumulator,
  pointForecast: number,
  lower95: number | null | undefined,
  upper95: number | null | undefined,
): void {
  if (lower95 == null || upper95 == null) return;
  const lo = Math.max(0, pointForecast - lower95);
  const hi = Math.max(0, upper95 - pointForecast);
  acc.loSq += lo * lo;
  acc.hiSq += hi * hi;
  acc.loSum += lo;
  acc.hiSum += hi;
  acc.present = true;
}

/** Blend sum-of-squares and sum-of-sigma under the correlation assumption. */
function blend(sumSq: number, sum: number, rho: number): number {
  return Math.sqrt(Math.max(0, (1 - rho) * sumSq + rho * sum * sum));
}

/**
 * Resolve an accumulator to absolute [lower, upper] bounds around a total.
 * Returns null when no series in the bucket carried an interval.
 */
export function resolveInterval(
  acc: IntervalAccumulator,
  total: number,
  rho: number = ERROR_CORRELATION,
): [number, number] | null {
  if (!acc.present) return null;
  return [
    Math.max(0, total - blend(acc.loSq, acc.loSum, rho)),
    total + blend(acc.hiSq, acc.hiSum, rho),
  ];
}
