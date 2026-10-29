import { NextRequest, NextResponse } from "next/server";
import { getContext, getFilterOptions } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import {
  hierarchyLabel,
  hierarchyPredicate,
  parseHierarchyPath,
  type HierarchyPathServer,
} from "@/lib/hierarchy-path";
import { query } from "@/lib/snowflake";
import { getPersona } from "@/lib/persona";
import { ApprovalError } from "@/lib/approvals";
import { submitScenarioPromotion } from "@/lib/approval-objects";
import {
  getActor,
  getScenarioSummary,
  isScenarioId,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  normaliseOptionalText,
  normaliseRequiredText,
  type ScenarioSummaryRow,
} from "./shared";

export const dynamic = "force-dynamic";

interface ScenarioListRow extends ScenarioSummaryRow {}

interface BaselineTotalsRow {
  TOTAL_UNITS: number;
  TOTAL_VALUE_EUR: number;
  SERIES_COUNT: number;
  WEEK_COUNT: number;
}

interface ForwardWeekRow {
  WEEK_ID: string;
}

interface SeriesOptionRow {
  SERIES_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string;
  PRODUCT_LINE: string;
  CUSTOMER_NAME: string;
  CHANNEL_NAME: string;
  CATEGORY_NAME: string;
}

type ScenarioAction =
  | {
      action: "create";
      name?: unknown;
      description?: unknown;
      copyFrom?: unknown;
    }
  | {
      action: "rename";
      scenarioId?: unknown;
      name?: unknown;
      description?: unknown;
    }
  | {
      action: "discard";
      scenarioId?: unknown;
    }
  | {
      action: "promote";
      scenarioId?: unknown;
    }
  | {
      action: "duplicate";
      scenarioId?: unknown;
      name?: unknown;
      description?: unknown;
    };

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function loadScenarioIndex(includeDiscarded: boolean, path: HierarchyPathServer) {
  // The scope narrows the committed baseline and the series offered for a direct
  // edit. It never filters the scenario list: a scenario is a copy of the whole
  // plan, so each card's totals stay portfolio-wide.
  const scope = hierarchyPredicate(path, "s");
  const [context, baselineRows, scenarios, filterOptions, weeks, seriesOptions, hierarchyOptions] =
    await Promise.all([
      getContext(),
      query<BaselineTotalsRow>(
        `SELECT SUM(p.PLAN_UNITS) AS TOTAL_UNITS,
                SUM(p.PLAN_VALUE_EUR) AS TOTAL_VALUE_EUR,
                COUNT(DISTINCT p.SERIES_ID) AS SERIES_COUNT,
                COUNT(DISTINCT p.WEEK_ID) AS WEEK_COUNT
         FROM APP.V_PLAN_FORWARD p
         JOIN APP.V_SERIES s
           ON s.SERIES_ID = p.SERIES_ID
         WHERE ${scope.sql}`,
        scope.binds,
      ),
      query<ScenarioListRow>(
        `SELECT SCENARIO_ID, SCENARIO_NAME, DESCRIPTION, STATUS, BASE_PLAN_WEEK,
                CREATED_BY, CREATED_AT, UPDATED_AT, PROMOTED_AT, PROMOTED_BY,
                PARENT_SCENARIO_ID, EDIT_COUNT, SERIES_EDITED, EDIT_GROUPS,
                AGENT_EDITS, DELTA_UNITS, DELTA_VALUE_EUR
         FROM APP.V_SCENARIO_SUMMARY
         ${includeDiscarded ? "" : "WHERE STATUS <> ?"}
         ORDER BY CASE STATUS
                    WHEN 'draft' THEN 0
                    WHEN 'promoted' THEN 1
                    WHEN 'discarded' THEN 2
                    ELSE 3
                  END,
                  COALESCE(UPDATED_AT, CREATED_AT) DESC,
                  SCENARIO_NAME ASC`,
        includeDiscarded ? [] : ["discarded"],
      ),
      getFilterOptions(),
      query<ForwardWeekRow>(
        `SELECT DISTINCT WEEK_ID
         FROM APP.V_PLAN_FORWARD
         ORDER BY WEEK_ID`,
      ),
      query<SeriesOptionRow>(
        `SELECT s.SERIES_ID, s.SERIES_LABEL, s.PRODUCT_NAME, s.PRODUCT_LINE,
                s.CUSTOMER_NAME, s.CHANNEL_NAME, s.CATEGORY_NAME
         FROM APP.V_SERIES s
         WHERE ${scope.sql}
         ORDER BY s.PRODUCT_NAME, s.CUSTOMER_NAME, s.CHANNEL_NAME, s.SERIES_LABEL`,
        scope.binds,
      ),
      loadHierarchyOptions("APP.V_SERIES", path),
    ]);

  const baseline = baselineRows[0] ?? {
    TOTAL_UNITS: 0,
    TOTAL_VALUE_EUR: 0,
    SERIES_COUNT: 0,
    WEEK_COUNT: 0,
  };

  return {
    context,
    scope: { path, label: hierarchyLabel(path) },
    baseline: {
      totalUnits: Number(baseline.TOTAL_UNITS) || 0,
      totalValueEur: Number(baseline.TOTAL_VALUE_EUR) || 0,
      seriesCount: Number(baseline.SERIES_COUNT) || 0,
      weekCount: Number(baseline.WEEK_COUNT) || 0,
    },
    scenarios: scenarios.map((row) => ({
      scenarioId: row.SCENARIO_ID,
      name: row.SCENARIO_NAME,
      description: row.DESCRIPTION,
      status: row.STATUS,
      basePlanWeek: row.BASE_PLAN_WEEK,
      createdBy: row.CREATED_BY,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
      promotedAt: row.PROMOTED_AT,
      promotedBy: row.PROMOTED_BY,
      parentScenarioId: row.PARENT_SCENARIO_ID,
      editCount: Number(row.EDIT_COUNT) || 0,
      seriesEdited: Number(row.SERIES_EDITED) || 0,
      editGroups: Number(row.EDIT_GROUPS) || 0,
      agentEdits: Number(row.AGENT_EDITS) || 0,
      plannerEdits: (Number(row.EDIT_COUNT) || 0) - (Number(row.AGENT_EDITS) || 0),
      deltaUnits: Number(row.DELTA_UNITS) || 0,
      deltaValueEur: Number(row.DELTA_VALUE_EUR) || 0,
      isStale: row.BASE_PLAN_WEEK < context.HISTORY_END_WEEK,
    })),
    options: {
      ...filterOptions,
      hierarchy: hierarchyOptions,
      weeks: weeks.map((row) => row.WEEK_ID),
      series: seriesOptions.map((row) => ({
        seriesId: row.SERIES_ID,
        label: row.SERIES_LABEL,
        productName: row.PRODUCT_NAME,
        productLine: row.PRODUCT_LINE,
        customerName: row.CUSTOMER_NAME,
        channelName: row.CHANNEL_NAME,
        categoryName: row.CATEGORY_NAME,
      })),
    },
  };
}

