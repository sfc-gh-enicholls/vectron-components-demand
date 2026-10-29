/**
 * Approvals service: the server side of src/lib/workflow.ts.
 *
 * Every transition is decided by the pure state machine first, then written by
 * a stored procedure (snowflake/13-approvals.sql) that re-checks the request has
 * not moved and applies the effect, if any, in one transaction. Nothing here
 * writes FACT_DEMAND_PLAN, FACT_PLAN_INPUT or FACT_PLAN_SNAPSHOT directly.
 */
import { query } from "@/lib/snowflake";
import { getSnowflakeUser, type AppPersona } from "@/lib/persona";
import {
  CHAINS,
  availableActions,
  canSubmit,
  isObjectType,
  planTransition,
  type ApprovalAction,
  type ObjectType,
  type RequestState,
  type RequestStatus,
  type RoleId,
} from "@/lib/workflow";

export interface ApprovalRow {
  REQUEST_ID: string;
  CHAIN_ID: string;
  CHAIN_LABEL: string;
  OBJECT_TYPE: string;
  OBJECT_ID: string;
  CYCLE_WEEK: string;
  STATUS: RequestStatus;
  CURRENT_STEP: number;
  STEP_COUNT: number;
  NEXT_ROLE_ID: string | null;
  NEXT_ROLE_LABEL: string | null;
  NEXT_STEP_LABEL: string | null;
  TITLE: string;
  SUMMARY: string | null;
  REQUESTED_BY_USER: string;
  REQUESTED_BY_NAME: string | null;
  REQUESTED_BY_ROLE: string | null;
  REQUESTED_BY_SF: string;
  REQUESTED_AT: string;
  DECIDED_AT: string | null;
}

export interface ApprovalActionRow {
  ACTION_ID: string;
  REQUEST_ID: string;
  STEP_NO: number;
  ACTION: string;
  FROM_STATUS: string | null;
  TO_STATUS: string;
  ACTOR_USER_ID: string;
  ACTOR_NAME: string | null;
  ACTOR_SF_USER: string;
  NOTE: string | null;
  ACTED_AT: string;
}

export interface ProcResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  stale?: number;
  locked?: number;
  status?: string;
  requestId?: string;
  rowsApplied?: number;
}

export class ApprovalError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: ProcResult) {
    super(message);
  }
}

export const MAX_APPROVAL_NOTE = 600;

function parseProcResult(value: unknown): ProcResult {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as ProcResult;
    } catch {
      return { ok: false, error: value };
    }
  }
  if (value && typeof value === "object") return value as ProcResult;
  return { ok: false, error: "The procedure returned no result." };
}

async function callProc(name: string, binds: (string | number | boolean | null)[]): Promise<ProcResult> {
  const placeholders = binds.map(() => "?").join(", ");
  const rows = await query<Record<string, unknown>>(`CALL CORE.${name}(${placeholders})`, binds);
  const row = rows[0] ?? {};
  return parseProcResult(row[name] ?? Object.values(row)[0]);
}

function toState(row: ApprovalRow): RequestState {
  return {
    status: row.STATUS,
    currentStep: Number(row.CURRENT_STEP) || 1,
    requestedByUser: row.REQUESTED_BY_USER,
  };
}

const QUEUE_COLUMNS = `REQUEST_ID, CHAIN_ID, CHAIN_LABEL, OBJECT_TYPE, OBJECT_ID, CYCLE_WEEK,
  STATUS, CURRENT_STEP, STEP_COUNT, NEXT_ROLE_ID, NEXT_ROLE_LABEL, NEXT_STEP_LABEL, TITLE,
  SUMMARY, REQUESTED_BY_USER, REQUESTED_BY_NAME, REQUESTED_BY_ROLE, REQUESTED_BY_SF,
  REQUESTED_AT, DECIDED_AT`;

export async function getApproval(requestId: string): Promise<ApprovalRow | null> {
  const rows = await query<ApprovalRow>(
    `SELECT ${QUEUE_COLUMNS} FROM APP.V_APPROVAL_QUEUE WHERE REQUEST_ID = ?`,
    [requestId],
  );
  return rows[0] ?? null;
}

