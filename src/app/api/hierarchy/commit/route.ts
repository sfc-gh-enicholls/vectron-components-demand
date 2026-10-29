import { NextRequest, NextResponse } from "next/server";
import { pickLevels, parseHierarchyPath, rollupsOf } from "@/lib/hierarchy-path";
import {
  buildPreview,
  commitPreview,
  deleteEditGroup,
  drillOrder,
  loadHierarchyPayload,
  parseCommitApplyBody,
} from "../shared";
import { getScenarioSummary, isScenarioId } from "../../scenarios/shared";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    // ROLLUP_* query params name the drill order the node key was built in.
    const rollupScope = pickLevels(parseHierarchyPath(request.nextUrl.searchParams), []);
    const rollups = rollupsOf(rollupScope);
    const body = await request.json();
    if (body && typeof body === "object" && (body as Record<string, unknown>).action === "revert") {
      // Narrow once into locals rather than repeatedly asserting on the raw
      // body: the repeated casts read as unknown to the compiler and lost the
      // string type that had just been checked.
      const raw = body as Record<string, unknown>;
      const scenarioId = typeof raw.scenarioId === "string" ? raw.scenarioId : null;
      const editGroupId = typeof raw.editGroupId === "string" ? raw.editGroupId.trim() : "";
      if (!isScenarioId(scenarioId)) {
        return NextResponse.json({ error: "scenarioId must be a valid scenario id." }, { status: 400 });
      }
      if (!editGroupId) {
        return NextResponse.json({ error: "editGroupId is required." }, { status: 400 });
      }
      const scenario = await getScenarioSummary(scenarioId);
      if (!scenario) {
        return NextResponse.json({ error: "Scenario not found." }, { status: 404 });
      }
      if (scenario.STATUS !== "draft") {
        return NextResponse.json({ error: "Only draft scenarios can be edited." }, { status: 409 });
      }

      const deletedRows = await deleteEditGroup(scenarioId, editGroupId);
      const payload = await loadHierarchyPayload(drillOrder(rollups)[0], scenarioId, rollupScope);
      return NextResponse.json({ ok: true, action: "revert", editGroupId, deletedRows, hierarchy: payload });
    }

    const parsed = await parseCommitApplyBody(body, rollups);
    if ("message" in parsed) {
      return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    }

    const preview = await buildPreview(parsed);
    if (!preview.outcome.feasible) {
      return NextResponse.json(
        { error: `Preview is infeasible. Shortfall ${preview.outcome.shortfall.toFixed(2)} units.` },
        { status: 409 },
      );
    }

    const commit = await commitPreview(parsed, preview);
    return NextResponse.json({ ok: true, action: "commit", commit, preview });
  } catch (err) {
    console.error("hierarchy commit failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to commit hierarchy edit" },
      { status: 500 },
    );
  }
}