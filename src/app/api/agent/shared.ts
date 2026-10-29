import {
  MAX_NOTE_LENGTH,
  getActor,
  getScenarioSummary,
  isScenarioId,
  normaliseOptionalText,
  round2,
  same2,
} from "@/app/api/scenarios/shared";
import { query } from "@/lib/snowflake";

export { MAX_NOTE_LENGTH, getActor, getScenarioSummary, isScenarioId, normaliseOptionalText, round2, same2 };

export const dynamic = "force-dynamic";

export const PRIORITY_ORDER = ["Critical", "High", "Medium", "Low"] as const;

export const PRIORITY_RANK: Record<string, number> = {
  Critical: 1,
  High: 2,
  Medium: 3,
  Low: 4,
};

export const DECISION_STATUS: Record<string, string> = {
  accept: "accepted",
  edit_accept: "edited_accepted",
  reject: "rejected",
  defer: "deferred",
};

export interface AgentQueueRow {
  PROPOSAL_ID: string;
  RUN_ID: string;
  AS_OF_WEEK: string;
  PROPOSAL_TYPE: string;
  STATUS: string;
  SERIES_ID: string | null;
  NODE_LEVEL: string | null;
  NODE_KEY: string | null;
  WEEK_FROM: string;
  WEEK_TO: string;
  CURRENT_UNITS: number;
  PROPOSED_UNITS: number;
  DELTA_UNITS: number;
  DELTA_VALUE_EUR: number;
  CONFIDENCE: number;
  REASON_CODE: string | null;
  REASON_LABEL: string | null;
  TRIGGER_SUMMARY: string;
  DIAGNOSIS: string | null;
  EVIDENCE: string | null;
  RATIONALE: string | null;
  RATIONALE_SOURCE: string;
  CREATED_AT: string;
  RUN_TYPE: string;
  NARRATIVE_MODE: string;
  MODEL_NAME: string | null;
  SERIES_LABEL: string | null;
  PRODUCT_NAME: string | null;
  CUSTOMER_NAME: string | null;
  CHANNEL_NAME: string | null;
  CATEGORY_NAME: string | null;
  SEGMENT_ABC: string | null;
  SEGMENT_XYZ: string | null;
  BASE_ANNUAL_VALUE_EUR: number | null;
  PRIORITY: string;
}

export interface AgentWeekRow {
  PROPOSAL_ID: string;
  WEEK_ID: string;
  CURRENT_UNITS: number;
  PROPOSED_UNITS: number;
}

export interface DraftScenarioRow {
  SCENARIO_ID: string;
  SCENARIO_NAME: string;
  DESCRIPTION: string | null;
  BASE_PLAN_WEEK: string;
  EDIT_COUNT: number;
  AGENT_EDITS: number;
  UPDATED_AT: string | null;
  CREATED_AT: string;
}

export interface LiveRunRow {
  RUN_ID: string;
  AS_OF_WEEK: string;
  RUN_TYPE: string;
  STARTED_AT: string;
  COMPLETED_AT: string | null;
  STATUS: string;
  PROPOSAL_COUNT: number;
  NARRATIVE_MODE: string;
  MODEL_NAME: string | null;
  CORTEX_CALLS: number;
  CORTEX_FALLBACKS: number;
}

export interface AgentSignalSummaryRow {
  PROPOSAL_ID: string;
  SIGNALS: number;
  AGREE_COUNT: number;
  DISAGREE_COUNT: number;
  NEUTRAL_COUNT: number;
  EXTERNAL_SIGNALS: number;
  SIMULATED_SIGNALS: number;
  NET_SUPPORT: number;
  IS_CONTESTED: boolean;
  DISSENTING_SOURCES: string | null;
}

export interface AgentSignalRow {
  PROPOSAL_ID: string;
  SOURCE_ID: string;
  STANCE: "agrees" | "disagrees" | "neutral";
  SIGNAL_TEXT: string;
  STRENGTH: number;
  SOURCE_NAME: string;
  SOURCE_KIND: "internal" | "external_programme";
  OWNER_DOMAIN: string;
  DESCRIPTION: string | null;
  IS_SIMULATED: boolean;
  DISPLAY_ORDER: number;
}

export interface ScenarioPlanRow {
  SERIES_ID: string;
  WEEK_ID: string;
  PLAN_UNITS: number;
  IS_LOCKED: boolean;
}

