import { NextRequest, NextResponse } from "next/server";
import { disaggregate } from "@/lib/disaggregate";
import { getContext } from "@/lib/data";
import {
  hierarchyLabel,
  hierarchyPredicate,
  parseHierarchyPath,
  type HierarchyPathServer,
} from "@/lib/hierarchy-path";
import { query } from "@/lib/snowflake";
import { supplyGap } from "@/lib/supply";
import {
  asDisaggMethod,
  asEditLevel,
  DISAGG_METHODS,
  EDIT_LEVELS,
  getActor,
  getReason,
  getScenarioSummary,
  isScenarioId,
  isWeekId,
  MAX_NOTE_LENGTH,
  normaliseOptionalText,
  round2,
  same2,
  type DisaggMethodName,
  type EditLevel,
  type ScenarioSummaryRow,
} from "../shared";

export const dynamic = "force-dynamic";

interface WeeklyComparisonRow {
  WEEK_ID: string;
  COMMITTED_UNITS: number;
  SCENARIO_UNITS: number;
  DELTA_UNITS: number;
  DELTA_VALUE_EUR: number;
}

interface EditRow {
  SERIES_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string;
  CUSTOMER_NAME: string;
  CHANNEL_NAME: string;
  CATEGORY_NAME: string;
  WEEK_ID: string;
  BASE_UNITS: number;
  EDIT_UNITS: number;
  DELTA_UNITS: number;
  ORIGIN: string;
  REASON_CODE: string | null;
  REASON_LABEL: string | null;
  NOTE: string | null;
  EDIT_GROUP_ID: string;
  PARENT_LEVEL: string | null;
  PARENT_KEY: string | null;
  DISAGG_METHOD: string;
  EDITED_BY: string;
  EDITED_AT: string;
  UNIT_PRICE_EUR: number;
}

interface MoverRow {
  SERIES_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string;
  CUSTOMER_NAME: string;
  CHANNEL_NAME: string;
  CATEGORY_NAME: string;
  BASE_UNITS: number;
  SCENARIO_UNITS: number;
  DELTA_UNITS: number;
  DELTA_VALUE_EUR: number;
}

interface ImpactRow {
  EDIT_COUNT: number;
  SERIES_EDITED: number;
  EDIT_GROUPS: number;
  AGENT_EDITS: number;
  DELTA_UNITS: number;
  DELTA_VALUE_EUR: number;
}

interface ScenarioCellRow {
  SERIES_ID: string;
  SERIES_LABEL: string;
  BASE_PLAN_UNITS: number;
  SCENARIO_UNITS: number;
  STAT_UNITS: number;
  IS_LOCKED: boolean;
}

interface UpsertEditPayload {
  action: "upsertEdit";
  weekId?: unknown;
  targetUnits?: unknown;
  reasonCode?: unknown;
  note?: unknown;
  seriesId?: unknown;
  parentLevel?: unknown;
  parentKey?: unknown;
  disaggMethod?: unknown;
}

interface RemoveEditPayload {
  action: "removeEdit";
  weekId?: unknown;
  seriesId?: unknown;
}

type ScenarioDetailAction = UpsertEditPayload | RemoveEditPayload;

