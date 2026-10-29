import { query } from "@/lib/snowflake";
import { getPersona } from "@/lib/persona";

export const dynamic = "force-dynamic";

export const SCENARIO_ID_PATTERN = /^[0-9a-fA-F-]{8,40}$/;
export const WEEK_ID_PATTERN = /^\d{4}-W\d{2}$/;
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 600;
export const MAX_NOTE_LENGTH = 600;

export const EDIT_LEVELS = {
  CATEGORY_NAME: "Category",
  PRODUCT_LINE: "Product family",
  CUSTOMER_NAME: "Customer",
  CHANNEL_NAME: "Channel",
} as const;

export const DISAGG_METHODS = {
  statistical: "Statistical share",
  current_plan: "Current plan share",
} as const;

export type EditLevel = keyof typeof EDIT_LEVELS;
export type DisaggMethodName = keyof typeof DISAGG_METHODS;

export interface ScenarioSummaryRow {
  SCENARIO_ID: string;
  SCENARIO_NAME: string;
  DESCRIPTION: string | null;
  STATUS: string;
  BASE_PLAN_WEEK: string;
  CREATED_BY: string;
  CREATED_AT: string;
  UPDATED_AT: string | null;
  PROMOTED_AT: string | null;
  PROMOTED_BY: string | null;
  PARENT_SCENARIO_ID: string | null;
  EDIT_COUNT: number;
  SERIES_EDITED: number;
  EDIT_GROUPS: number;
  AGENT_EDITS: number;
  DELTA_UNITS: number;
  DELTA_VALUE_EUR: number;
}

export interface ReasonRow {
  REASON_CODE: string;
  REASON_LABEL: string;
  REASON_GROUP: string;
  REQUIRES_NOTE: boolean;
}

export function isScenarioId(value: string | null | undefined): value is string {
  return Boolean(value && SCENARIO_ID_PATTERN.test(value));
}

export function isWeekId(value: string | null | undefined): value is string {
  return Boolean(value && WEEK_ID_PATTERN.test(value));
}

export function asEditLevel(value: string | null | undefined): EditLevel | null {
  if (!value) return null;
  return value in EDIT_LEVELS ? (value as EditLevel) : null;
}

export function asDisaggMethod(value: string | null | undefined): DisaggMethodName | null {
  if (!value) return null;
  return value in DISAGG_METHODS ? (value as DisaggMethodName) : null;
}

export function normaliseOptionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

export function normaliseRequiredText(
  value: unknown,
  maxLength: number,
): string | null {
  const trimmed = normaliseOptionalText(value, maxLength);
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function same2(left: number, right: number): boolean {
  return Math.abs(round2(left) - round2(right)) < 0.005;
}

/**
 * Who is acting, as written to EDITED_BY / SUBMITTED_BY / PROMOTED_BY.
 *
 * This is the simulated persona's display name (see src/lib/persona.ts), not
 * CURRENT_USER(): the app connects as one service user, so CURRENT_USER()
 * would attribute every edit to the same account. The approval audit trail
 * records CURRENT_USER() alongside the persona.
 */
export async function getActor(): Promise<string> {
  try {
    return (await getPersona()).displayName;
  } catch {
    return "Planner";
  }
}

export async function getScenarioSummary(
  scenarioId: string,
): Promise<ScenarioSummaryRow | null> {
  const rows = await query<ScenarioSummaryRow>(
    `SELECT SCENARIO_ID, SCENARIO_NAME, DESCRIPTION, STATUS, BASE_PLAN_WEEK,
            CREATED_BY, CREATED_AT, UPDATED_AT, PROMOTED_AT, PROMOTED_BY,
            PARENT_SCENARIO_ID, EDIT_COUNT, SERIES_EDITED, EDIT_GROUPS,
            AGENT_EDITS, DELTA_UNITS, DELTA_VALUE_EUR
     FROM APP.V_SCENARIO_SUMMARY
     WHERE SCENARIO_ID = ?`,
    [scenarioId],
  );
  return rows[0] ?? null;
}

export async function getReason(reasonCode: string): Promise<ReasonRow | null> {
  const rows = await query<ReasonRow>(
    `SELECT REASON_CODE, REASON_LABEL, REASON_GROUP, REQUIRES_NOTE
     FROM CORE.DIM_REASON_CODE
     WHERE REASON_CODE = ?`,
    [reasonCode],
  );
  return rows[0] ?? null;
}