export async function listApprovals(filter: {
  objectType?: ObjectType;
  objectId?: string;
  status?: RequestStatus;
  limit?: number;
} = {}): Promise<ApprovalRow[]> {
  const where: string[] = [];
  const binds: string[] = [];
  if (filter.objectType) {
    where.push("OBJECT_TYPE = ?");
    binds.push(filter.objectType);
  }
  if (filter.objectId) {
    where.push("OBJECT_ID = ?");
    binds.push(filter.objectId);
  }
  if (filter.status) {
    where.push("STATUS = ?");
    binds.push(filter.status);
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  return query<ApprovalRow>(
    `SELECT ${QUEUE_COLUMNS}
     FROM APP.V_APPROVAL_QUEUE
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY IFF(STATUS = 'submitted', 0, 1), REQUESTED_AT DESC
     LIMIT ${limit}`,
    binds,
  );
}

export async function listApprovalActions(requestIds: string[]): Promise<ApprovalActionRow[]> {
  if (requestIds.length === 0) return [];
  return query<ApprovalActionRow>(
    `SELECT a.ACTION_ID, a.REQUEST_ID, a.STEP_NO, a.ACTION, a.FROM_STATUS, a.TO_STATUS,
            a.ACTOR_USER_ID, u.DISPLAY_NAME AS ACTOR_NAME, a.ACTOR_SF_USER, a.NOTE, a.ACTED_AT
     FROM CORE.FACT_APPROVAL_ACTION a
     LEFT JOIN CORE.DIM_APP_USER u ON u.USER_ID = a.ACTOR_USER_ID
     WHERE a.REQUEST_ID IN (${requestIds.map(() => "?").join(", ")})
     ORDER BY a.ACTED_AT, a.ACTION_ID`,
    requestIds,
  );
}

/** The actions `persona` may take on `row`, decided by the pure state machine. */
export function actionsFor(row: ApprovalRow, persona: AppPersona): ApprovalAction[] {
  if (!isObjectType(row.OBJECT_TYPE)) return [];
  return availableActions(CHAINS[row.OBJECT_TYPE], toState(row), persona);
}

/**
 * Guard against the TypeScript chain definition and the seeded chain drifting.
 * If someone edits DIM_APPROVAL_STEP without editing CHAINS (or the reverse),
 * every transition is refused rather than decided against the wrong rules.
 */
let chainCheck: Promise<void> | null = null;
async function assertChainsMatchSeed(): Promise<void> {
  chainCheck ??= (async () => {
    const rows = await query<{ OBJECT_TYPE: string; CHAIN_ID: string; STEP_NO: number; ROLE_ID: string; SUBMIT_ROLES: string }>(
      `SELECT c.OBJECT_TYPE, c.CHAIN_ID, s.STEP_NO, s.ROLE_ID, c.SUBMIT_ROLES
       FROM CORE.DIM_APPROVAL_CHAIN c
       JOIN CORE.DIM_APPROVAL_STEP s ON s.CHAIN_ID = c.CHAIN_ID
       ORDER BY c.OBJECT_TYPE, s.STEP_NO`,
    );
    for (const chain of Object.values(CHAINS)) {
      const seeded = rows.filter((row) => row.OBJECT_TYPE === chain.objectType);
      const seededSteps = seeded.map((row) => row.ROLE_ID).join(",");
      const seededSubmit = seeded[0]?.SUBMIT_ROLES ?? "";
      if (
        seeded[0]?.CHAIN_ID !== chain.chainId ||
        seededSteps !== chain.steps.join(",") ||
        seededSubmit !== chain.submitRoles.join(",")
      ) {
        throw new Error(
          `Approval chain '${chain.objectType}' in the database does not match src/lib/workflow.ts. Re-run snowflake/13-approvals.sql or update CHAINS.`,
        );
      }
    }
  })().catch((err) => {
    chainCheck = null;
    throw err;
  });
  return chainCheck;
}

export interface SubmitInput {
  objectType: ObjectType;
  objectId: string;
  title: string;
  summary: Record<string, unknown>;
  note: string | null;
  persona: AppPersona;
  /** Required for stream_submission: the stream being submitted. */
  streamId?: string | null;
  /** Supply when rows have been staged under this id (stream_submission). */
  requestId?: string;
}

export async function submitApproval(input: SubmitInput): Promise<{ requestId: string }> {
  await assertChainsMatchSeed();
  const chain = CHAINS[input.objectType];
  const allowed = canSubmit(chain, input.persona, input.streamId);
  if (!allowed.ok) throw new ApprovalError(allowed.reason, 403);

  const requestId = input.requestId ?? crypto.randomUUID();
  const result = await callProc("SP_SUBMIT_REQUEST", [
    requestId,
    chain.chainId,
    input.objectId,
    input.title.slice(0, 200),
    JSON.stringify(input.summary).slice(0, 4000),
    input.persona.userId,
    await getSnowflakeUser(),
    input.note,
    crypto.randomUUID(),
  ]);
  if (!result.ok) throw new ApprovalError(result.error ?? "Submission failed.", 409, result);
  return { requestId };
}

export async function actOnApproval(input: {
  requestId: string;
  action: ApprovalAction;
  note: string | null;
  persona: AppPersona;
}): Promise<ProcResult & { request: ApprovalRow }> {
  await assertChainsMatchSeed();
  const row = await getApproval(input.requestId);
  if (!row) throw new ApprovalError("Approval request not found.", 404);
  if (!isObjectType(row.OBJECT_TYPE)) throw new ApprovalError("Unknown approval type.", 400);

  const chain = CHAINS[row.OBJECT_TYPE];
  const state = toState(row);
  const plan = planTransition(chain, state, input.persona, input.action);
  if (!plan.ok) throw new ApprovalError(plan.reason, 403);

  if ((input.action === "reject" || input.action === "request_changes") && !input.note) {
    throw new ApprovalError("Say why: a rejection or change request needs a note.", 400);
  }

  const result = await callProc("SP_ACT_ON_REQUEST", [
    input.requestId,
    input.action,
    input.persona.userId,
    await getSnowflakeUser(),
    input.note,
    state.status,
    state.currentStep,
    plan.value.toStatus,
    plan.value.nextStep,
    plan.value.isFinal,
    crypto.randomUUID(),
  ]);
  if (!result.ok) {
    throw new ApprovalError(result.error ?? "The action failed.", result.conflict ? 409 : 422, result);
  }
  const updated = await getApproval(input.requestId);
  return { ...result, request: updated ?? row };
}

/** The open request on an object, if any. */
export async function openRequestFor(objectType: ObjectType, objectId: string): Promise<ApprovalRow | null> {
  const rows = await listApprovals({ objectType, objectId, status: "submitted", limit: 1 });
  return rows[0] ?? null;
}

export function roleCanApproveSomething(roleId: RoleId): boolean {
  return Object.values(CHAINS).some((chain) => chain.steps.includes(roleId));
}
