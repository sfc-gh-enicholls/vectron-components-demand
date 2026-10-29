/**
 * Approval workflow state machine.
 *
 * PURE: no I/O, so the rules can be unit-tested and the API cannot apply a
 * transition the tests have not covered. The stored procedures in
 * snowflake/13-approvals.sql perform the atomic write and re-check that the
 * request has not moved since it was read; this module decides whether the
 * transition is allowed at all.
 *
 * Roles are SIMULATED personas (see DIM_APP_USER): the app connects to
 * Snowflake as a single user, so CURRENT_USER() cannot distinguish them.
 */

export type ObjectType = "scenario_promote" | "stream_submission" | "cycle_signoff";
export type RequestStatus =
  | "submitted"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "withdrawn";
export type ApprovalAction = "approve" | "reject" | "request_changes" | "withdraw";
export type RoleId =
  | "demand_planner"
  | "demand_lead"
  | "sales_lead"
  | "marketing_lead"
  | "finance_lead"
  | "sop_lead";

export interface ChainDefinition {
  chainId: string;
  objectType: ObjectType;
  submitRoles: RoleId[];
  /** Required role per step, in order. Step numbers are 1-based. */
  steps: RoleId[];
}

export interface Persona {
  userId: string;
  roleId: RoleId;
  /** Consensus stream the persona owns, if any. */
  streamId?: string | null;
}

export interface RequestState {
  status: RequestStatus;
  currentStep: number;
  requestedByUser: string;
}

export interface TransitionPlan {
  toStatus: RequestStatus;
  nextStep: number;
  /** True when this approval completes the chain and the object's effect runs. */
  isFinal: boolean;
}

export type Decision<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * The chains the app ships with. These mirror the rows seeded in
 * 13-approvals.sql; `chainsMatchSeed` in the API asserts they agree, so the
 * two cannot drift silently.
 */
export const CHAINS: Record<ObjectType, ChainDefinition> = {
  scenario_promote: {
    chainId: "chain-scenario-promote",
    objectType: "scenario_promote",
    // Planners only. The demand lead is the one approver, and nobody may decide
    // their own request, so a lead-raised promotion could never be approved.
    submitRoles: ["demand_planner"],
    steps: ["demand_lead"],
  },
  stream_submission: {
    chainId: "chain-stream-submission",
    objectType: "stream_submission",
    submitRoles: ["sales_lead", "marketing_lead", "finance_lead"],
    steps: ["demand_lead"],
  },
  cycle_signoff: {
    chainId: "chain-cycle-signoff",
    objectType: "cycle_signoff",
    submitRoles: ["demand_lead"],
    steps: ["sop_lead"],
  },
};

export const ROLE_LABELS: Record<RoleId, string> = {
  demand_planner: "Demand planner",
  demand_lead: "Demand planning lead",
  sales_lead: "Commercial director",
  marketing_lead: "Product director",
  finance_lead: "FP&A manager",
  sop_lead: "S&OP lead",
};

export const STATUS_LABELS: Record<RequestStatus, string> = {
  submitted: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
  withdrawn: "Withdrawn",
};

const ACTION_TARGET: Record<ApprovalAction, RequestStatus> = {
  approve: "approved",
  reject: "rejected",
  request_changes: "changes_requested",
  withdraw: "withdrawn",
};

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && value in ROLE_LABELS;
}

export function isApprovalAction(value: unknown): value is ApprovalAction {
  return typeof value === "string" && value in ACTION_TARGET;
}

export function isObjectType(value: unknown): value is ObjectType {
  return typeof value === "string" && value in CHAINS;
}

/**
 * Can this persona raise a request on this chain?
 * A stream owner may only submit their own stream.
 */
export function canSubmit(
  chain: ChainDefinition,
  persona: Persona,
  streamId?: string | null,
): Decision<true> {
  if (!chain.submitRoles.includes(persona.roleId)) {
    return {
      ok: false,
      reason: `${ROLE_LABELS[persona.roleId]} cannot submit this. It needs ${chain.submitRoles
        .map((role) => ROLE_LABELS[role])
        .join(" or ")}.`,
    };
  }
  if (chain.objectType === "stream_submission") {
    if (!streamId) return { ok: false, reason: "A stream submission must name its stream." };
    if (persona.streamId !== streamId) {
      return {
        ok: false,
        reason: `${ROLE_LABELS[persona.roleId]} owns the ${persona.streamId ?? "no"} stream and cannot submit ${streamId}.`,
      };
    }
  }
  return { ok: true, value: true };
}

/** The role that must act on the request's current step, or null when closed. */
export function requiredRole(chain: ChainDefinition, state: RequestState): RoleId | null {
  if (state.status !== "submitted") return null;
  return chain.steps[state.currentStep - 1] ?? null;
}

/**
 * Decide whether `persona` may take `action` on a request, and what the
 * resulting state is. This is the whole rule set:
 *
 * - Only a `submitted` request can be acted on; every other status is terminal
 *   (a request with changes requested is resubmitted as a NEW request).
 * - `withdraw` is the requester's alone, at any step.
 * - approve / reject / request_changes need the step's role, and the requester
 *   can never decide their own request, even if they hold that role.
 * - approve on the last step is final; earlier steps advance.
 */
export function planTransition(
  chain: ChainDefinition,
  state: RequestState,
  persona: Persona,
  action: ApprovalAction,
): Decision<TransitionPlan> {
  if (chain.steps.length === 0) {
    return { ok: false, reason: "This approval chain has no steps." };
  }
  if (state.status !== "submitted") {
    return {
      ok: false,
      reason: `This request is already ${STATUS_LABELS[state.status].toLowerCase()}.`,
    };
  }
  if (state.currentStep < 1 || state.currentStep > chain.steps.length) {
    return { ok: false, reason: "This request is at an unknown step." };
  }

  const isRequester = persona.userId === state.requestedByUser;

  if (action === "withdraw") {
    if (!isRequester) {
      return { ok: false, reason: "Only the person who submitted a request can withdraw it." };
    }
    return {
      ok: true,
      value: { toStatus: "withdrawn", nextStep: state.currentStep, isFinal: false },
    };
  }

  if (isRequester) {
    return { ok: false, reason: "You cannot decide a request you submitted." };
  }

  const role = chain.steps[state.currentStep - 1];
  if (persona.roleId !== role) {
    return {
      ok: false,
      reason: `This step needs the ${ROLE_LABELS[role]}. You are acting as ${ROLE_LABELS[persona.roleId]}.`,
    };
  }

  if (action === "approve") {
    const isLast = state.currentStep === chain.steps.length;
    return {
      ok: true,
      value: isLast
        ? { toStatus: "approved", nextStep: state.currentStep, isFinal: true }
        : { toStatus: "submitted", nextStep: state.currentStep + 1, isFinal: false },
    };
  }

  return {
    ok: true,
    value: { toStatus: ACTION_TARGET[action], nextStep: state.currentStep, isFinal: false },
  };
}

/** Actions this persona can take right now, for rendering buttons. */
export function availableActions(
  chain: ChainDefinition,
  state: RequestState,
  persona: Persona,
): ApprovalAction[] {
  return (["approve", "request_changes", "reject", "withdraw"] as ApprovalAction[]).filter(
    (action) => planTransition(chain, state, persona, action).ok,
  );
}
