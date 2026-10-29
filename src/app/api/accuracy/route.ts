import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/snowflake";
import { getContext, getIntegrity } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import { hierarchyPredicate, parseHierarchyPath } from "@/lib/hierarchy-path";
import { accuracyByLag, fvaSummary, overrideScorecard } from "@/lib/scoped-accuracy";

export const dynamic = "force-dynamic";

interface WorstOverrideRow {
  MADE_WEEK_ID: string;
  TARGET_WEEK_ID: string;
  SERIES_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string;
  CUSTOMER_NAME: string;
  REASON_CODE: string | null;
  REASON_LABEL: string | null;
  STAT_UNITS: number;
  OVERRIDE_UNITS: number;
  ACTUAL_UNITS: number;
  DAMAGE_UNITS: number;
}

interface AgentScorecardSummaryRow {
  PROPOSALS_SCORED: number;
  IMPROVED_COUNT: number;
  ERR_BEFORE: number;
  ERR_AFTER: number;
  ACTUAL_UNITS: number;
  UNITS_SAVED: number;
  VALUE_SAVED_EUR: number;
}

interface AgentScorecardBreakdownRow extends AgentScorecardSummaryRow {
  GROUP_KEY: string;
}

const AGENT_DISABLED_RULES = [
  {
    rule: "promo_response",
    status: "rejected",
    reason:
      "Back-run evidence showed promo uplift realisation was mostly noise on this dataset, so the rule pushed plans the wrong way.",
  },
  {
    rule: "bias_correction",
    status: "rejected",
    reason:
      "Trailing bias did not predict forward bias here. The rule looked principled but degraded held-out accuracy, so it was disabled.",
  },
  {
    rule: "distribution",
    status: "rejected",
    reason:
      "Distribution shifts carried effectively no predictive signal at the damping the data justified, so the rule did not earn its place.",
  },
  {
    rule: "service_risk",
    status: "dormant",
    reason:
      "The logic is kept, but this generated dataset hardly has any stockout signal, so the rule correctly emits nothing material.",
  },
  {
    rule: "price_change",
    status: "dormant",
    reason:
      "The dataset has smooth annual price drift rather than discrete repricing events, so there is no honest signal for the rule to act on.",
  },
] as const;

const STAT_MODEL = "VECTRON_STAT";
const CONSENSUS_MODEL = "CONSENSUS";

/**
 * Option source for the scope dropdowns: the series this page can score.
 * APP.V_SERIES on its own also carries series whose forecasts never meet an
 * actual (today, one product delisted before its first scored origin), and
 * offering one would open an empty page. loadHierarchyOptions interpolates
 * this, so it must stay a constant.
 */
const SCORED_SERIES = `(
  SELECT v.CATEGORY_NAME, v.PRODUCT_NAME, v.CUSTOMER_NAME, v.CHANNEL_NAME
  FROM APP.V_SERIES v
  WHERE EXISTS (
    SELECT 1
    FROM ML.FACT_FORECAST f
    JOIN CORE.FACT_POS_WEEKLY p
      ON p.SERIES_ID = f.SERIES_ID AND p.WEEK_ID = f.TARGET_WEEK_ID
    WHERE f.SERIES_ID = v.SERIES_ID
      AND f.MODEL_NAME IN ('NAIVE_SEASONAL', 'VECTRON_STAT', 'CONSENSUS')
  )
)`;

