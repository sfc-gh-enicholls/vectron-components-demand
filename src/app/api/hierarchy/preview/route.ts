import { NextRequest, NextResponse } from "next/server";
import { parseHierarchyPath, rollupsOf } from "@/lib/hierarchy-path";
import { buildPreview, parsePreviewRequestBody } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    // A node key built under a roll-up is read in that roll-up's drill order.
    const rollups = rollupsOf(parseHierarchyPath(request.nextUrl.searchParams));
    const parsed = parsePreviewRequestBody(await request.json(), rollups);
    if ("message" in parsed) {
      return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    }

    const preview = await buildPreview(parsed);
    return NextResponse.json(preview);
  } catch (err) {
    console.error("hierarchy preview failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to preview hierarchy edit" },
      { status: 500 },
    );
  }
}