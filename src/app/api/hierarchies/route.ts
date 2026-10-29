import { NextResponse } from "next/server";
import { loadHierarchyCatalogue } from "@/lib/hierarchy-catalogue";

export const dynamic = "force-dynamic";

/**
 * The dimension hierarchies, each with its levels and the node count per level.
 * Read-only. Product, customer and channel trees carry their nodes, which the
 * filter renders as one tree picker per dimension; each page's own option
 * lists then prune that tree to what the page actually has.
 */
export async function GET() {
  try {
    const hierarchies = await loadHierarchyCatalogue();
    return NextResponse.json({ hierarchies });
  } catch (err) {
    console.error("hierarchies route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load hierarchies" },
      { status: 500 },
    );
  }
}
