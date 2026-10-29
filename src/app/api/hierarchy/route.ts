import { NextRequest, NextResponse } from "next/server";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import { parseHierarchyPath, rollupsOf } from "@/lib/hierarchy-path";
import {
  drillOrder, loadHierarchyPayload, parseLevel, scopeFloor } from "./shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // The scope carries any ROLLUP_* choice, which sets the levels `level` may name.
    const scope = parseHierarchyPath(request.nextUrl.searchParams);
    const level = parseLevel(request.nextUrl.searchParams.get("level"), drillOrder(rollupsOf(scope)));
    if (!level) {
      return NextResponse.json(
        { error: "Invalid level. Use CATEGORY_NAME, PRODUCT_NAME, CUSTOMER_NAME, CHANNEL_NAME, or SERIES_ID." },
        { status: 400 },
      );
    }

    const scenarioId = request.nextUrl.searchParams.get("scenarioId");
    // The scope chooses WHICH nodes are listed; `level` is still the depth to
    // list them at, deepened to the scope's floor so no node is ever split.
    const [payload, hierarchyOptions] = await Promise.all([
      loadHierarchyPayload(level, scenarioId, scope),
      // V_PLAN_FORWARD inner-joins V_SERIES and covers every series, so this is
      // the table's own universe at a fraction of the cost of reading the plan.
      // A series that lost its plan rows would surface as an empty scope.
      loadHierarchyOptions("APP.V_SERIES", scope),
    ]);
    return NextResponse.json({
      ...payload,
      scope: { path: scope, floor: scopeFloor(scope) },
      options: { hierarchy: hierarchyOptions },
    });
  } catch (err) {
    console.error("hierarchy route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load hierarchy data" },
      { status: 500 },
    );
  }
}