interface ScenarioEditMutationRow {
  scenarioId: string;
  seriesId: string;
  weekId: string;
  baseUnits: number;
  editUnits: number;
  deltaUnits: number;
  origin: string;
  sourceProposalId: string | null;
  reasonCode: string;
  note: string | null;
  editGroupId: string;
  parentLevel: string | null;
  parentKey: string | null;
  disaggMethod: string;
  editedBy: string;
}

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function scenarioSummaryToJson(summary: ScenarioSummaryRow, historyEndWeek: string) {
  const editCount = Number(summary.EDIT_COUNT) || 0;
  const agentEdits = Number(summary.AGENT_EDITS) || 0;
  return {
    scenarioId: summary.SCENARIO_ID,
    name: summary.SCENARIO_NAME,
    description: summary.DESCRIPTION,
    status: summary.STATUS,
    basePlanWeek: summary.BASE_PLAN_WEEK,
    createdBy: summary.CREATED_BY,
    createdAt: summary.CREATED_AT,
    updatedAt: summary.UPDATED_AT,
    promotedAt: summary.PROMOTED_AT,
    promotedBy: summary.PROMOTED_BY,
    parentScenarioId: summary.PARENT_SCENARIO_ID,
    editCount,
    seriesEdited: Number(summary.SERIES_EDITED) || 0,
    editGroups: Number(summary.EDIT_GROUPS) || 0,
    agentEdits,
    plannerEdits: editCount - agentEdits,
    deltaUnits: Number(summary.DELTA_UNITS) || 0,
    deltaValueEur: Number(summary.DELTA_VALUE_EUR) || 0,
    isStale: summary.BASE_PLAN_WEEK < historyEndWeek,
  };
}

