import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_PERSONA_ID, PERSONA_COOKIE, findPersona, getPersona, listPersonas } from "@/lib/persona";
import { roleCanApproveSomething } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/** The persona picker: every seeded persona, and who this browser is acting as. */
export async function GET() {
  try {
    const [personas, current] = await Promise.all([listPersonas(), getPersona()]);
    return NextResponse.json({
      personas: personas.map((persona) => ({
        ...persona,
        canApprove: roleCanApproveSomething(persona.roleId),
      })),
      current,
      defaultUserId: DEFAULT_PERSONA_ID,
      simulated: true,
    });
  } catch (err) {
    console.error("personas route failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to load personas" }, { status: 500 });
  }
}

/** Switch persona. Only a seeded persona id is accepted. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { userId?: unknown };
    const persona = await findPersona(typeof body.userId === "string" ? body.userId : null);
    if (!persona) return NextResponse.json({ error: "Unknown persona." }, { status: 400 });
    const res = NextResponse.json({ ok: true, current: persona });
    res.cookies.set(PERSONA_COOKIE, persona.userId, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  } catch (err) {
    console.error("persona switch failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to switch persona" }, { status: 500 });
  }
}
