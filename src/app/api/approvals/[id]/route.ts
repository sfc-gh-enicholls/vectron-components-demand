import { NextRequest, NextResponse } from "next/server";
import { getPersona } from "@/lib/persona";
import {
  ApprovalError,
  MAX_APPROVAL_NOTE,
  actOnApproval,
  actionsFor,
  getApproval,
  listApprovalActions,
} from "@/lib/approvals";
import { isApprovalAction } from "@/lib/workflow";
import { startSolve } from "@/lib/supply";

export const dynamic = "force-dynamic";

const REQUEST_ID_PATTERN = /^[0-9a-zA-Z-]{8,40}$/;

function noteFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_APPROVAL_NOTE) : null;
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!REQUEST_ID_PATTERN.test(id)) {
      return NextResponse.json({ error: "Invalid request id." }, { status: 400 });
    }
    const [persona, row] = await Promise.all([getPersona(), getApproval(id)]);
    if (!row) return NextResponse.json({ error: "Approval request not found." }, { status: 404 });
    const history = await listApprovalActions([id]);
    return NextResponse.json({ request: row, actions: actionsFor(row, persona), history });
  } catch (err) {
    console.error("approval detail failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to load request" }, { status: 500 });
  }
}

/**
 * Act on a request. Body: { action, note?, confirm: true }.
 * Without confirm=true nothing is written: the response says what WOULD happen,
 * so the page can show the consequence before the approver commits to it.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!REQUEST_ID_PATTERN.test(id)) {
      return NextResponse.json({ error: "Invalid request id." }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!isApprovalAction(body.action)) {
      return NextResponse.json({ error: "action must be approve, reject, request_changes or withdraw." }, { status: 400 });
    }

    const persona = await getPersona();

    const row = await getApproval(id);
    if (!row) return NextResponse.json({ error: "Approval request not found." }, { status: 404 });

    const allowed = actionsFor(row, persona);
    if (body.confirm !== true) {
      return NextResponse.json({
        ok: true,
        action: "preview",
        request: row,
        allowed: allowed.includes(body.action),
        allowedActions: allowed,
        message: "Set confirm=true to apply this action.",
      });
    }

    const result = await actOnApproval({
      requestId: id,
      action: body.action,
      note: noteFrom(body.note),
      persona,
    });
    // An approved scenario promotion has just changed the committed plan, so
    // re-solve supply against it in the background. The approval does not
    // wait: it has already committed, and the supply page shows the solve.
    let supplySolve = null;
    if (
      row.OBJECT_TYPE === "scenario_promote" &&
      body.action === "approve" &&
      result.request.STATUS === "approved"
    ) {
      supplySolve = startSolve("COMMITTED", "promotion", persona.displayName);
    }
    return NextResponse.json({ ...result, supplySolve });
  } catch (err) {
    if (err instanceof ApprovalError) {
      return NextResponse.json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
    }
    console.error("approval action failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to act on request" }, { status: 500 });
  }
}