async function loadScenarioDetail(scenarioId: string, path: HierarchyPathServer = {}) {
  const [context, scenario] = await Promise.all([
    getContext(),
    getScenarioSummary(scenarioId),
  ]);

  if (!scenario) {
    return null;
  }

  // Every scoped read filters on the V_SERIES join before it groups or caps, so
  // the movers are the scope's top 12 rather than the portfolio's top 12 cut
  // down. `scenario` itself stays the portfolio-wide summary: promotion writes
  // the whole scenario whatever the scope.
  const scope = hierarchyPredicate(path, "s");

  const [weeklyRows, editRows, moverRows, reasonRows, impactRows] = await Promise.all([
    query<WeeklyComparisonRow>(
      `SELECT sp.WEEK_ID,
              SUM(sp.BASE_PLAN_UNITS) AS COMMITTED_UNITS,
              SUM(sp.SCENARIO_UNITS) AS SCENARIO_UNITS,
              SUM(sp.DELTA_UNITS) AS DELTA_UNITS,
              SUM(sp.DELTA_VALUE_EUR) AS DELTA_VALUE_EUR
       FROM APP.V_SCENARIO_PLAN sp
       JOIN APP.V_SERIES s
         ON s.SERIES_ID = sp.SERIES_ID
       WHERE sp.SCENARIO_ID = ?
         AND ${scope.sql}
       GROUP BY sp.WEEK_ID
       ORDER BY sp.WEEK_ID`,
      [scenarioId, ...scope.binds],
    ),
    query<EditRow>(
      `SELECT e.SERIES_ID, s.SERIES_LABEL, s.PRODUCT_NAME, s.CUSTOMER_NAME,
              s.CHANNEL_NAME, s.CATEGORY_NAME, e.WEEK_ID, e.BASE_UNITS,
              e.EDIT_UNITS, e.DELTA_UNITS, e.ORIGIN, e.REASON_CODE,
              r.REASON_LABEL, e.NOTE, e.EDIT_GROUP_ID, e.PARENT_LEVEL,
              e.PARENT_KEY, e.DISAGG_METHOD, e.EDITED_BY, e.EDITED_AT,
              vs.UNIT_PRICE_EUR
       FROM CORE.FACT_SCENARIO_EDIT e
       JOIN APP.V_SERIES s
         ON s.SERIES_ID = e.SERIES_ID
       LEFT JOIN CORE.DIM_REASON_CODE r
         ON r.REASON_CODE = e.REASON_CODE
       LEFT JOIN APP.V_SERIES vs
         ON vs.SERIES_ID = e.SERIES_ID
       WHERE e.SCENARIO_ID = ?
         AND ${scope.sql}
       ORDER BY e.EDITED_AT DESC, ABS(e.DELTA_UNITS) DESC, e.SERIES_ID, e.WEEK_ID`,
      [scenarioId, ...scope.binds],
    ),
    query<MoverRow>(
      `SELECT sp.SERIES_ID, s.SERIES_LABEL, s.PRODUCT_NAME, s.CUSTOMER_NAME,
              s.CHANNEL_NAME, s.CATEGORY_NAME,
              SUM(sp.BASE_PLAN_UNITS) AS BASE_UNITS,
              SUM(sp.SCENARIO_UNITS) AS SCENARIO_UNITS,
              SUM(sp.DELTA_UNITS) AS DELTA_UNITS,
              SUM(sp.DELTA_VALUE_EUR) AS DELTA_VALUE_EUR
       FROM APP.V_SCENARIO_PLAN sp
       JOIN APP.V_SERIES s
         ON s.SERIES_ID = sp.SERIES_ID
       WHERE sp.SCENARIO_ID = ?
         AND ${scope.sql}
       GROUP BY sp.SERIES_ID, s.SERIES_LABEL, s.PRODUCT_NAME, s.CUSTOMER_NAME,
                s.CHANNEL_NAME, s.CATEGORY_NAME
       HAVING ABS(SUM(sp.DELTA_UNITS)) > 0.004
       ORDER BY ABS(SUM(sp.DELTA_VALUE_EUR)) DESC, ABS(SUM(sp.DELTA_UNITS)) DESC
       LIMIT 12`,
      [scenarioId, ...scope.binds],
    ),
    query(
      `SELECT REASON_CODE, REASON_LABEL, REASON_GROUP, REQUIRES_NOTE
       FROM CORE.DIM_REASON_CODE
       ORDER BY REASON_GROUP, REASON_LABEL`,
    ),
    // Same aggregates as APP.V_SCENARIO_SUMMARY, LEFT JOIN included, so at the
    // root (predicate 1=1) these equal the summary exactly.
    query<ImpactRow>(
      `SELECT COUNT(e.SERIES_ID) AS EDIT_COUNT,
              COUNT(DISTINCT e.SERIES_ID) AS SERIES_EDITED,
              COUNT(DISTINCT e.EDIT_GROUP_ID) AS EDIT_GROUPS,
              COALESCE(SUM(CASE WHEN e.ORIGIN = 'agent' THEN 1 ELSE 0 END), 0) AS AGENT_EDITS,
              COALESCE(SUM(e.DELTA_UNITS), 0) AS DELTA_UNITS,
              COALESCE(SUM(e.DELTA_UNITS * s.UNIT_PRICE_EUR), 0) AS DELTA_VALUE_EUR
       FROM CORE.FACT_SCENARIO_EDIT e
       LEFT JOIN APP.V_SERIES s
         ON s.SERIES_ID = e.SERIES_ID
       WHERE e.SCENARIO_ID = ?
         AND ${scope.sql}`,
      [scenarioId, ...scope.binds],
    ),
  ]);

  const impact = impactRows[0];
  const impactEdits = Number(impact?.EDIT_COUNT) || 0;
  const impactAgentEdits = Number(impact?.AGENT_EDITS) || 0;

  return {
    context,
    scope: { path, label: hierarchyLabel(path) },
    scenario: scenarioSummaryToJson(scenario, context.HISTORY_END_WEEK),
    impact: {
      editCount: impactEdits,
      seriesEdited: Number(impact?.SERIES_EDITED) || 0,
      editGroups: Number(impact?.EDIT_GROUPS) || 0,
      agentEdits: impactAgentEdits,
      plannerEdits: impactEdits - impactAgentEdits,
      deltaUnits: Number(impact?.DELTA_UNITS) || 0,
      deltaValueEur: Number(impact?.DELTA_VALUE_EUR) || 0,
    },
    comparison: {
      weeks: weeklyRows.map((row) => ({
        weekId: row.WEEK_ID,
        committedUnits: Number(row.COMMITTED_UNITS) || 0,
        scenarioUnits: Number(row.SCENARIO_UNITS) || 0,
        deltaUnits: Number(row.DELTA_UNITS) || 0,
        deltaValueEur: Number(row.DELTA_VALUE_EUR) || 0,
      })),
    },
    edits: editRows.map((row) => ({
      seriesId: row.SERIES_ID,
      seriesLabel: row.SERIES_LABEL,
      productName: row.PRODUCT_NAME,
      customerName: row.CUSTOMER_NAME,
      channelName: row.CHANNEL_NAME,
      categoryName: row.CATEGORY_NAME,
      weekId: row.WEEK_ID,
      beforeUnits: Number(row.BASE_UNITS) || 0,
      afterUnits: Number(row.EDIT_UNITS) || 0,
      deltaUnits: Number(row.DELTA_UNITS) || 0,
      deltaValueEur: (Number(row.DELTA_UNITS) || 0) * (Number(row.UNIT_PRICE_EUR) || 0),
      origin: row.ORIGIN,
      reasonCode: row.REASON_CODE,
      reasonLabel: row.REASON_LABEL,
      note: row.NOTE,
      editGroupId: row.EDIT_GROUP_ID,
      parentLevel: row.PARENT_LEVEL,
      parentLevelLabel: row.PARENT_LEVEL ? EDIT_LEVELS[row.PARENT_LEVEL as EditLevel] : null,
      parentKey: row.PARENT_KEY,
      disaggMethod: row.DISAGG_METHOD,
      disaggMethodLabel:
        row.DISAGG_METHOD in DISAGG_METHODS
          ? DISAGG_METHODS[row.DISAGG_METHOD as DisaggMethodName]
          : row.DISAGG_METHOD,
      editedBy: row.EDITED_BY,
      editedAt: row.EDITED_AT,
    })),
    topMovers: moverRows.map((row) => ({
      seriesId: row.SERIES_ID,
      seriesLabel: row.SERIES_LABEL,
      productName: row.PRODUCT_NAME,
      customerName: row.CUSTOMER_NAME,
      channelName: row.CHANNEL_NAME,
      categoryName: row.CATEGORY_NAME,
      committedUnits: Number(row.BASE_UNITS) || 0,
      scenarioUnits: Number(row.SCENARIO_UNITS) || 0,
      deltaUnits: Number(row.DELTA_UNITS) || 0,
      deltaValueEur: Number(row.DELTA_VALUE_EUR) || 0,
    })),
    reasons: reasonRows,
  };
}

