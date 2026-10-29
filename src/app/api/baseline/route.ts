import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/snowflake";
import { getContext, getIntegrity } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import { hierarchyPredicate, parseHierarchyPath } from "@/lib/hierarchy-path";
import { accuracyByLag } from "@/lib/scoped-accuracy";

export const dynamic = "force-dynamic";

interface SeriesOptionRow {
  SERIES_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string;
  CUSTOMER_NAME: string;
  CHANNEL_NAME: string;
  SEGMENT: string;
  BASE_ANNUAL_VALUE_EUR: number;
  SERIES_IN_SCOPE: number;
}

interface AccuracyRow {
  SERIES_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string;
  CUSTOMER_NAME: string;
  SEGMENT: string;
  SEGMENT_ABC: string;
  SEGMENT_XYZ: string;
  BASE_ANNUAL_VALUE_EUR: number;
  WAPE: number | null;
  BIAS: number | null;
  COVERAGE: number | null;
}

interface MatrixRow {
  SEGMENT_ABC: string;
  SEGMENT_XYZ: string;
  SERIES_COUNT: number;
  VALUE_EUR: number;
}

interface WeekRow {
  WEEK_ID: string;
}

interface ActualRow {
  SERIES_ID: string;
  WEEK_ID: string;
  POS_UNITS: number;
}

interface ForwardRow {
  SERIES_ID: string;
  WEEK_ID: string;
  STAT_UNITS: number;
  LOWER_95: number | null;
  UPPER_95: number | null;
}

const MODEL_NAME = "VECTRON_STAT";

