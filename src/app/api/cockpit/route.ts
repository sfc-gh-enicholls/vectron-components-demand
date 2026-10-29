import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/snowflake";
import { getContext, getIntegrity } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import {
  hierarchyLabel, hierarchyPredicate, parseHierarchyPath,
} from "@/lib/hierarchy-path";
import { accuracyByLag, fvaSummary } from "@/lib/scoped-accuracy";
import { emptyInterval, addInterval, resolveInterval } from "@/lib/uncertainty";

/**
 * Cockpit: what the planner needs to know before doing anything else.
 *
 * Three things here are easy to get subtly wrong and are handled deliberately:
 *
 * 1. Aggregating prediction intervals. Summing 726 per-series 95% intervals in
 *    quadrature assumes independent errors and collapses the band to almost
 *    nothing; summing them linearly assumes perfect correlation and overstates
 *    it. This uses the correlation blend in lib/uncertainty.ts.
 *
 * 2. Every forecast read filters MODEL_NAME. It is part of the table's grain.
 *
 * 3. The hierarchy scope. Every figure is filtered by the path, and the
 *    exceptions are filtered before the LIMIT, so they are the scope's top 12
 *    rather than whichever of the portfolio's top 12 happen to fall inside it.
 *    V_PLAN_FORWARD and V_ACTUALS_WEEKLY carry only SERIES_ID, so they join
 *    V_SERIES for the level columns; V_SERIES is unique per series and holds
 *    all 726, so the join cannot move the root totals. The accuracy views have
 *    no series column at all, so those tiles come from lib/scoped-accuracy.ts.
 */
export const dynamic = "force-dynamic";

interface WeekPoint {
  WEEK_ID: string;
  POS_UNITS: number | null;
  PLAN_UNITS: number | null;
  LOWER_95: number | null;
  UPPER_95: number | null;
}

