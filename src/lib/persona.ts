/**
 * The simulated persona the current request is acting as.
 *
 * The app connects to Snowflake as one user, so roles cannot come from
 * CURRENT_USER(). The app shell's "Acting as" picker stores a persona id in a
 * cookie; every server route resolves it here against CORE.DIM_APP_USER, so a
 * forged cookie can only select another seeded persona, never invent a role.
 * Both the persona and CURRENT_USER() are written to the approval audit trail.
 */
import { cookies } from "next/headers";
import { query } from "@/lib/snowflake";
import { isRoleId, type Persona, type RoleId } from "@/lib/workflow";

export const PERSONA_COOKIE = "vectron-persona";
export const DEFAULT_PERSONA_ID = "u-kapoor";

export interface AppPersona extends Persona {
  displayName: string;
  title: string | null;
  roleLabel: string;
  isSimulated: boolean;
}

interface PersonaRow {
  USER_ID: string;
  DISPLAY_NAME: string;
  ROLE_ID: string;
  ROLE_LABEL: string;
  TITLE: string | null;
  STREAM_ID: string | null;
  IS_SIMULATED: boolean;
}

function toPersona(row: PersonaRow): AppPersona | null {
  if (!isRoleId(row.ROLE_ID)) return null;
  return {
    userId: row.USER_ID,
    displayName: row.DISPLAY_NAME,
    roleId: row.ROLE_ID as RoleId,
    roleLabel: row.ROLE_LABEL,
    title: row.TITLE,
    streamId: row.STREAM_ID,
    isSimulated: Boolean(row.IS_SIMULATED),
  };
}

// Personas are seed data that changes only when 13-approvals.sql is re-run,
// so they are cached for the life of the server process.
let personaCache: AppPersona[] | null = null;

export async function listPersonas(): Promise<AppPersona[]> {
  if (personaCache) return personaCache;
  const rows = await query<PersonaRow>(
    `SELECT u.USER_ID, u.DISPLAY_NAME, u.ROLE_ID, r.ROLE_LABEL, u.TITLE,
            u.STREAM_ID, u.IS_SIMULATED
     FROM CORE.DIM_APP_USER u
     JOIN CORE.DIM_APP_ROLE r ON r.ROLE_ID = u.ROLE_ID
     ORDER BY u.SORT_ORDER, u.DISPLAY_NAME`,
  );
  personaCache = rows.map(toPersona).filter((persona): persona is AppPersona => persona !== null);
  return personaCache;
}

export async function findPersona(userId: string | null | undefined): Promise<AppPersona | null> {
  if (!userId) return null;
  return (await listPersonas()).find((persona) => persona.userId === userId) ?? null;
}

/** The persona this request acts as. Falls back to the default planner. */
export async function getPersona(): Promise<AppPersona> {
  const store = await cookies();
  const selected = await findPersona(store.get(PERSONA_COOKIE)?.value);
  if (selected) return selected;
  const fallback = await findPersona(DEFAULT_PERSONA_ID);
  if (fallback) return fallback;
  const [first] = await listPersonas();
  if (!first) throw new Error("No personas are seeded. Run snowflake/13-approvals.sql.");
  return first;
}

export async function getSnowflakeUser(): Promise<string> {
  const rows = await query<{ SF_USER: string }>(`SELECT CURRENT_USER() AS SF_USER`);
  return rows[0]?.SF_USER ?? "UNKNOWN";
}
