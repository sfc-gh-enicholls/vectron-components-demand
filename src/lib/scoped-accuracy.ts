/**
 * Forecast accuracy (WAPE, bias, interval coverage, FVA) recomputed under a
 * hierarchy scope.
 *
 * WHY THIS EXISTS
 * ---------------
 * The views behind the accuracy tiles — APP.V_ACCURACY_BY_LAG, V_FVA_SUMMARY and
 * V_OVERRIDE_SCORECARD — are aggregated over the whole portfolio and carry no
 * series column, so they cannot be filtered. Scoping them means recomputing from
 * the facts. Three pages need that (the cockpit, /baseline and /accuracy), so it
 * lives here once rather than as three copies of the formulas drifting apart.
 *
 * WAPE is a RATIO OF SUMS, not an average of per-series WAPE: it weights each
 * series by its volume, which is what the portfolio-level view does. Averaging
 * per-series WAPE instead would let a 10-case series move the headline as much
 * as a 100,000-case one.
 *
 * Definitions are copied from snowflake/04-app-views.sql. The join to V_SERIES
 * is safe at the root: all 726 forecast series are present in V_SERIES and it is
 * unique per series (both checked), so the join can neither drop nor duplicate
 * rows, and the root numbers equal the views'.
 *
 * If the definitions in 04-app-views.sql ever change, change them here too.
 */

import { hierarchyPredicate, type HierarchyPathServer } from "@/lib/hierarchy-path";
import { query } from "@/lib/snowflake";

export const ACCURACY_MODELS = ["NAIVE_SEASONAL", "VECTRON_STAT", "CONSENSUS"] as const;

/** Same columns as APP.V_ACCURACY_BY_LAG. */
export type AccuracyByLagRow = {
  MODEL_NAME: string;
  LAG_WEEKS: number;
  N_OBS: number;
  ACTUAL_UNITS: number;
  WAPE: number | null;
  BIAS: number | null;
  INTERVAL_COVERAGE: number | null;
};

/** Same columns as APP.V_FVA_SUMMARY. */
export type FvaSummaryRow = {
  NAIVE_WAPE: number | null;
  STAT_WAPE: number | null;
  CONSENSUS_WAPE: number | null;
  MODEL_FVA: number | null;
  PLANNER_FVA: number | null;
};

/** Same columns as APP.V_OVERRIDE_SCORECARD. */
export type OverrideScorecardRow = {
  OVERRIDE_COUNT: number;
  IMPROVED: number;
  WORSENED: number;
  WIN_RATE: number | null;
  NET_UNITS_SAVED: number | null;
};