function placeholderList(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export async function GET(request: NextRequest) {
  try {
    const path = parseHierarchyPath(request.nextUrl.searchParams);
    // Every figure on this page is per series, and APP.V_SERIES carries all four
    // levels for every series, so each query honours the full path through it.
    const scope = hierarchyPredicate(path, "s");
    const ctx = await getContext();

    const [
      forwardKpi,
      accuracyRows,
      allSeriesAccuracy,
      topSeries,
      segmentation,
      historyWeeks,
      forwardWeeks,
      integrity,
      hierarchyOptions,
    ] = await Promise.all([
      query<{ BASELINE_UNITS: number }>(
        `SELECT SUM(f.STAT_UNITS) AS BASELINE_UNITS
         FROM APP.V_PLAN_FORWARD f
         JOIN APP.V_SERIES s
           ON s.SERIES_ID = f.SERIES_ID
         WHERE ${scope.sql}`,
        scope.binds,
      ),
      // V_ACCURACY_BY_LAG has no series column; this is its scoped equivalent.
      accuracyByLag(path),
      query<AccuracyRow>(
        `SELECT
           s.SERIES_ID,
           s.SERIES_LABEL,
           s.PRODUCT_NAME,
           s.CUSTOMER_NAME,
           s.SEGMENT,
           s.SEGMENT_ABC,
           s.SEGMENT_XYZ,
           s.BASE_ANNUAL_VALUE_EUR,
           SUM(ABS(f.FORECAST_UNITS - p.UNITS)) / NULLIF(SUM(p.UNITS), 0) * 100 AS WAPE,
           SUM(f.FORECAST_UNITS - p.UNITS) / NULLIF(SUM(p.UNITS), 0) AS BIAS,
           AVG(CASE WHEN p.UNITS BETWEEN f.LOWER_95 AND f.UPPER_95 THEN 1 ELSE 0 END) * 100 AS COVERAGE
         FROM ML.FACT_FORECAST f
         JOIN CORE.FACT_POS_WEEKLY p
           ON p.SERIES_ID = f.SERIES_ID
          AND p.WEEK_ID = f.TARGET_WEEK_ID
         JOIN APP.V_SERIES s
           ON s.SERIES_ID = f.SERIES_ID
         WHERE f.MODEL_NAME = ?
           AND f.LAG_WEEKS = 4
           AND ${scope.sql}
         GROUP BY
           s.SERIES_ID,
           s.SERIES_LABEL,
           s.PRODUCT_NAME,
           s.CUSTOMER_NAME,
           s.SEGMENT,
           s.SEGMENT_ABC,
           s.SEGMENT_XYZ,
           s.BASE_ANNUAL_VALUE_EUR`,
        [MODEL_NAME, ...scope.binds],
      ),
      // The picker's options: the largest series inside the scope. The window
      // count runs before LIMIT, so it is the scope's full series count. SERIES_ID
      // breaks value ties so the first option, the fallback selection, is stable.
      query<SeriesOptionRow>(
        `SELECT SERIES_ID, SERIES_LABEL, PRODUCT_NAME, CUSTOMER_NAME, CHANNEL_NAME, SEGMENT, BASE_ANNUAL_VALUE_EUR,
                COUNT(*) OVER () AS SERIES_IN_SCOPE
         FROM APP.V_SERIES s
         WHERE ${scope.sql}
         ORDER BY BASE_ANNUAL_VALUE_EUR DESC NULLS LAST, SERIES_ID
         LIMIT 40`,
        scope.binds,
      ),
      query<MatrixRow>(
        `SELECT
           s.SEGMENT_ABC,
           s.SEGMENT_XYZ,
           COUNT(*) AS SERIES_COUNT,
           SUM(s.BASE_ANNUAL_VALUE_EUR) AS VALUE_EUR
         FROM APP.V_SERIES s
         WHERE s.SEGMENT_ABC IN ('A', 'B', 'C')
           AND s.SEGMENT_XYZ IN ('X', 'Y', 'Z')
           AND ${scope.sql}
         GROUP BY s.SEGMENT_ABC, s.SEGMENT_XYZ`,
        scope.binds,
      ),
      query<WeekRow>(
        `SELECT WEEK_ID
         FROM APP.V_WEEK_INDEX
         WHERE WEEKS_AGO <= 52
         ORDER BY WEEK_START_DATE`,
      ),
      query<WeekRow>(
        `SELECT DISTINCT WEEK_ID
         FROM APP.V_PLAN_FORWARD
         ORDER BY WEEK_ID`,
      ),
      getIntegrity(),
      loadHierarchyOptions("APP.V_SERIES", path),
    ]);

    const selectedSeriesIds = topSeries.map((row) => row.SERIES_ID);
    const healthRows = allSeriesAccuracy
      .map((row) => ({
        ...row,
        WAPE: row.WAPE === null ? null : Number(row.WAPE),
        BIAS: row.BIAS === null ? null : Number(row.BIAS),
        COVERAGE: row.COVERAGE === null ? null : Number(row.COVERAGE),
        BASE_ANNUAL_VALUE_EUR: Number(row.BASE_ANNUAL_VALUE_EUR) || 0,
      }))
      .sort((left, right) => {
        const leftWape = left.WAPE ?? -1;
        const rightWape = right.WAPE ?? -1;
        if (rightWape !== leftWape) return rightWape - leftWape;
        return right.BASE_ANNUAL_VALUE_EUR - left.BASE_ANNUAL_VALUE_EUR;
      });

    const topHealth = healthRows.slice(0, 25);
    const healthSeriesIds = topHealth.map((row) => row.SERIES_ID);

    const seriesIdsForActuals = Array.from(new Set([...selectedSeriesIds, ...healthSeriesIds]));

    let selectedActuals: ActualRow[] = [];
    let selectedForward: ForwardRow[] = [];

    if (seriesIdsForActuals.length > 0) {
      const actualPlaceholders = placeholderList(seriesIdsForActuals.length);
      const forwardPlaceholders = placeholderList(selectedSeriesIds.length);

      selectedActuals = await query<ActualRow>(
        `SELECT a.SERIES_ID, a.WEEK_ID, a.POS_UNITS
         FROM APP.V_ACTUALS_WEEKLY a
         JOIN APP.V_WEEK_INDEX wi
           ON wi.WEEK_ID = a.WEEK_ID
         WHERE wi.WEEKS_AGO <= 52
           AND a.SERIES_ID IN (${actualPlaceholders})
         ORDER BY a.SERIES_ID, a.WEEK_ID`,
        seriesIdsForActuals,
      );

      if (selectedSeriesIds.length > 0) {
        selectedForward = await query<ForwardRow>(
          `SELECT SERIES_ID, WEEK_ID, STAT_UNITS, LOWER_95, UPPER_95
           FROM APP.V_PLAN_FORWARD
           WHERE SERIES_ID IN (${forwardPlaceholders})
           ORDER BY SERIES_ID, WEEK_ID`,
          selectedSeriesIds,
        );
      }
    }

    const historyWeekIds = historyWeeks.map((row) => row.WEEK_ID);
    const forwardWeekIds = forwardWeeks.map((row) => row.WEEK_ID);

    const actualMap = new Map<string, Map<string, number>>();
    for (const row of selectedActuals) {
      let byWeek = actualMap.get(row.SERIES_ID);
      if (!byWeek) {
        byWeek = new Map<string, number>();
        actualMap.set(row.SERIES_ID, byWeek);
      }
      byWeek.set(row.WEEK_ID, Number(row.POS_UNITS) || 0);
    }

    const forwardMap = new Map<string, Map<string, { stat: number; lower: number | null; upper: number | null }>>();
    for (const row of selectedForward) {
      let byWeek = forwardMap.get(row.SERIES_ID);
      if (!byWeek) {
        byWeek = new Map<string, { stat: number; lower: number | null; upper: number | null }>();
        forwardMap.set(row.SERIES_ID, byWeek);
      }
      byWeek.set(row.WEEK_ID, {
        stat: Number(row.STAT_UNITS) || 0,
        lower: row.LOWER_95 === null ? null : Number(row.LOWER_95),
        upper: row.UPPER_95 === null ? null : Number(row.UPPER_95),
      });
    }

    const trendBySeries = Object.fromEntries(
      topSeries.map((series) => {
        const actuals = actualMap.get(series.SERIES_ID) ?? new Map<string, number>();
        const forecast = forwardMap.get(series.SERIES_ID) ?? new Map<string, { stat: number; lower: number | null; upper: number | null }>();
        return [
          series.SERIES_ID,
          [
            ...historyWeekIds.map((weekId) => ({
              WEEK_ID: weekId,
              POS_UNITS: actuals.has(weekId) ? actuals.get(weekId) ?? null : null,
              STAT_UNITS: null,
              LOWER_95: null,
              UPPER_95: null,
            })),
            ...forwardWeekIds.map((weekId) => {
              const point = forecast.get(weekId);
              return {
                WEEK_ID: weekId,
                POS_UNITS: null,
                STAT_UNITS: point?.stat ?? null,
                LOWER_95: point?.lower ?? null,
                UPPER_95: point?.upper ?? null,
              };
            }),
          ],
        ];
      }),
    );

    const sparklineBySeries = Object.fromEntries(
      topHealth.map((series) => {
        const actuals = actualMap.get(series.SERIES_ID) ?? new Map<string, number>();
        const weeks = historyWeekIds.slice(-12);
        return [
          series.SERIES_ID,
          weeks.map((weekId) => (actuals.has(weekId) ? actuals.get(weekId) ?? null : null)),
        ];
      }),
    );

    // Same tile definition as before: VECTRON_STAT at lag 4, now for the scope.
    const kpiRow = accuracyRows.find(
      (row) => row.MODEL_NAME === MODEL_NAME && Number(row.LAG_WEEKS) === 4,
    );
    const kpiSummary = {
      WAPE: kpiRow?.WAPE ?? null,
      COVERAGE: kpiRow?.INTERVAL_COVERAGE ?? null,
    };
    const baselineUnits = Number(forwardKpi[0]?.BASELINE_UNITS) || 0;
    const unreliableSeries = healthRows.filter((row) => row.WAPE !== null && row.WAPE > 30).length;
    const seriesInScope = Number(topSeries[0]?.SERIES_IN_SCOPE) || 0;

    return NextResponse.json({
      context: ctx,
      filters: { path },
      options: { hierarchy: hierarchyOptions },
      kpis: {
        baselineUnits,
        wape: kpiSummary.WAPE === null ? null : Number(kpiSummary.WAPE),
        coverage: kpiSummary.COVERAGE === null ? null : Number(kpiSummary.COVERAGE),
        unreliableSeries,
      },
      seriesInScope,
      seriesOptions: topSeries.map((row) => ({
        seriesId: row.SERIES_ID,
        label: row.SERIES_LABEL,
        productName: row.PRODUCT_NAME,
        customerName: row.CUSTOMER_NAME,
        channelName: row.CHANNEL_NAME,
        segment: row.SEGMENT,
        baseAnnualValueEur: Number(row.BASE_ANNUAL_VALUE_EUR) || 0,
      })),
      trendBySeries,
      segmentation: segmentation.map((row) => ({
        segmentAbc: row.SEGMENT_ABC,
        segmentXyz: row.SEGMENT_XYZ,
        seriesCount: Number(row.SERIES_COUNT) || 0,
        valueEur: Number(row.VALUE_EUR) || 0,
      })),
      health: topHealth.map((row) => ({
        seriesId: row.SERIES_ID,
        label: row.SERIES_LABEL,
        productName: row.PRODUCT_NAME,
        customerName: row.CUSTOMER_NAME,
        segment: row.SEGMENT,
        wape: row.WAPE,
        bias: row.BIAS,
        coverage: row.COVERAGE,
      })),
      sparklineBySeries,
      integrity,
    });
  } catch (err) {
    console.error("baseline route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load baseline" },
      { status: 500 },
    );
  }
}