async function copyScenarioEdits(fromScenarioId: string, toScenarioId: string, actor: string) {
  await query(
    `INSERT INTO CORE.FACT_SCENARIO_EDIT (
       SCENARIO_ID, SERIES_ID, WEEK_ID, BASE_UNITS, EDIT_UNITS, DELTA_UNITS,
       ORIGIN, SOURCE_PROPOSAL_ID, REASON_CODE, NOTE, EDIT_GROUP_ID,
       PARENT_LEVEL, PARENT_KEY, DISAGG_METHOD, EDITED_BY, EDITED_AT
     )
     SELECT ?, SERIES_ID, WEEK_ID, BASE_UNITS, EDIT_UNITS, DELTA_UNITS,
            ORIGIN, SOURCE_PROPOSAL_ID, REASON_CODE, NOTE, EDIT_GROUP_ID,
            PARENT_LEVEL, PARENT_KEY, DISAGG_METHOD, ?, CURRENT_TIMESTAMP()
     FROM CORE.FACT_SCENARIO_EDIT
     WHERE SCENARIO_ID = ?`,
    [toScenarioId, actor, fromScenarioId],
  );
  // Price-change drivers travel with their edits, or the copy's value lines
  // would use the list price while its volumes carry the price response.
  await query(
    `INSERT INTO CORE.FACT_SCENARIO_DRIVER (
       SCENARIO_ID, SERIES_ID, WEEK_ID, MEASURE_CODE, DRIVER_VALUE, EDIT_GROUP_ID, EDITED_BY, EDITED_AT
     )
     SELECT ?, SERIES_ID, WEEK_ID, MEASURE_CODE, DRIVER_VALUE, EDIT_GROUP_ID, ?, CURRENT_TIMESTAMP()
     FROM CORE.FACT_SCENARIO_DRIVER
     WHERE SCENARIO_ID = ?`,
    [toScenarioId, actor, fromScenarioId],
  );
}