/** Scoped equivalent of `SELECT * FROM APP.V_ACCURACY_BY_LAG`. */
export async function accuracyByLag(path: HierarchyPathServer): Promise<AccuracyByLagRow[]> {
  const scope = hierarchyPredicate(path, "v");
  return query<AccuracyByLagRow>(
    `SELECT
       f.MODEL_NAME, f.LAG_WEEKS,
       COUNT(*) AS N_OBS,
       SUM(p.UNITS) AS ACTUAL_UNITS,
       SUM(ABS(f.FORECAST_UNITS - p.UNITS)) / NULLIF(SUM(p.UNITS), 0) AS WAPE,
       SUM(f.FORECAST_UNITS - p.UNITS) / NULLIF(SUM(p.UNITS), 0) AS BIAS,
       AVG(CASE WHEN p.UNITS BETWEEN f.LOWER_95 AND f.UPPER_95 THEN 1.0 ELSE 0.0 END)
         AS INTERVAL_COVERAGE
     FROM ML.FACT_FORECAST f
     JOIN CORE.FACT_POS_WEEKLY p
       ON p.SERIES_ID = f.SERIES_ID AND p.WEEK_ID = f.TARGET_WEEK_ID
     JOIN APP.V_SERIES v ON v.SERIES_ID = f.SERIES_ID
     WHERE f.MODEL_NAME IN ('NAIVE_SEASONAL', 'VECTRON_STAT', 'CONSENSUS')
       AND ${scope.sql}
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    scope.binds,
  );
}

/**
 * Scoped equivalent of `SELECT * FROM APP.V_FVA_SUMMARY`.
 * Always returns one row; every field is null when the scope has no actuals.
 */
export async function fvaSummary(path: HierarchyPathServer): Promise<FvaSummaryRow> {
  const scope = hierarchyPredicate(path, "v");
  const rows = await query<FvaSummaryRow>(
    `WITH w AS (
       SELECT f.MODEL_NAME,
              SUM(ABS(f.FORECAST_UNITS - p.UNITS)) / NULLIF(SUM(p.UNITS), 0) AS WAPE
       FROM ML.FACT_FORECAST f
       JOIN CORE.FACT_POS_WEEKLY p
         ON p.SERIES_ID = f.SERIES_ID AND p.WEEK_ID = f.TARGET_WEEK_ID
       JOIN APP.V_SERIES v ON v.SERIES_ID = f.SERIES_ID
       WHERE f.MODEL_NAME IN ('NAIVE_SEASONAL', 'VECTRON_STAT', 'CONSENSUS')
         AND ${scope.sql}
       GROUP BY 1
     )
     SELECT
       MAX(CASE WHEN MODEL_NAME = 'NAIVE_SEASONAL' THEN WAPE END) AS NAIVE_WAPE,
       MAX(CASE WHEN MODEL_NAME = 'VECTRON_STAT'  THEN WAPE END) AS STAT_WAPE,
       MAX(CASE WHEN MODEL_NAME = 'CONSENSUS'      THEN WAPE END) AS CONSENSUS_WAPE,
       MAX(CASE WHEN MODEL_NAME = 'NAIVE_SEASONAL' THEN WAPE END)
         - MAX(CASE WHEN MODEL_NAME = 'VECTRON_STAT' THEN WAPE END) AS MODEL_FVA,
       MAX(CASE WHEN MODEL_NAME = 'VECTRON_STAT' THEN WAPE END)
         - MAX(CASE WHEN MODEL_NAME = 'CONSENSUS' THEN WAPE END) AS PLANNER_FVA
     FROM w`,
    scope.binds,
  );
  return rows[0] ?? {
    NAIVE_WAPE: null, STAT_WAPE: null, CONSENSUS_WAPE: null, MODEL_FVA: null, PLANNER_FVA: null,
  };
}

/** Scoped equivalent of `SELECT * FROM APP.V_OVERRIDE_SCORECARD`. Always one row. */
export async function overrideScorecard(path: HierarchyPathServer): Promise<OverrideScorecardRow> {
  const scope = hierarchyPredicate(path, "v");
  const rows = await query<OverrideScorecardRow>(
    `WITH scored AS (
       SELECT
         ABS(s.FORECAST_UNITS - p.UNITS) AS STAT_ERR,
         ABS(c.FORECAST_UNITS - p.UNITS) AS CONS_ERR
       FROM ML.FACT_FORECAST c
       JOIN ML.FACT_FORECAST s
         ON s.SERIES_ID = c.SERIES_ID AND s.TARGET_WEEK_ID = c.TARGET_WEEK_ID
        AND s.MADE_WEEK_ID = c.MADE_WEEK_ID AND s.MODEL_NAME = 'VECTRON_STAT'
       JOIN CORE.FACT_POS_WEEKLY p
         ON p.SERIES_ID = c.SERIES_ID AND p.WEEK_ID = c.TARGET_WEEK_ID
       JOIN APP.V_SERIES v ON v.SERIES_ID = c.SERIES_ID
       WHERE c.MODEL_NAME = 'CONSENSUS'
         AND ABS(c.FORECAST_UNITS - s.FORECAST_UNITS) > 0.01
         AND ${scope.sql}
     )
     SELECT
       COUNT(*) AS OVERRIDE_COUNT,
       COALESCE(SUM(CASE WHEN CONS_ERR < STAT_ERR THEN 1 ELSE 0 END), 0) AS IMPROVED,
       COALESCE(SUM(CASE WHEN CONS_ERR > STAT_ERR THEN 1 ELSE 0 END), 0) AS WORSENED,
       AVG(CASE WHEN CONS_ERR < STAT_ERR THEN 1.0 ELSE 0.0 END) AS WIN_RATE,
       SUM(STAT_ERR - CONS_ERR) AS NET_UNITS_SAVED
     FROM scored`,
    scope.binds,
  );
  return rows[0] ?? {
    OVERRIDE_COUNT: 0, IMPROVED: 0, WORSENED: 0, WIN_RATE: null, NET_UNITS_SAVED: null,
  };
}