export interface ScenarioEditMutationRow {
  scenarioId: string;
  seriesId: string;
  weekId: string;
  baseUnits: number;
  editUnits: number;
  deltaUnits: number;
  origin: string;
  sourceProposalId: string | null;
  reasonCode: string | null;
  note: string | null;
  editGroupId: string;
  parentLevel: string | null;
  parentKey: string | null;
  disaggMethod: string;
  editedBy: string;
}

export function badRequest(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export function parseJsonText<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export async function mergeScenarioEditRows(rows: ScenarioEditMutationRow[]) {
  if (!rows.length) return;

  const selects = rows
    .map(
      () => `SELECT ? AS SCENARIO_ID, ? AS SERIES_ID, ? AS WEEK_ID, ? AS BASE_UNITS,
                    ? AS EDIT_UNITS, ? AS DELTA_UNITS, ? AS ORIGIN,
                    ? AS SOURCE_PROPOSAL_ID, ? AS REASON_CODE, ? AS NOTE,
                    ? AS EDIT_GROUP_ID, ? AS PARENT_LEVEL, ? AS PARENT_KEY,
                    ? AS DISAGG_METHOD, ? AS EDITED_BY`,
    )
    .join(" UNION ALL ");

  const binds = rows.flatMap((row) => [
    row.scenarioId,
    row.seriesId,
    row.weekId,
    row.baseUnits,
    row.editUnits,
    row.deltaUnits,
    row.origin,
    row.sourceProposalId,
    row.reasonCode,
    row.note,
    row.editGroupId,
    row.parentLevel,
    row.parentKey,
    row.disaggMethod,
    row.editedBy,
  ]);

  await query(
    `MERGE INTO CORE.FACT_SCENARIO_EDIT AS target
     USING (${selects}) AS source
     ON target.SCENARIO_ID = source.SCENARIO_ID
        AND target.SERIES_ID = source.SERIES_ID
        AND target.WEEK_ID = source.WEEK_ID
     WHEN MATCHED THEN UPDATE SET
       BASE_UNITS = source.BASE_UNITS,
       EDIT_UNITS = source.EDIT_UNITS,
       DELTA_UNITS = source.DELTA_UNITS,
       ORIGIN = source.ORIGIN,
       SOURCE_PROPOSAL_ID = source.SOURCE_PROPOSAL_ID,
       REASON_CODE = source.REASON_CODE,
       NOTE = source.NOTE,
       EDIT_GROUP_ID = source.EDIT_GROUP_ID,
       PARENT_LEVEL = source.PARENT_LEVEL,
       PARENT_KEY = source.PARENT_KEY,
       DISAGG_METHOD = source.DISAGG_METHOD,
       EDITED_BY = source.EDITED_BY,
       EDITED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (
       SCENARIO_ID, SERIES_ID, WEEK_ID, BASE_UNITS, EDIT_UNITS, DELTA_UNITS,
       ORIGIN, SOURCE_PROPOSAL_ID, REASON_CODE, NOTE, EDIT_GROUP_ID,
       PARENT_LEVEL, PARENT_KEY, DISAGG_METHOD, EDITED_BY, EDITED_AT
     ) VALUES (
       source.SCENARIO_ID, source.SERIES_ID, source.WEEK_ID, source.BASE_UNITS,
       source.EDIT_UNITS, source.DELTA_UNITS, source.ORIGIN,
       source.SOURCE_PROPOSAL_ID, source.REASON_CODE, source.NOTE,
       source.EDIT_GROUP_ID, source.PARENT_LEVEL, source.PARENT_KEY,
       source.DISAGG_METHOD, source.EDITED_BY, CURRENT_TIMESTAMP()
     )`,
    binds,
  );
}

export async function deleteScenarioEditRows(
  scenarioId: string,
  weekId: string,
  seriesIds: string[],
) {
  if (!seriesIds.length) return;

  await query(
    `DELETE FROM CORE.FACT_SCENARIO_EDIT
     WHERE SCENARIO_ID = ?
       AND WEEK_ID = ?
       AND SERIES_ID IN (${seriesIds.map(() => "?").join(",")})`,
    [scenarioId, weekId, ...seriesIds],
  );
}

export async function touchScenario(scenarioId: string) {
  await query(
    `UPDATE CORE.DIM_SCENARIO
     SET UPDATED_AT = CURRENT_TIMESTAMP()
     WHERE SCENARIO_ID = ?`,
    [scenarioId],
  );
}