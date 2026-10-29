/**
 * Raising approval requests for the two object types the app submits from
 * more than one place (scenario promotion from /scenarios and /approvals,
 * cycle sign-off from /approvals and /plan). Stream submissions are raised
 * by /api/plan-view, which stages the rows first.
 *
 * The SUMMARY is what the approver is shown, captured at submission so the
 * request still says what was asked for after the plan moves on.
 */
import { query } from "@/lib/snowflake";
import { getContext } from "@/lib/data";
import { getScenarioSummary } from "@/app/api/scenarios/shared";
import { ApprovalError, submitApproval } from "@/lib/approvals";
import type { AppPersona } from "@/lib/persona";

export async function submitScenarioPromotion(scenarioId: string, persona: AppPersona, note: string | null) {
  const scenario = await getScenarioSummary(scenarioId);
  if (!scenario) throw new ApprovalError("Scenario not found.", 404);
  const stale = await query<{ N: number }>(
    `SELECT COUNT(*) AS N
     FROM CORE.FACT_SCENARIO_EDIT e
     LEFT JOIN CORE.FACT_DEMAND_PLAN p ON p.SERIES_ID = e.SERIES_ID AND p.WEEK_ID = e.WEEK_ID
     WHERE e.SCENARIO_ID = ?
       AND (p.SERIES_ID IS NULL OR ABS(e.BASE_UNITS - p.PLAN_UNITS) >= 0.005)`,
    [scenarioId],
  );
  const staleCells = Number(stale[0]?.N) || 0;
  if (staleCells > 0) {
    throw new ApprovalError(
      `${staleCells} edited cell(s) were made against a plan value that has since changed. Rebase the scenario before submitting it.`,
      409,
    );
  }
  return submitApproval({
    objectType: "scenario_promote",
    objectId: scenarioId,
    title: `Promote “${scenario.SCENARIO_NAME}”`,
    summary: {
      scenarioName: scenario.SCENARIO_NAME,
      editCount: Number(scenario.EDIT_COUNT) || 0,
      seriesEdited: Number(scenario.SERIES_EDITED) || 0,
      agentEdits: Number(scenario.AGENT_EDITS) || 0,
      deltaUnits: Number(scenario.DELTA_UNITS) || 0,
      deltaValueEur: Number(scenario.DELTA_VALUE_EUR) || 0,
    },
    note,
    persona,
  });
}

export async function submitCycleSignoff(persona: AppPersona, note: string | null) {
  const context = await getContext();
  const rows = await query<{
    PLAN_UNITS: number;
    SIGNOFF_CYCLE_WEEK: string | null;
    COVERED_CURRENT: number | null;
    COVERED_SIGNOFF: number | null;
    OVERRIDDEN: number;
  }>(
    `SELECT SUM(CURRENT_UNITS) AS PLAN_UNITS,
            MAX(SIGNOFF_CYCLE_WEEK) AS SIGNOFF_CYCLE_WEEK,
            SUM(IFF(SIGNOFF_UNITS IS NULL, NULL, CURRENT_UNITS)) AS COVERED_CURRENT,
            SUM(SIGNOFF_UNITS) AS COVERED_SIGNOFF,
            (SELECT COUNT(*) FROM CORE.FACT_DEMAND_PLAN WHERE OVERRIDE_UNITS IS NOT NULL) AS OVERRIDDEN
     FROM APP.V_PLAN_VS_SIGNOFF`,
  );
  const row = rows[0];
  const coveredCurrent = row?.COVERED_CURRENT == null ? null : Number(row.COVERED_CURRENT);
  const coveredSignoff = row?.COVERED_SIGNOFF == null ? null : Number(row.COVERED_SIGNOFF);
  return submitApproval({
    objectType: "cycle_signoff",
    objectId: context.HISTORY_END_WEEK,
    title: `Sign off the ${context.HISTORY_END_WEEK} cycle`,
    summary: {
      cycleWeek: context.HISTORY_END_WEEK,
      horizon: `${context.CURRENT_WEEK} to ${context.HORIZON_END_WEEK}`,
      planUnits: Number(row?.PLAN_UNITS) || 0,
      overriddenCells: Number(row?.OVERRIDDEN) || 0,
      lastSignoffCycle: row?.SIGNOFF_CYCLE_WEEK ?? null,
      deltaVsLastSignoffUnits:
        coveredCurrent == null || coveredSignoff == null ? null : coveredCurrent - coveredSignoff,
    },
    note,
    persona,
  });
}