async function mergeScenarioEditRows(rows: ScenarioEditMutationRow[]) {
  if (!rows.length) return;

  const selects = rows
    .map(
      () => `SELECT ? AS SCENARIO_ID, ? AS SERIES_ID, ? AS WEEK_ID, ? AS BASE_UNITS,
                    ? AS EDIT_UNITS, ? AS DELTA_UNITS, ? AS ORIGIN,
                    ? AS SOURCE_PROPOSAL_ID, ? AS REASON_CODE, ? AS NOTE,
                    ? AS EDIT_GROUP_ID, ? AS PARENT_LEVEL, ? AS PARENT_KEY,
                    ? AS DISAGG_METHOD, ? AS EDITED_BY`,
    )
    .join(" UNION ALL ");

  const binds = rows.flatMap((row) => [
    row.scenarioId,
    row.seriesId,
    row.weekId,
    row.baseUnits,
    row.editUnits,
    row.deltaUnits,
    row.origin,
    row.sourceProposalId,
    row.reasonCode,
    row.note,
    row.editGroupId,
    row.parentLevel,
    row.parentKey,
    row.disaggMethod,
    row.editedBy,
  ]);

  await query(
    `MERGE INTO CORE.FACT_SCENARIO_EDIT AS target
     USING (${selects}) AS source
     ON target.SCENARIO_ID = source.SCENARIO_ID
        AND target.SERIES_ID = source.SERIES_ID
        AND target.WEEK_ID = source.WEEK_ID
     WHEN MATCHED THEN UPDATE SET
       BASE_UNITS = source.BASE_UNITS,
       EDIT_UNITS = source.EDIT_UNITS,
       DELTA_UNITS = source.DELTA_UNITS,
       ORIGIN = source.ORIGIN,
       SOURCE_PROPOSAL_ID = source.SOURCE_PROPOSAL_ID,
       REASON_CODE = source.REASON_CODE,
       NOTE = source.NOTE,
       EDIT_GROUP_ID = source.EDIT_GROUP_ID,
       PARENT_LEVEL = source.PARENT_LEVEL,
       PARENT_KEY = source.PARENT_KEY,
       DISAGG_METHOD = source.DISAGG_METHOD,
       EDITED_BY = source.EDITED_BY,
       EDITED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (
       SCENARIO_ID, SERIES_ID, WEEK_ID, BASE_UNITS, EDIT_UNITS, DELTA_UNITS,
       ORIGIN, SOURCE_PROPOSAL_ID, REASON_CODE, NOTE, EDIT_GROUP_ID,
       PARENT_LEVEL, PARENT_KEY, DISAGG_METHOD, EDITED_BY, EDITED_AT
     ) VALUES (
       source.SCENARIO_ID, source.SERIES_ID, source.WEEK_ID, source.BASE_UNITS,
       source.EDIT_UNITS, source.DELTA_UNITS, source.ORIGIN,
       source.SOURCE_PROPOSAL_ID, source.REASON_CODE, source.NOTE,
       source.EDIT_GROUP_ID, source.PARENT_LEVEL, source.PARENT_KEY,
       source.DISAGG_METHOD, source.EDITED_BY, CURRENT_TIMESTAMP()
     )`,
    binds,
  );
}

