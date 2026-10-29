import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/snowflake";
import {
  DECISION_STATUS,
  MAX_NOTE_LENGTH,
  asNumber,
  getActor,
  getScenarioSummary,
  isScenarioId,
  mergeScenarioEditRows,
  normaliseOptionalText,
  parseJsonText,
  round2,
  same2,
  touchScenario,
  type AgentQueueRow,
  type AgentWeekRow,
  type ScenarioEditMutationRow,
  type ScenarioPlanRow,
} from "../shared";

export const dynamic = "force-dynamic";

interface EditedWeekInput {
  weekId?: unknown;
  editUnits?: unknown;
}

interface DecisionPayload {
  proposalId?: unknown;
  decision?: unknown;
  targetScenarioId?: unknown;
  editedWeeks?: unknown;
  note?: unknown;
}

const LIVE_PROPOSED_FILTER = ["live", "proposed"] as const;

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function isDecision(value: unknown): value is keyof typeof DECISION_STATUS {
  return value === "accept" || value === "edit_accept" || value === "reject" || value === "defer";
}

function validateEditedWeeks(value: unknown): EditedWeekInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("editedWeeks must be an array of { weekId, editUnits } objects.");
  }
  return value as EditedWeekInput[];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as DecisionPayload;
    const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : "";
    const decision = body.decision;
    const targetScenarioId = typeof body.targetScenarioId === "string"
      ? body.targetScenarioId.trim()
      : "";
    const note = normaliseOptionalText(body.note, MAX_NOTE_LENGTH);

    if (!proposalId) {
      return badRequest("proposalId is required.");
    }
    if (!isDecision(decision)) {
      return badRequest("decision must be one of accept, edit_accept, reject, or defer.");
    }

    const proposalRows = await query<AgentQueueRow>(
      `SELECT PROPOSAL_ID, RUN_ID, AS_OF_WEEK, PROPOSAL_TYPE, STATUS, SERIES_ID,
              NODE_LEVEL, NODE_KEY, WEEK_FROM, WEEK_TO, CURRENT_UNITS,
              PROPOSED_UNITS, DELTA_UNITS, DELTA_VALUE_EUR, CONFIDENCE,
              REASON_CODE, REASON_LABEL, TRIGGER_SUMMARY, DIAGNOSIS, EVIDENCE,
              RATIONALE, RATIONALE_SOURCE, CREATED_AT, RUN_TYPE, NARRATIVE_MODE,
              MODEL_NAME, SERIES_LABEL, PRODUCT_NAME, CUSTOMER_NAME, CHANNEL_NAME,
              CATEGORY_NAME, SEGMENT_ABC, SEGMENT_XYZ, BASE_ANNUAL_VALUE_EUR,
              PRIORITY
       FROM APP.V_AGENT_QUEUE
       WHERE PROPOSAL_ID = ? AND RUN_TYPE = ? AND STATUS = ?`,
      [proposalId, ...LIVE_PROPOSED_FILTER],
    );
    const proposal = proposalRows[0];
    if (!proposal) {
      return badRequest("Proposal not found in the live inbox, or it has already been actioned.", 404);
    }
    if (!proposal.SERIES_ID) {
      return badRequest("Proposal does not resolve to a planning series and cannot be written to a scenario.", 409);
    }

    if ((decision === "accept" || decision === "edit_accept") && !isScenarioId(targetScenarioId)) {
      return badRequest("A draft scenario id is required. Agent proposals can never write to the committed plan.");
    }

    let scenarioId: string | null = null;
    if (decision === "accept" || decision === "edit_accept") {
      const scenario = await getScenarioSummary(targetScenarioId);
      if (!scenario) {
        return badRequest("Target scenario not found.", 404);
      }
      if (scenario.STATUS !== "draft") {
        return badRequest("Target scenario must be a draft. Agent proposals never write straight to the committed plan.", 409);
      }
      scenarioId = targetScenarioId;
    }

    const actor = await getActor();
    let appliedUnits: number | null = null;
    if (decision === "accept" || decision === "edit_accept") {
      const weekRows = await query<AgentWeekRow>(
        `SELECT PROPOSAL_ID, WEEK_ID, CURRENT_UNITS, PROPOSED_UNITS
         FROM CORE.FACT_AGENT_PROPOSAL_WEEK
         WHERE PROPOSAL_ID = ?
         ORDER BY WEEK_ID`,
        [proposalId],
      );
      if (!weekRows.length) {
        return badRequest("Proposal has no week-level detail, so it cannot be accepted honestly.", 409);
      }

      const planRows = await query<ScenarioPlanRow>(
        `SELECT SERIES_ID, WEEK_ID, PLAN_UNITS, IS_LOCKED
         FROM CORE.FACT_DEMAND_PLAN
         WHERE SERIES_ID = ?
           AND WEEK_ID IN (${weekRows.map(() => "?").join(",")})`,
        [proposal.SERIES_ID, ...weekRows.map((row) => row.WEEK_ID)],
      );

      const planByWeek = new Map(planRows.map((row) => [row.WEEK_ID, row]));
      if (planRows.length !== weekRows.length) {
        return badRequest(
          "One or more proposal weeks do not exist in CORE.FACT_DEMAND_PLAN. Refusing to write orphan scenario edits.",
          409,
        );
      }
      if (planRows.some((row) => Boolean(row.IS_LOCKED))) {
        return badRequest("One or more target weeks are locked. Unlock them before accepting this proposal into a scenario.", 409);
      }

      const overrides = new Map<string, number>();
      if (decision === "edit_accept") {
        const editedWeeks = validateEditedWeeks(body.editedWeeks);
        if (!editedWeeks.length) {
          return badRequest("edit_accept requires editedWeeks so the applied numbers are explicit.");
        }
        for (const row of editedWeeks) {
          const weekId = typeof row.weekId === "string" ? row.weekId.trim() : "";
          if (!weekId || !planByWeek.has(weekId)) {
            return badRequest(`Edited week '${weekId || "(blank)"}' is not part of this proposal.`);
          }
          const editUnits = asNumber(row.editUnits);
          if (!Number.isFinite(editUnits) || editUnits < 0) {
            return badRequest(`Edited units for ${weekId} must be a non-negative number.`);
          }
          overrides.set(weekId, round2(editUnits));
        }
      }

      const editGroupId = crypto.randomUUID();
      const rowsToMerge: ScenarioEditMutationRow[] = [];
      const rowsToDelete: string[] = [];

      appliedUnits = 0;
      for (const weekRow of weekRows) {
        const planRow = planByWeek.get(weekRow.WEEK_ID)!;
        const baseUnits = round2(Number(planRow.PLAN_UNITS) || 0);
        const targetUnits = decision === "accept"
          ? round2(Number(weekRow.PROPOSED_UNITS) || 0)
          : overrides.has(weekRow.WEEK_ID)
            ? overrides.get(weekRow.WEEK_ID)!
            : round2(Number(weekRow.PROPOSED_UNITS) || 0);

        appliedUnits += targetUnits;
        if (same2(targetUnits, baseUnits)) {
          rowsToDelete.push(weekRow.WEEK_ID);
          continue;
        }

        rowsToMerge.push({
          scenarioId: scenarioId!,
          seriesId: proposal.SERIES_ID,
          weekId: weekRow.WEEK_ID,
          baseUnits,
          editUnits: targetUnits,
          deltaUnits: round2(targetUnits - baseUnits),
          origin: "agent",
          sourceProposalId: proposalId,
          reasonCode: proposal.REASON_CODE,
          note,
          editGroupId,
          parentLevel: proposal.NODE_LEVEL,
          parentKey: proposal.NODE_KEY,
          disaggMethod: "direct",
          editedBy: actor,
        });
      }

      if (rowsToDelete.length) {
        for (const weekId of rowsToDelete) {
          await query(
            `DELETE FROM CORE.FACT_SCENARIO_EDIT
             WHERE SCENARIO_ID = ? AND SERIES_ID = ? AND WEEK_ID = ?`,
            [scenarioId!, proposal.SERIES_ID, weekId],
          );
        }
      }
      if (rowsToMerge.length) {
        await mergeScenarioEditRows(rowsToMerge);
      }
      await touchScenario(scenarioId!);
    }

    const decisionId = `DEC-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await query(
      `INSERT INTO CORE.FACT_AGENT_DECISION (
         DECISION_ID, PROPOSAL_ID, DECISION, DECIDED_BY, DECIDED_AT,
         APPLIED_UNITS, SCENARIO_ID, NOTE
       )
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(), ?, ?, ?)`,
      [decisionId, proposalId, decision, actor, appliedUnits, scenarioId, note],
    );
    await query(
      `UPDATE CORE.FACT_AGENT_PROPOSAL
       SET STATUS = ?
       WHERE PROPOSAL_ID = ?`,
      [DECISION_STATUS[decision], proposalId],
    );

    return NextResponse.json({
      ok: true,
      proposalId,
      decision,
      scenarioId,
      appliedUnits,
      diagnosis: parseJsonText<Record<string, unknown> | null>(proposal.DIAGNOSIS, null),
    });
  } catch (err) {
    console.error("agent decision failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to record agent decision" },
      { status: 500 },
    );
  }
}