async function createScenarioRecord(params: {
  name: string;
  description: string | null;
  actor: string;
  basePlanWeek: string;
  parentScenarioId: string | null;
}) {
  const scenarioId = crypto.randomUUID();
  await query(
    `INSERT INTO CORE.DIM_SCENARIO (
       SCENARIO_ID, SCENARIO_NAME, DESCRIPTION, STATUS, BASE_PLAN_WEEK,
       PARENT_SCENARIO_ID, CREATED_BY, CREATED_AT, UPDATED_AT
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
    [
      scenarioId,
      params.name,
      params.description,
      "draft",
      params.basePlanWeek,
      params.parentScenarioId,
      params.actor,
    ],
  );
  return scenarioId;
}

export async function GET(req: NextRequest) {
  try {
    const includeDiscarded = req.nextUrl.searchParams.get("includeDiscarded") === "1";
    const path = parseHierarchyPath(req.nextUrl.searchParams);
    return NextResponse.json(await loadScenarioIndex(includeDiscarded, path));
  } catch (err) {
    console.error("scenarios route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load scenarios" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ScenarioAction;
    if (!body || typeof body !== "object" || !("action" in body)) {
      return badRequest("A scenario action is required.");
    }

    const context = await getContext();
    const actor = await getActor();

    if (body.action === "create") {
      const name = normaliseRequiredText(body.name, MAX_NAME_LENGTH);
      if (!name) return badRequest("Scenario name is required.");
      const description = normaliseOptionalText(body.description, MAX_DESCRIPTION_LENGTH);

      let copyFrom: string | null = null;
      if (body.copyFrom !== undefined && body.copyFrom !== null) {
        if (typeof body.copyFrom !== "string" || !isScenarioId(body.copyFrom)) {
          return badRequest("copyFrom must be a valid scenario id.");
        }
        const source = await getScenarioSummary(body.copyFrom);
        if (!source) return badRequest("The source scenario does not exist.", 404);
        copyFrom = body.copyFrom;
      }

      const scenarioId = await createScenarioRecord({
        name,
        description,
        actor,
        basePlanWeek: context.HISTORY_END_WEEK,
        parentScenarioId: copyFrom,
      });

      if (copyFrom) {
        await copyScenarioEdits(copyFrom, scenarioId, actor);
      }

      return NextResponse.json({ ok: true, scenarioId, action: body.action }, { status: 201 });
    }

    if (!["rename", "discard", "promote", "duplicate"].includes(body.action)) {
      return badRequest("Unsupported scenario action.");
    }

    const scenarioId = typeof body.scenarioId === "string" ? body.scenarioId : null;
    if (!isScenarioId(scenarioId)) {
      return badRequest("scenarioId must be a valid scenario id.");
    }

    const scenario = await getScenarioSummary(scenarioId);
    if (!scenario) return badRequest("Scenario not found.", 404);

    if (body.action === "rename") {
      if (scenario.STATUS !== "draft") {
        return badRequest("Only draft scenarios can be renamed.", 409);
      }
      const name = normaliseRequiredText(body.name, MAX_NAME_LENGTH);
      if (!name) return badRequest("Scenario name is required.");
      const description = normaliseOptionalText(body.description, MAX_DESCRIPTION_LENGTH);
      await query(
        `UPDATE CORE.DIM_SCENARIO
         SET SCENARIO_NAME = ?,
             DESCRIPTION = ?,
             UPDATED_AT = CURRENT_TIMESTAMP()
         WHERE SCENARIO_ID = ?`,
        [name, description, scenarioId],
      );
      return NextResponse.json({ ok: true, scenarioId, action: body.action });
    }

    if (body.action === "discard") {
      if (scenario.STATUS !== "draft") {
        return badRequest("Only draft scenarios can be discarded.", 409);
      }
      await query(
        `UPDATE CORE.DIM_SCENARIO
         SET STATUS = ?, UPDATED_AT = CURRENT_TIMESTAMP()
         WHERE SCENARIO_ID = ?`,
        ["discarded", scenarioId],
      );
      return NextResponse.json({ ok: true, scenarioId, action: body.action });
    }

    if (body.action === "duplicate") {
      const name = normaliseRequiredText(
        body.name ?? `${scenario.SCENARIO_NAME} copy`,
        MAX_NAME_LENGTH,
      );
      if (!name) return badRequest("Scenario name is required.");
      const description = normaliseOptionalText(
        body.description ?? scenario.DESCRIPTION,
        MAX_DESCRIPTION_LENGTH,
      );
      const duplicatedScenarioId = await createScenarioRecord({
        name,
        description,
        actor,
        basePlanWeek: context.HISTORY_END_WEEK,
        parentScenarioId: scenarioId,
      });
      await copyScenarioEdits(scenarioId, duplicatedScenarioId, actor);
      return NextResponse.json(
        { ok: true, scenarioId: duplicatedScenarioId, sourceScenarioId: scenarioId, action: body.action },
        { status: 201 },
      );
    }

    if (scenario.STATUS !== "draft") {
      return badRequest("Only draft scenarios can be promoted.", 409);
    }
    if ((Number(scenario.EDIT_COUNT) || 0) === 0) {
      return badRequest("A scenario needs at least one edit before it can be promoted.", 409);
    }

    // Promotion no longer writes the committed plan here. It raises an approval
    // request; the demand lead's approval runs CORE.SP_ACT_ON_REQUEST, which
    // re-checks staleness, locks and the cycle and applies the promotion in one
    // transaction. See snowflake/13-approvals.sql.
    if ((body as { confirm?: unknown }).confirm !== true) {
      return badRequest("Set confirm=true to submit this scenario for approval.", 409);
    }
    const note = normaliseOptionalText((body as { note?: unknown }).note, MAX_DESCRIPTION_LENGTH);
    try {
      const submitted = await submitScenarioPromotion(scenarioId, await getPersona(), note);
      return NextResponse.json({
        ok: true,
        scenarioId,
        action: body.action,
        status: "in_review",
        requestId: submitted.requestId,
      });
    } catch (err) {
      if (err instanceof ApprovalError) return badRequest(err.message, err.status);
      throw err;
    }
  } catch (err) {
    console.error("scenario action failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to update scenario" },
      { status: 500 },
    );
  }
}