async function deleteScenarioEditRows(
  scenarioId: string,
  weekId: string,
  seriesIds: string[],
) {
  if (!seriesIds.length) return;

  await query(
    `DELETE FROM CORE.FACT_SCENARIO_EDIT
     WHERE SCENARIO_ID = ?
       AND WEEK_ID = ?
       AND SERIES_ID IN (${seriesIds.map(() => "?").join(",")})`,
    [scenarioId, weekId, ...seriesIds],
  );
}

async function touchScenario(scenarioId: string) {
  await query(
    `UPDATE CORE.DIM_SCENARIO
     SET UPDATED_AT = CURRENT_TIMESTAMP()
     WHERE SCENARIO_ID = ?`,
    [scenarioId],
  );
}

async function loadDirectCell(
  scenarioId: string,
  seriesId: string,
  weekId: string,
) {
  const rows = await query<ScenarioCellRow>(
    `SELECT sp.SERIES_ID, s.SERIES_LABEL, sp.BASE_PLAN_UNITS,
            sp.SCENARIO_UNITS, pf.STAT_UNITS, pf.IS_LOCKED
     FROM APP.V_SCENARIO_PLAN sp
     JOIN APP.V_SERIES s
       ON s.SERIES_ID = sp.SERIES_ID
     JOIN APP.V_PLAN_FORWARD pf
       ON pf.SERIES_ID = sp.SERIES_ID
      AND pf.WEEK_ID = sp.WEEK_ID
     WHERE sp.SCENARIO_ID = ?
       AND sp.SERIES_ID = ?
       AND sp.WEEK_ID = ?`,
    [scenarioId, seriesId, weekId],
  );
  return rows[0] ?? null;
}