/** A number, or null where the scope leaves nothing to divide by. */
function toNullableNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export async function GET(request: NextRequest) {
  try {
    const path = parseHierarchyPath(request.nextUrl.searchParams);
    // The worst-overrides query already joins APP.V_SERIES as `s`.
    // V_AGENT_SCORECARD carries product and customer but not category or channel,
    // so it is scoped through a join to V_SERIES too. It is one row per scored
    // proposal on one series, and every one of those series is in V_SERIES, so
    // the join can neither drop nor duplicate a proposal.
    const seriesScope = hierarchyPredicate(path, "s");
    const agentScope = hierarchyPredicate(path, "v");

    const [
      context,
      integrity,
      hierarchyOptions,
      fva,
      lagRows,
      overrides,
      worstOverrides,
      agentScorecardSummary,
      agentByType,
      agentByConfidence,
    ] = await Promise.all([
      getContext(),
      getIntegrity(),
      loadHierarchyOptions(SCORED_SERIES, path),
      fvaSummary(path),
      accuracyByLag(path),
      overrideScorecard(path),
      query<WorstOverrideRow>(
        `SELECT
           c.MADE_WEEK_ID,
           c.TARGET_WEEK_ID,
           c.SERIES_ID,
           s.SERIES_LABEL,
           s.PRODUCT_NAME,
           s.CUSTOMER_NAME,
           dp.REASON_CODE,
           rc.REASON_LABEL,
           stat.FORECAST_UNITS AS STAT_UNITS,
           c.FORECAST_UNITS AS OVERRIDE_UNITS,
           actual.UNITS AS ACTUAL_UNITS,
           ABS(c.FORECAST_UNITS - actual.UNITS) - ABS(stat.FORECAST_UNITS - actual.UNITS) AS DAMAGE_UNITS
         FROM ML.FACT_FORECAST c
         JOIN ML.FACT_FORECAST stat
           ON stat.SERIES_ID = c.SERIES_ID
          AND stat.TARGET_WEEK_ID = c.TARGET_WEEK_ID
          AND stat.MADE_WEEK_ID = c.MADE_WEEK_ID
          AND stat.MODEL_NAME = ?
         JOIN CORE.FACT_POS_WEEKLY actual
           ON actual.SERIES_ID = c.SERIES_ID
          AND actual.WEEK_ID = c.TARGET_WEEK_ID
         JOIN APP.V_SERIES s
           ON s.SERIES_ID = c.SERIES_ID
         LEFT JOIN CORE.FACT_DEMAND_PLAN dp
           ON dp.SERIES_ID = c.SERIES_ID
          AND dp.WEEK_ID = c.TARGET_WEEK_ID
         LEFT JOIN CORE.DIM_REASON_CODE rc
           ON rc.REASON_CODE = dp.REASON_CODE
         WHERE c.MODEL_NAME = ?
           AND ABS(c.FORECAST_UNITS - actual.UNITS) > ABS(stat.FORECAST_UNITS - actual.UNITS)
           AND ${seriesScope.sql}
         ORDER BY DAMAGE_UNITS DESC
         LIMIT 20`,
        [STAT_MODEL, CONSENSUS_MODEL, ...seriesScope.binds],
      ),
      query<AgentScorecardSummaryRow>(
        `SELECT COUNT(*) AS PROPOSALS_SCORED,
                SUM(IFF(a.IMPROVED, 1, 0)) AS IMPROVED_COUNT,
                SUM(a.ERR_BEFORE) AS ERR_BEFORE,
                SUM(a.ERR_AFTER) AS ERR_AFTER,
                SUM(a.ACTUAL_UNITS) AS ACTUAL_UNITS,
                SUM(a.UNITS_SAVED) AS UNITS_SAVED,
                SUM(a.VALUE_SAVED_EUR) AS VALUE_SAVED_EUR
         FROM APP.V_AGENT_SCORECARD a
         JOIN APP.V_SERIES v ON v.SERIES_ID = a.SERIES_ID
         WHERE ${agentScope.sql}`,
        agentScope.binds,
      ),
      query<AgentScorecardBreakdownRow>(
        `SELECT a.PROPOSAL_TYPE AS GROUP_KEY,
                COUNT(*) AS PROPOSALS_SCORED,
                SUM(IFF(a.IMPROVED, 1, 0)) AS IMPROVED_COUNT,
                SUM(a.ERR_BEFORE) AS ERR_BEFORE,
                SUM(a.ERR_AFTER) AS ERR_AFTER,
                SUM(a.ACTUAL_UNITS) AS ACTUAL_UNITS,
                SUM(a.UNITS_SAVED) AS UNITS_SAVED,
                SUM(a.VALUE_SAVED_EUR) AS VALUE_SAVED_EUR
         FROM APP.V_AGENT_SCORECARD a
         JOIN APP.V_SERIES v ON v.SERIES_ID = a.SERIES_ID
         WHERE ${agentScope.sql}
         GROUP BY a.PROPOSAL_TYPE
         ORDER BY a.PROPOSAL_TYPE`,
        agentScope.binds,
      ),
      query<AgentScorecardBreakdownRow>(
        `SELECT CASE
                  WHEN a.CONFIDENCE < 0.5 THEN 'Low'
                  WHEN a.CONFIDENCE < 0.7 THEN 'Mid'
                  ELSE 'High'
                END AS GROUP_KEY,
                COUNT(*) AS PROPOSALS_SCORED,
                SUM(IFF(a.IMPROVED, 1, 0)) AS IMPROVED_COUNT,
                SUM(a.ERR_BEFORE) AS ERR_BEFORE,
                SUM(a.ERR_AFTER) AS ERR_AFTER,
                SUM(a.ACTUAL_UNITS) AS ACTUAL_UNITS,
                SUM(a.UNITS_SAVED) AS UNITS_SAVED,
                SUM(a.VALUE_SAVED_EUR) AS VALUE_SAVED_EUR
         FROM APP.V_AGENT_SCORECARD a
         JOIN APP.V_SERIES v ON v.SERIES_ID = a.SERIES_ID
         WHERE ${agentScope.sql}
         GROUP BY 1
         ORDER BY 1`,
        agentScope.binds,
      ),
    ]);

    const scorecard = agentScorecardSummary[0] ?? {
      PROPOSALS_SCORED: 0,
      IMPROVED_COUNT: 0,
      ERR_BEFORE: 0,
      ERR_AFTER: 0,
      ACTUAL_UNITS: 0,
      UNITS_SAVED: 0,
      VALUE_SAVED_EUR: 0,
    };

    function scorecardRowToJson(row: AgentScorecardSummaryRow & { GROUP_KEY?: string }) {
      const scored = Number(row.PROPOSALS_SCORED) || 0;
      const improved = Number(row.IMPROVED_COUNT) || 0;
      const actualUnits = Number(row.ACTUAL_UNITS) || 0;
      const errBefore = Number(row.ERR_BEFORE) || 0;
      const errAfter = Number(row.ERR_AFTER) || 0;
      return {
        key: "GROUP_KEY" in row ? row.GROUP_KEY ?? "Unknown" : undefined,
        proposalsScored: scored,
        improvedCount: improved,
        winRate: scored > 0 ? improved / scored : null,
        errBefore,
        errAfter,
        actualUnits,
        wapeBefore: actualUnits > 0 ? errBefore / actualUnits : null,
        wapeAfter: actualUnits > 0 ? errAfter / actualUnits : null,
        unitsSaved: Number(row.UNITS_SAVED) || 0,
        valueSavedEur: Number(row.VALUE_SAVED_EUR) || 0,
      };
    }

    return NextResponse.json({
      context,
      integrity,
      filters: {
        path,
      },
      options: {
        hierarchy: hierarchyOptions,
      },
      summary: {
        naiveWape: toNullableNumber(fva.NAIVE_WAPE),
        statWape: toNullableNumber(fva.STAT_WAPE),
        consensusWape: toNullableNumber(fva.CONSENSUS_WAPE),
        modelFva: toNullableNumber(fva.MODEL_FVA),
        plannerFva: toNullableNumber(fva.PLANNER_FVA),
      },
      // The scoped query returns every lag. Keep horizons 1 to 8, ordered by lag
      // then model, as the page has always read them.
      accuracyByLag: lagRows
        .map((row) => ({
          modelName: row.MODEL_NAME,
          lagWeeks: Number(row.LAG_WEEKS),
          observations: Number(row.N_OBS),
          actualUnits: Number(row.ACTUAL_UNITS),
          wape: toNullableNumber(row.WAPE),
          bias: toNullableNumber(row.BIAS),
          intervalCoverage: toNullableNumber(row.INTERVAL_COVERAGE),
        }))
        .filter((row) => row.lagWeeks >= 1 && row.lagWeeks <= 8)
        .sort((left, right) =>
          left.lagWeeks - right.lagWeeks || left.modelName.localeCompare(right.modelName),
        ),
      overrideScorecard: {
        overrideCount: Number(overrides.OVERRIDE_COUNT),
        improved: Number(overrides.IMPROVED),
        worsened: Number(overrides.WORSENED),
        winRate: toNullableNumber(overrides.WIN_RATE),
        netUnitsSaved: toNullableNumber(overrides.NET_UNITS_SAVED),
      },
      worstOverrides: worstOverrides.map((row) => ({
        madeWeekId: row.MADE_WEEK_ID,
        targetWeekId: row.TARGET_WEEK_ID,
        seriesId: row.SERIES_ID,
        seriesLabel: row.SERIES_LABEL,
        productName: row.PRODUCT_NAME,
        customerName: row.CUSTOMER_NAME,
        reasonCode: row.REASON_CODE,
        reasonLabel: row.REASON_LABEL,
        statUnits: Number(row.STAT_UNITS),
        overrideUnits: Number(row.OVERRIDE_UNITS),
        actualUnits: Number(row.ACTUAL_UNITS),
        damageUnits: Number(row.DAMAGE_UNITS),
      })),
      agentScorecard: {
        summary: scorecardRowToJson(scorecard),
        byType: agentByType.map(scorecardRowToJson),
        byConfidenceBand: agentByConfidence.map(scorecardRowToJson),
        disabledRules: AGENT_DISABLED_RULES,
        note:
          "Measured on historical back-runs with seeded accept, edit-accept and reject decisions. Live proposals have no outturn yet, so they are not scored here.",
      },
    });
  } catch (err) {
    console.error("accuracy route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load accuracy" },
      { status: 500 },
    );
  }
}
