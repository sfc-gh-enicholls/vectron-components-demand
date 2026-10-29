import { NextRequest, NextResponse } from "next/server";
import { getPersona } from "@/lib/persona";
import {
  ApprovalError,
  MAX_APPROVAL_NOTE,
  actionsFor,
  listApprovalActions,
  listApprovals,
} from "@/lib/approvals";
import { submitCycleSignoff, submitScenarioPromotion } from "@/lib/approval-objects";
import { isObjectType, type RequestStatus } from "@/lib/workflow";
import { query } from "@/lib/snowflake";

export const dynamic = "force-dynamic";

const STATUSES: RequestStatus[] = ["submitted", "approved", "rejected", "changes_requested", "withdrawn"];

interface CycleRow {
  CYCLE_WEEK: string;
  STATUS: string;
  SIGNED_OFF_BY: string | null;
  SIGNED_OFF_AT: string | null;
  SNAPSHOT_ROWS: number | null;
  SNAPSHOT_SOURCE: string | null;
  IS_CURRENT: boolean;
}

/** The inbox: requests, what this persona can do on each, and their history. */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const objectType = params.get("objectType");
    const status = params.get("status");
    const objectId = params.get("objectId");
    const persona = await getPersona();

    const [rows, cycles] = await Promise.all([
      listApprovals({
        objectType: isObjectType(objectType) ? objectType : undefined,
        status: STATUSES.includes(status as RequestStatus) ? (status as RequestStatus) : undefined,
        objectId: objectId && objectId.length <= 80 ? objectId : undefined,
      }),
      query<CycleRow>(
        `SELECT CYCLE_WEEK, STATUS, SIGNED_OFF_BY, SIGNED_OFF_AT, SNAPSHOT_ROWS, SNAPSHOT_SOURCE, IS_CURRENT
         FROM APP.V_PLAN_CYCLE ORDER BY CYCLE_WEEK DESC`,
      ),
    ]);
    const history = await listApprovalActions(rows.map((row) => row.REQUEST_ID));

    return NextResponse.json({
      persona,
      requests: rows.map((row) => ({
        ...row,
        summary: (() => {
          try {
            return row.SUMMARY ? JSON.parse(row.SUMMARY) : null;
          } catch {
            return null;
          }
        })(),
        actions: actionsFor(row, persona),
        history: history.filter((action) => action.REQUEST_ID === row.REQUEST_ID),
      })),
      cycles,
      currentCycle: cycles.find((cycle) => cycle.IS_CURRENT) ?? null,
    });
  } catch (err) {
    console.error("approvals route failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to load approvals" }, { status: 500 });
  }
}

/**
 * Raise a request. Body: { objectType: "scenario_promote" | "cycle_signoff",
 * objectId?, note?, confirm: true }. Stream submissions are raised by
 * /api/plan-view, which stages their rows first.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.confirm !== true) {
      return NextResponse.json({ error: "Set confirm=true to submit this for approval." }, { status: 409 });
    }
    const persona = await getPersona();
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, MAX_APPROVAL_NOTE) : null;

    if (body.objectType === "scenario_promote") {
      if (typeof body.objectId !== "string" || !/^[0-9a-fA-F-]{8,40}$/.test(body.objectId)) {
        return NextResponse.json({ error: "objectId must be a scenario id." }, { status: 400 });
      }
      const result = await submitScenarioPromotion(body.objectId, persona, note);
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }
    if (body.objectType === "cycle_signoff") {
      const result = await submitCycleSignoff(persona, note);
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }
    return NextResponse.json(
      { error: "objectType must be scenario_promote or cycle_signoff. Stream inputs are submitted from /plan." },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof ApprovalError) {
      return NextResponse.json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
    }
    console.error("approval submit failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to submit" }, { status: 500 });
  }
}
