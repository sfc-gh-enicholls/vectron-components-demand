import { NextRequest, NextResponse } from "next/server";
import { loadMeasureModel, reconcileMeasures } from "@/lib/measures";

export const dynamic = "force-dynamic";

/**
 * GET /api/measures            — the formula library: every measure, its active
 *                                formula, unit and dependencies.
 * GET /api/measures?reconcile=1 — check the formulas reproduce the committed
 *                                plan's published value, LPA, duty and landed cost.
 */
export async function GET(req: NextRequest) {
  try {
    if (req.nextUrl.searchParams.get("reconcile") === "1") {
      return NextResponse.json(await reconcileMeasures());
    }
    const model = await loadMeasureModel(true);
    const usedBy = new Map<string, string[]>();
    const depsOf = (code: string) => [
      ...(model.leaf.formulas.get(code)?.refs ?? []),
      ...(model.aggregate.formulas.get(code)?.refs ?? []),
    ];
    for (const measure of model.measures) {
      for (const dep of new Set(depsOf(measure.code))) {
        usedBy.set(dep, [...(usedBy.get(dep) ?? []), measure.code]);
      }
    }
    return NextResponse.json({
      measures: model.measures.map((measure) => ({
        ...measure,
        dependsOn: [...new Set(depsOf(measure.code))],
        usedBy: usedBy.get(measure.code) ?? [],
        leafTier: model.leaf.tierOf.get(measure.code) ?? null,
      })),
    });
  } catch (err) {
    console.error("measures route failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to load measures" }, { status: 500 });
  }
}
