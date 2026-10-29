import { NextRequest, NextResponse } from "next/server";
import { getPersona } from "@/lib/persona";
import { getSolveJob, isValidPlanSource, lastSolve, startSolve } from "@/lib/supply";

export const dynamic = "force-dynamic";

/** Status of the solve for a source: the running job (if any) and the last completed run. */
export async function GET(request: NextRequest) {
  try {
    const source = request.nextUrl.searchParams.get("source") ?? "COMMITTED";
    if (!(await isValidPlanSource(source))) {
      return NextResponse.json({ error: "Unknown plan source." }, { status: 400 });
    }
    return NextResponse.json({ job: getSolveJob(source), last: await lastSolve(source) });
  } catch (err) {
    console.error("supply solve status failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed" }, { status: 500 });
  }
}

/**
 * Start a constrained solve. Body: { source }. Returns 202 at once; the solve
 * runs in the background (~25 s) and the page polls GET. Reads demand only and
 * writes only the supply result tables, so any persona may run it.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { source?: unknown };
    const source = typeof body.source === "string" ? body.source : "COMMITTED";
    if (!(await isValidPlanSource(source))) {
      return NextResponse.json({ error: "Unknown plan source." }, { status: 400 });
    }
    const persona = await getPersona();
    const job = startSolve(source, "manual", persona.displayName);
    return NextResponse.json({ job }, { status: 202 });
  } catch (err) {
    console.error("supply solve start failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to start solve" }, { status: 500 });
  }
}
