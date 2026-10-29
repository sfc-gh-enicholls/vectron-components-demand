import {
  CHAINS,
  availableActions,
  canSubmit,
  planTransition,
  requiredRole,
  type ChainDefinition,
  type Persona,
  type RequestState,
} from "@/lib/workflow";

const planner: Persona = { userId: "u-kapoor", roleId: "demand_planner" };
const lead: Persona = { userId: "u-delacroix", roleId: "demand_lead", streamId: "planner" };
const sop: Persona = { userId: "u-rousseau", roleId: "sop_lead" };
const sales: Persona = { userId: "u-duval", roleId: "sales_lead", streamId: "sales" };

const submittedBy = (userId: string, step = 1): RequestState => ({
  status: "submitted",
  currentStep: step,
  requestedByUser: userId,
});

describe("canSubmit", () => {
  it("lets a planner submit a scenario for promotion", () => {
    expect(canSubmit(CHAINS.scenario_promote, planner).ok).toBe(true);
  });

  it("refuses a planner requesting cycle sign-off", () => {
    expect(canSubmit(CHAINS.cycle_signoff, planner).ok).toBe(false);
  });

  it("refuses the demand lead raising a promotion they would be the only one able to approve", () => {
    expect(canSubmit(CHAINS.scenario_promote, lead).ok).toBe(false);
  });

  it("lets a stream owner submit only their own stream", () => {
    expect(canSubmit(CHAINS.stream_submission, sales, "sales").ok).toBe(true);
    expect(canSubmit(CHAINS.stream_submission, sales, "finance").ok).toBe(false);
    expect(canSubmit(CHAINS.stream_submission, sales, null).ok).toBe(false);
  });

  it("refuses the demand lead submitting a stream input", () => {
    expect(canSubmit(CHAINS.stream_submission, lead, "planner").ok).toBe(false);
  });
});

describe("planTransition", () => {
  it("makes the step-role's approval final on a one-step chain", () => {
    const result = planTransition(CHAINS.scenario_promote, submittedBy(planner.userId), lead, "approve");
    expect(result).toEqual({
      ok: true,
      value: { toStatus: "approved", nextStep: 1, isFinal: true },
    });
  });

  it("refuses an approver who lacks the step role", () => {
    const result = planTransition(CHAINS.scenario_promote, submittedBy(planner.userId), sop, "approve");
    expect(result.ok).toBe(false);
  });

  it("refuses self-approval even when the requester holds the step role", () => {
    // A chain where the approver role may also submit.
    const open: ChainDefinition = { ...CHAINS.scenario_promote, submitRoles: ["demand_planner", "demand_lead"] };
    const result = planTransition(open, submittedBy(lead.userId), lead, "approve");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cannot decide a request you submitted/);
  });

  it("lets only the requester withdraw", () => {
    expect(planTransition(CHAINS.scenario_promote, submittedBy(planner.userId), planner, "withdraw").ok).toBe(true);
    expect(planTransition(CHAINS.scenario_promote, submittedBy(planner.userId), lead, "withdraw").ok).toBe(false);
  });

  it("maps reject and request_changes to their own terminal states", () => {
    const reject = planTransition(CHAINS.cycle_signoff, submittedBy(lead.userId), sop, "reject");
    const changes = planTransition(CHAINS.cycle_signoff, submittedBy(lead.userId), sop, "request_changes");
    expect(reject.ok && reject.value.toStatus).toBe("rejected");
    expect(changes.ok && changes.value.toStatus).toBe("changes_requested");
    expect(reject.ok && reject.value.isFinal).toBe(false);
  });

  it("treats every non-submitted status as closed", () => {
    for (const status of ["approved", "rejected", "changes_requested", "withdrawn"] as const) {
      const state: RequestState = { status, currentStep: 1, requestedByUser: planner.userId };
      expect(planTransition(CHAINS.scenario_promote, state, lead, "approve").ok).toBe(false);
      expect(planTransition(CHAINS.scenario_promote, state, planner, "withdraw").ok).toBe(false);
    }
  });

  it("advances, not finalises, an approval before the last step", () => {
    const twoStep: ChainDefinition = { ...CHAINS.scenario_promote, steps: ["demand_lead", "sop_lead"] };
    const first = planTransition(twoStep, submittedBy(planner.userId, 1), lead, "approve");
    expect(first).toEqual({ ok: true, value: { toStatus: "submitted", nextStep: 2, isFinal: false } });
    expect(planTransition(twoStep, submittedBy(planner.userId, 2), lead, "approve").ok).toBe(false);
    const second = planTransition(twoStep, submittedBy(planner.userId, 2), sop, "approve");
    expect(second.ok && second.value.isFinal).toBe(true);
  });

  it("refuses a request at an out-of-range step", () => {
    expect(planTransition(CHAINS.scenario_promote, submittedBy(planner.userId, 2), lead, "approve").ok).toBe(false);
  });
});

describe("requiredRole and availableActions", () => {
  it("names the step role while open and nothing once closed", () => {
    expect(requiredRole(CHAINS.cycle_signoff, submittedBy(lead.userId))).toBe("sop_lead");
    expect(requiredRole(CHAINS.cycle_signoff, { ...submittedBy(lead.userId), status: "approved" })).toBeNull();
  });

  it("offers the approver decisions and the requester only withdraw", () => {
    const state = submittedBy(planner.userId);
    expect(availableActions(CHAINS.scenario_promote, state, lead)).toEqual(["approve", "request_changes", "reject"]);
    expect(availableActions(CHAINS.scenario_promote, state, planner)).toEqual(["withdraw"]);
    expect(availableActions(CHAINS.scenario_promote, state, sop)).toEqual([]);
  });
});