async function loadParentCells(
  scenarioId: string,
  weekId: string,
  parentLevel: EditLevel,
  parentKey: string,
) {
  return query<ScenarioCellRow>(
    `SELECT sp.SERIES_ID, s.SERIES_LABEL, sp.BASE_PLAN_UNITS,
            sp.SCENARIO_UNITS, pf.STAT_UNITS, pf.IS_LOCKED
     FROM APP.V_SCENARIO_PLAN sp
     JOIN APP.V_SERIES s
       ON s.SERIES_ID = sp.SERIES_ID
     JOIN APP.V_PLAN_FORWARD pf
       ON pf.SERIES_ID = sp.SERIES_ID
      AND pf.WEEK_ID = sp.WEEK_ID
     WHERE sp.SCENARIO_ID = ?
       AND sp.WEEK_ID = ?
       AND (
         (? = 'CATEGORY_NAME' AND s.CATEGORY_NAME = ?)
         OR (? = 'PRODUCT_LINE' AND s.PRODUCT_LINE = ?)
         OR (? = 'CUSTOMER_NAME' AND s.CUSTOMER_NAME = ?)
         OR (? = 'CHANNEL_NAME' AND s.CHANNEL_NAME = ?)
       )
     ORDER BY sp.SERIES_ID`,
    [
      scenarioId,
      weekId,
      parentLevel,
      parentKey,
      parentLevel,
      parentKey,
      parentLevel,
      parentKey,
      parentLevel,
      parentKey,
    ],
  );
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!isScenarioId(id)) {
      return badRequest("Scenario id is invalid.");
    }

    const [detail, supply] = await Promise.all([
      loadScenarioDetail(id, parseHierarchyPath(req.nextUrl.searchParams)),
      // Supply gap of this scenario and of the committed plan, from their last
      // solves. Read-only; a failure here never blocks the scenario detail.
      Promise.all([supplyGap(id), supplyGap("COMMITTED")])
        .then(([scenario, committed]) => ({ scenario, committed }))
        .catch((err: unknown) => {
          console.error("scenario supply gap failed:", err);
          return null;
        }),
    ]);
    if (!detail) {
      return badRequest("Scenario not found.", 404);
    }

    return NextResponse.json({ ...detail, supply });
  } catch (err) {
    console.error("scenario detail route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load scenario" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!isScenarioId(id)) {
      return badRequest("Scenario id is invalid.");
    }

    const body = (await req.json()) as ScenarioDetailAction;
    const scenario = await getScenarioSummary(id);
    if (!scenario) return badRequest("Scenario not found.", 404);
    if (scenario.STATUS !== "draft") {
      return badRequest("Only draft scenarios can be edited.", 409);
    }

    if (body.action === "removeEdit") {
      const weekId = typeof body.weekId === "string" ? body.weekId : null;
      const seriesId = typeof body.seriesId === "string" ? body.seriesId : null;
      if (!isWeekId(weekId)) return badRequest("weekId must be a valid planning week.");
      if (!seriesId) return badRequest("seriesId is required.");

      await deleteScenarioEditRows(id, weekId, [seriesId]);
      await touchScenario(id);

      const detail = await loadScenarioDetail(id);
      return NextResponse.json({ ok: true, action: body.action, detail });
    }

    if (body.action !== "upsertEdit") {
      return badRequest("Unsupported scenario detail action.");
    }

    const weekId = typeof body.weekId === "string" ? body.weekId : null;
    if (!isWeekId(weekId)) return badRequest("weekId must be a valid planning week.");

    const targetUnits = typeof body.targetUnits === "number"
      ? body.targetUnits
      : Number(body.targetUnits);
    if (!Number.isFinite(targetUnits) || targetUnits < 0) {
      return badRequest("targetUnits must be a non-negative number.");
    }

    const reasonCode = typeof body.reasonCode === "string" ? body.reasonCode : null;
    if (!reasonCode) return badRequest("reasonCode is required.");
    const reason = await getReason(reasonCode);
    if (!reason) return badRequest("Unknown reason code.");

    const note = normaliseOptionalText(body.note, MAX_NOTE_LENGTH);
    if (reason.REQUIRES_NOTE && !note) {
      return badRequest(`Reason '${reasonCode}' requires a note.`);
    }

    const actor = await getActor();
    const editGroupId = crypto.randomUUID();

    const seriesId = typeof body.seriesId === "string" ? body.seriesId : null;
    const parentLevel = asEditLevel(
      typeof body.parentLevel === "string" ? body.parentLevel : null,
    );
    const parentKey = typeof body.parentKey === "string" ? body.parentKey.trim() : "";

    if (seriesId) {
      const cell = await loadDirectCell(id, seriesId, weekId);
      if (!cell) {
        return badRequest("Series-week is not in the forward plan.", 404);
      }
      if (cell.IS_LOCKED) {
        return badRequest("This week is locked and cannot be changed.", 409);
      }

      if (same2(targetUnits, Number(cell.BASE_PLAN_UNITS) || 0)) {
        await deleteScenarioEditRows(id, weekId, [seriesId]);
      } else {
        await mergeScenarioEditRows([
          {
            scenarioId: id,
            seriesId,
            weekId,
            baseUnits: round2(Number(cell.BASE_PLAN_UNITS) || 0),
            editUnits: round2(targetUnits),
            deltaUnits: round2(targetUnits - (Number(cell.BASE_PLAN_UNITS) || 0)),
            origin: "planner",
            sourceProposalId: null,
            reasonCode,
            note,
            editGroupId,
            parentLevel: null,
            parentKey: null,
            disaggMethod: "direct",
            editedBy: actor,
          },
        ]);
      }

      await touchScenario(id);
      const detail = await loadScenarioDetail(id);
      return NextResponse.json({ ok: true, action: body.action, detail });
    }

    if (!parentLevel || !parentKey) {
      return badRequest(
        "Provide either a seriesId for a direct edit or parentLevel and parentKey for a parent-level edit.",
      );
    }

    const disaggMethod = asDisaggMethod(
      typeof body.disaggMethod === "string" ? body.disaggMethod : null,
    );
    if (!disaggMethod) {
      return badRequest("disaggMethod must be 'statistical' or 'current_plan' for parent-level edits.");
    }

    const cells = await loadParentCells(id, weekId, parentLevel, parentKey);
    if (!cells.length) {
      return badRequest("No planning series match that parent-level selection.", 404);
    }

    const outcome = disaggregate(
      targetUnits,
      cells.map((cell) => ({
        id: cell.SERIES_ID,
        currentUnits: Number(cell.SCENARIO_UNITS) || 0,
        statUnits: Number(cell.STAT_UNITS) || 0,
        locked: Boolean(cell.IS_LOCKED),
      })),
      disaggMethod,
    );

    if (!outcome.feasible) {
      return badRequest(
        `The requested total cannot be reached because locked or zero-floor series absorb only ${outcome.appliedDelta.toFixed(2)} of ${outcome.targetDelta.toFixed(2)} units.`,
        409,
      );
    }

    const bySeriesId = new Map(cells.map((cell) => [cell.SERIES_ID, cell]));
    const rowsToMerge: ScenarioEditMutationRow[] = [];
    const seriesToDelete: string[] = [];

    outcome.children.forEach((child) => {
      const cell = bySeriesId.get(child.id);
      if (!cell || Boolean(cell.IS_LOCKED)) return;

      const baseUnits = round2(Number(cell.BASE_PLAN_UNITS) || 0);
      const editUnits = round2(child.newUnits);
      if (same2(editUnits, baseUnits)) {
        seriesToDelete.push(child.id);
        return;
      }

      rowsToMerge.push({
        scenarioId: id,
        seriesId: child.id,
        weekId,
        baseUnits,
        editUnits,
        deltaUnits: round2(editUnits - baseUnits),
        origin: "planner",
        sourceProposalId: null,
        reasonCode,
        note,
        editGroupId,
        parentLevel,
        parentKey,
        disaggMethod,
        editedBy: actor,
      });
    });

    await deleteScenarioEditRows(id, weekId, seriesToDelete);
    await mergeScenarioEditRows(rowsToMerge);
    await touchScenario(id);

    const detail = await loadScenarioDetail(id);
    return NextResponse.json({
      ok: true,
      action: body.action,
      detail,
      applied: {
        parentLevel,
        parentKey,
        disaggMethod,
        childCount: rowsToMerge.length,
        targetUnits: round2(targetUnits),
      },
    });
  } catch (err) {
    console.error("scenario edit failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to update scenario" },
      { status: 500 },
    );
  }
}