/** SQL NULL means "nothing in scope", which must not be shown as zero. */
function nullableNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export async function GET(request: NextRequest) {
  try {
    const path = parseHierarchyPath(request.nextUrl.searchParams);
    // One predicate per alias that carries the level columns.
    const seriesScope = hierarchyPredicate(path, "v");
    const exceptionScope = hierarchyPredicate(path, "e");
    const signalScope = hierarchyPredicate(path, "s");

    const ctx = await getContext();

    const [
      forwardKpi,
      lastYearComparison,
      accuracy,
      fva,
      signalCounts,
      topExceptions,
      actualsSeries,
      forwardSeries,
      integrity,
      hierarchyOptions,
    ] = await Promise.all([
      // Next 8 weeks of committed plan, split into baseline and overrides
      query<{
        PLAN_UNITS: number; PLAN_VALUE_EUR: number; N_SERIES: number;
        STAT_UNITS: number; OVERRIDE_UNITS: number;
      }>(
        `SELECT SUM(p.PLAN_UNITS) AS PLAN_UNITS,
                SUM(p.PLAN_VALUE_EUR) AS PLAN_VALUE_EUR,
                COUNT(DISTINCT p.SERIES_ID) AS N_SERIES,
                SUM(p.STAT_UNITS) AS STAT_UNITS,
                SUM(p.PLAN_UNITS - p.STAT_UNITS) AS OVERRIDE_UNITS
         FROM APP.V_PLAN_FORWARD p
         JOIN APP.V_SERIES v ON v.SERIES_ID = p.SERIES_ID
         WHERE p.LAG_WEEKS <= 8
           AND ${seriesScope.sql}`,
        seriesScope.binds,
      ),
      // Same eight calendar weeks a year earlier, as the comparison target.
      // The weeks are a calendar window, so they come from the whole plan.
      query<{ LY_UNITS: number; LY_VALUE_EUR: number }>(
        `WITH fwd AS (
           SELECT DISTINCT w.ISO_WEEK
           FROM APP.V_PLAN_FORWARD p
           JOIN CORE.DIM_WEEK w ON w.WEEK_ID = p.WEEK_ID
           WHERE p.LAG_WEEKS <= 8
         )
         SELECT SUM(a.POS_UNITS) AS LY_UNITS,
                SUM(a.POS_REVENUE_EUR) AS LY_VALUE_EUR
         FROM APP.V_ACTUALS_WEEKLY a
         JOIN fwd ON fwd.ISO_WEEK = a.ISO_WEEK
         JOIN APP.V_SERIES v ON v.SERIES_ID = a.SERIES_ID
         WHERE a.ISO_YEAR = (SELECT ISO_YEAR - 1 FROM CORE.DIM_WEEK WHERE WEEK_ID = ?)
           AND ${seriesScope.sql}`,
        [ctx.HISTORY_END_WEEK, ...seriesScope.binds],
      ),
      // Backtest accuracy for every model and lag; the tile reads the
      // production model at the 4-week horizon
      accuracyByLag(path),
      fvaSummary(path),
      query<{ SEVERITY: string; N: number; VALUE_AT_RISK: number }>(
        `SELECT s.SEVERITY, COUNT(*) AS N,
                SUM(s.BASE_ANNUAL_VALUE_EUR) AS VALUE_AT_RISK
         FROM APP.V_SENSING_SIGNALS s
         WHERE ${signalScope.sql}
         GROUP BY 1`,
        signalScope.binds,
      ),
      query<{
        SERIES_ID: string; SERIES_LABEL: string; PRODUCT_NAME: string;
        CUSTOMER_NAME: string; CHANNEL_NAME: string; CATEGORY_NAME: string;
        SEGMENT_ABC: string;
        GAP_UNITS: number; GAP_VALUE_EUR: number; GAP_PCT: number;
        PLAN_UNITS_8WK: number; STAT_UNITS_8WK: number;
        REASON_LABEL: string | null; PLANNER: string | null;
      }>(
        `SELECT e.SERIES_ID, e.SERIES_LABEL, e.PRODUCT_NAME, e.CUSTOMER_NAME,
                e.CHANNEL_NAME, e.CATEGORY_NAME, e.SEGMENT_ABC,
                e.GAP_UNITS, e.GAP_VALUE_EUR, e.GAP_PCT,
                e.PLAN_UNITS_8WK, e.STAT_UNITS_8WK, e.REASON_LABEL, e.PLANNER
         FROM APP.V_EXCEPTIONS e
         WHERE ABS(e.GAP_PCT) >= 0.05
           AND ${exceptionScope.sql}
         ORDER BY ABS(e.GAP_VALUE_EUR) DESC, e.SERIES_ID
         LIMIT 12`,
        exceptionScope.binds,
      ),
      // 26 weeks of actuals for the trend, on a dense week axis so a week the
      // scope did not trade (before a launch, say) is a gap, not a missing tick
      query<{ WEEK_ID: string; POS_UNITS: number | null }>(
        `SELECT wi.WEEK_ID, SUM(sa.POS_UNITS) AS POS_UNITS
         FROM APP.V_WEEK_INDEX wi
         LEFT JOIN (
           SELECT a.WEEK_ID, a.POS_UNITS
           FROM APP.V_ACTUALS_WEEKLY a
           JOIN APP.V_SERIES v ON v.SERIES_ID = a.SERIES_ID
           WHERE ${seriesScope.sql}
         ) sa ON sa.WEEK_ID = wi.WEEK_ID
         WHERE wi.WEEKS_AGO <= 26
         GROUP BY 1 ORDER BY 1`,
        seriesScope.binds,
      ),
      // Forward plan per series-week, so intervals aggregate correctly. The
      // ORDER BY pins the row order: the band below is a floating-point
      // accumulation, and without it the join plan picks the order and the
      // band's last digits drift.
      query<{
        WEEK_ID: string; PLAN_UNITS: number;
        LOWER_95: number | null; UPPER_95: number | null;
      }>(
        `SELECT p.WEEK_ID, p.PLAN_UNITS, p.LOWER_95, p.UPPER_95
         FROM APP.V_PLAN_FORWARD p
         JOIN APP.V_SERIES v ON v.SERIES_ID = p.SERIES_ID
         WHERE p.LAG_WEEKS <= 8
           AND ${seriesScope.sql}
         ORDER BY p.SERIES_ID, p.WEEK_ID`,
        seriesScope.binds,
      ),
      getIntegrity(),
      loadHierarchyOptions("APP.V_SERIES", path),
    ]);

    // --- aggregate the forward band with the correlation blend -------
    const byWeek = new Map<
      string,
      { plan: number; acc: ReturnType<typeof emptyInterval> }
    >();
    for (const r of forwardSeries) {
      let slot = byWeek.get(r.WEEK_ID);
      if (!slot) {
        slot = { plan: 0, acc: emptyInterval() };
        byWeek.set(r.WEEK_ID, slot);
      }
      slot.plan += Number(r.PLAN_UNITS) || 0;
      if (r.LOWER_95 !== null && r.UPPER_95 !== null) {
        addInterval(
          slot.acc,
          Number(r.PLAN_UNITS) || 0,
          Number(r.LOWER_95),
          Number(r.UPPER_95),
        );
      }
    }

    // A scope with neither actuals nor plan (a product in a customer it is not
    // sold in) gets an empty trend rather than 26 blank weeks.
    const hasTrend = forwardSeries.length > 0
      || actualsSeries.some((r) => r.POS_UNITS !== null);

    const trend: WeekPoint[] = hasTrend
      ? actualsSeries.map((r) => ({
          WEEK_ID: r.WEEK_ID,
          POS_UNITS: nullableNumber(r.POS_UNITS),
          PLAN_UNITS: null,
          LOWER_95: null,
          UPPER_95: null,
        }))
      : [];

    for (const weekId of Array.from(byWeek.keys()).sort()) {
      const slot = byWeek.get(weekId)!;
      const band = resolveInterval(slot.acc, slot.plan);
      trend.push({
        WEEK_ID: weekId,
        POS_UNITS: null,
        PLAN_UNITS: slot.plan,
        LOWER_95: band ? band[0] : null,
        UPPER_95: band ? band[1] : null,
      });
    }

    const kpi = forwardKpi[0] ?? {
      PLAN_UNITS: 0, PLAN_VALUE_EUR: 0, N_SERIES: 0, STAT_UNITS: 0, OVERRIDE_UNITS: 0,
    };
    const ly = lastYearComparison[0] ?? { LY_UNITS: 0, LY_VALUE_EUR: 0 };
    const tile = accuracy.find(
      (r) => r.MODEL_NAME === ctx.PRODUCTION_MODEL && Number(r.LAG_WEEKS) === 4,
    );
    // fvaSummary always returns a row; it is all-null when the scope has no
    // backtest history, which the page shows as no FVA rather than zeros.
    const hasFva = fva.NAIVE_WAPE !== null
      || fva.STAT_WAPE !== null || fva.CONSENSUS_WAPE !== null;

    return NextResponse.json({
      context: ctx,
      scope: { path, label: hierarchyLabel(path) },
      options: { hierarchy: hierarchyOptions },
      kpi: {
        planUnits: Number(kpi.PLAN_UNITS) || 0,
        planValueEur: Number(kpi.PLAN_VALUE_EUR) || 0,
        seriesCount: Number(kpi.N_SERIES) || 0,
        baselineUnits: Number(kpi.STAT_UNITS) || 0,
        overrideUnits: Number(kpi.OVERRIDE_UNITS) || 0,
        lastYearUnits: Number(ly.LY_UNITS) || 0,
        lastYearValueEur: Number(ly.LY_VALUE_EUR) || 0,
        wape: nullableNumber(tile?.WAPE),
        bias: nullableNumber(tile?.BIAS),
        coverage: nullableNumber(tile?.INTERVAL_COVERAGE),
      },
      fva: hasFva
        ? {
            naiveWape: nullableNumber(fva.NAIVE_WAPE),
            statWape: nullableNumber(fva.STAT_WAPE),
            consensusWape: nullableNumber(fva.CONSENSUS_WAPE),
            modelFva: nullableNumber(fva.MODEL_FVA),
            plannerFva: nullableNumber(fva.PLANNER_FVA),
          }
        : null,
      signals: signalCounts.map((r) => ({
        severity: r.SEVERITY,
        count: Number(r.N),
        valueAtRisk: Number(r.VALUE_AT_RISK) || 0,
      })),
      exceptions: topExceptions,
      trend,
      integrity,
    });
  } catch (err) {
    console.error("cockpit route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load cockpit" },
      { status: 500 },
    );
  }
}
