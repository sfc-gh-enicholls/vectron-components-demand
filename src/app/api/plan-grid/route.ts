import { NextRequest, NextResponse } from "next/server";
import { getContext } from "@/lib/data";
import { query } from "@/lib/snowflake";
import { priceMultiplier } from "@/lib/scenario";
import { buildGridMatrix, childLevelFor, loadLeafCells, loadMeasureModel } from "@/lib/measures";
import { evaluateLeaf } from "@/lib/measure-model";
import { findOverlaps, type GridEdit } from "@/lib/grid-edits";
import { PATH_LEVELS, ROLLUP_PARAMS } from "@/lib/dimensions";
import { deepestSelectedLevel, hierarchyLabel, parseHierarchyPath, pathLevelOrder, rollupsOf, type HierarchyPathServer } from "@/lib/hierarchy-path";
import { planSupplyWeeks, supplyByColumn, warmOrderCache } from "@/lib/supply";
import {
  getActor,
  getReason,
  getScenarioSummary,
  isScenarioId,
  isWeekId,
  normaliseOptionalText,
  MAX_NOTE_LENGTH,
  round2,
} from "../scenarios/shared";
import {
  buildPreview,
  commitPreview,
  drillOrder,
  parsePreviewRequestBody,
  serialiseNodeKey,
  type HierarchyLevel,
  type NodePath,
} from "../hierarchy/shared";

export const dynamic = "force-dynamic";

const GRID_EDITABLE = ["PLAN_UNITS", "PRICE_CHANGE_PCT"] as const;
const MAX_EDITS = 200;
const PRICE_CHANGE_LIMIT = 0.5;

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function visibleMeasureCodes(): Promise<string[]> {
  return (await loadMeasureModel()).measures.filter((measure) => measure.visible).map((measure) => measure.code);
}

/**
 * Why a row of this scope cannot take an edit, or null when it can.
 * A write is stored against a node, and a node is a contiguous path from the
 * category down (see writeBlockedReason in /api/plan-view) — or down the
 * chosen roll-up's levels when one is in use. The root total has no node at
 * all on /hierarchy.
 */
function rowWriteBlock(path: HierarchyPathServer, isTotal: boolean, mode: "scenario" | "stream"): string | null {
  const order = pathLevelOrder(path);
  const selected = order.filter((level) => path[level]);
  const deepest = deepestSelectedLevel(path);
  const depth = deepest ? order.indexOf(deepest) + 1 : 0;
  if (selected.length !== depth || PATH_LEVELS.some((level) => path[level] && !order.includes(level))) {
    return "This scope skips a level of the hierarchy, so it is a cross-section, not a node. Edits are entered on a node.";
  }
  // A stream input may be entered on the whole portfolio (/plan has always
  // allowed it); a scenario edit on /hierarchy is entered on a named node.
  if (isTotal && depth === 0 && mode === "scenario") {
    return "The portfolio total cannot be edited here. Edit a category row, or choose a category.";
  }
  return null;
}

/** The hierarchy node a grid row stands for. */
function nodeForRow(path: HierarchyPathServer, rowKey: string, isTotal: boolean): { level: HierarchyLevel; nodePath: NodePath } {
  if (isTotal) {
    const level = deepestSelectedLevel(path)!;
    return { level, nodePath: { ...path } };
  }
  const rowLevel = childLevelFor(path);
  return { level: rowLevel, nodePath: { ...path, [rowLevel]: rowKey } };
}

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const path = parseHierarchyPath(params);
    const scenarioId = params.get("scenarioId");
    if (scenarioId && !isScenarioId(scenarioId)) return badRequest("scenarioId must be a valid scenario id.");
    const mode = params.get("mode") === "stream" ? "stream" : "scenario";
    const streamParam = params.get("stream");
    const streamId = mode === "stream" && streamParam && /^[a-z_]{2,20}$/.test(streamParam) ? streamParam : null;
    if (mode === "stream" && !streamId) return badRequest("stream is required in stream mode.");
    const rollupParam = params.get("rollup");
    const rollup = rollupParam === "month" || rollupParam === "quarter" ? rollupParam : "none";
    const weekFrom = params.get("weekFrom");
    const weekTo = params.get("weekTo");
    if ((weekFrom && !isWeekId(weekFrom)) || (weekTo && !isWeekId(weekTo))) return badRequest("Weeks must look like 2026-W40.");

    // Read-only supply reference from the last constrained solve of this plan,
    // fetched alongside the matrix. A supply failure must never take the
    // planning grid down with it.
    const supplyWeeksPromise = planSupplyWeeks(scenarioId ?? "COMMITTED", path).catch((err) => {
      console.error("plan-grid supply line failed:", err);
      return null;
    });
    const [context, matrix, scenario] = await Promise.all([
      getContext(),
      buildGridMatrix({
        path,
        scenarioId,
        streamId,
        weekFrom,
        weekTo,
        rollup,
        // Stream mode adds the stream's own figure, the row a stream input edits.
        measureCodes: streamId ? [...(await visibleMeasureCodes()), "STREAM_VIEW_UNITS"] : undefined,
        nodeLabel: hierarchyLabel(path) || "Portfolio",
      }),
      scenarioId ? getScenarioSummary(scenarioId) : Promise.resolve(null),
    ]);
    if (scenarioId && !scenario) return badRequest("Scenario not found.", 404);

    const supply = supplyByColumn(await supplyWeeksPromise, matrix.columns);

    return NextResponse.json({
      context,
      scenario: scenario ? { id: scenario.SCENARIO_ID, name: scenario.SCENARIO_NAME, status: scenario.STATUS } : null,
      matrix: {
        ...matrix,
        rows: matrix.rows.map((row) => ({ ...row, writeBlock: rowWriteBlock(path, row.isTotal, mode) })),
      },
      editable: GRID_EDITABLE,
      supply,
    });
  } catch (err) {
    console.error("plan-grid GET failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to load the planning grid" }, { status: 500 });
  }
}

interface PriceLeafWrite {
  seriesId: string;
  weekId: string;
  baseUnits: number;
  editUnits: number;
  pct: number;
}

/**
 * A price change on a node-week: the same percentage on every unlocked leaf
 * beneath it. The volume response uses priceMultiplier (elasticity.json),
 * applied to the leaf's plan BEFORE price, so re-editing a price replaces the
 * previous response rather than compounding it.
 */
async function planPriceEdit(path: HierarchyPathServer, edit: GridEdit, scenarioId: string) {
  const node = nodeForRow(path, edit.rowKey, edit.isTotal);
  const leafPath: HierarchyPathServer = {};
  for (const level of PATH_LEVELS) if (node.nodePath[level]) leafPath[level] = node.nodePath[level];
  const [model, cells] = await Promise.all([
    loadMeasureModel(),
    loadLeafCells({
      path: leafPath,
      seriesId: node.nodePath.SERIES_ID ?? null,
      scenarioId,
      weekFrom: edit.weekId,
      weekTo: edit.weekId,
    }),
  ]);
  const writes: PriceLeafWrite[] = [];
  let locked = 0;
  let currentUnits = 0;
  for (const cell of cells) {
    const values = evaluateLeaf(model, cell.inputs);
    currentUnits += values.get("PLAN_UNITS") ?? 0;
    if (cell.locked) {
      locked += 1;
      continue;
    }
    const beforePrice = values.get("COMMITTED_UNITS") ?? 0;
    const response = priceMultiplier(edit.value, cell.priceTier, cell.attrs.CHANNEL_NAME);
    writes.push({
      seriesId: cell.seriesId,
      weekId: cell.weekId,
      baseUnits: round2(cell.committedUnits),
      editUnits: round2(Math.max(0, beforePrice * response)),
      pct: edit.value,
    });
  }
  const proposed = writes.reduce((total, w) => total + w.editUnits, 0)
    + cells.filter((cell) => cell.locked).reduce((total, cell) => total + (evaluateLeaf(model, cell.inputs).get("PLAN_UNITS") ?? 0), 0);
  return { node, writes, locked, currentUnits: round2(currentUnits), proposedUnits: round2(proposed) };
}

async function writePriceEdit(scenarioId: string, writes: PriceLeafWrite[], reasonCode: string, note: string | null, parentLevel: string, parentKey: string) {
  if (writes.length === 0) return { editGroupId: null, writtenRows: 0 };
  const actor = await getActor();
  const editGroupId = crypto.randomUUID();
  const driverSelects = writes.map(() => "SELECT ? AS SCENARIO_ID, ? AS SERIES_ID, ? AS WEEK_ID, ? AS DRIVER_VALUE").join(" UNION ALL ");
  await query(
    `MERGE INTO CORE.FACT_SCENARIO_DRIVER AS t
     USING (${driverSelects}) AS s
     ON t.SCENARIO_ID = s.SCENARIO_ID AND t.SERIES_ID = s.SERIES_ID AND t.WEEK_ID = s.WEEK_ID
        AND t.MEASURE_CODE = 'PRICE_CHANGE_PCT'
     WHEN MATCHED THEN UPDATE SET DRIVER_VALUE = s.DRIVER_VALUE, EDIT_GROUP_ID = ?, EDITED_BY = ?, EDITED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (SCENARIO_ID, SERIES_ID, WEEK_ID, MEASURE_CODE, DRIVER_VALUE, EDIT_GROUP_ID, EDITED_BY, EDITED_AT)
       VALUES (s.SCENARIO_ID, s.SERIES_ID, s.WEEK_ID, 'PRICE_CHANGE_PCT', s.DRIVER_VALUE, ?, ?, CURRENT_TIMESTAMP())`,
    [...writes.flatMap((w) => [scenarioId, w.seriesId, w.weekId, w.pct]), editGroupId, actor, editGroupId, actor],
  );
  const editSelects = writes
    .map(() => "SELECT ? AS SCENARIO_ID, ? AS SERIES_ID, ? AS WEEK_ID, ? AS BASE_UNITS, ? AS EDIT_UNITS, ? AS DELTA_UNITS")
    .join(" UNION ALL ");
  await query(
    `MERGE INTO CORE.FACT_SCENARIO_EDIT AS t
     USING (${editSelects}) AS s
     ON t.SCENARIO_ID = s.SCENARIO_ID AND t.SERIES_ID = s.SERIES_ID AND t.WEEK_ID = s.WEEK_ID
     WHEN MATCHED THEN UPDATE SET BASE_UNITS = s.BASE_UNITS, EDIT_UNITS = s.EDIT_UNITS, DELTA_UNITS = s.DELTA_UNITS,
       ORIGIN = 'planner', SOURCE_PROPOSAL_ID = NULL, REASON_CODE = ?, NOTE = ?, EDIT_GROUP_ID = ?,
       PARENT_LEVEL = ?, PARENT_KEY = ?, DISAGG_METHOD = 'price_driver', EDITED_BY = ?, EDITED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (SCENARIO_ID, SERIES_ID, WEEK_ID, BASE_UNITS, EDIT_UNITS, DELTA_UNITS, ORIGIN,
       SOURCE_PROPOSAL_ID, REASON_CODE, NOTE, EDIT_GROUP_ID, PARENT_LEVEL, PARENT_KEY, DISAGG_METHOD, EDITED_BY, EDITED_AT)
       VALUES (s.SCENARIO_ID, s.SERIES_ID, s.WEEK_ID, s.BASE_UNITS, s.EDIT_UNITS, s.DELTA_UNITS, 'planner', NULL,
       ?, ?, ?, ?, ?, 'price_driver', ?, CURRENT_TIMESTAMP())`,
    [
      ...writes.flatMap((w) => [scenarioId, w.seriesId, w.weekId, w.baseUnits, w.editUnits, round2(w.editUnits - w.baseUnits)]),
      reasonCode, note, editGroupId, parentLevel, parentKey, actor,
      reasonCode, note, editGroupId, parentLevel, parentKey, actor,
    ],
  );
  await query(`UPDATE CORE.DIM_SCENARIO SET UPDATED_AT = CURRENT_TIMESTAMP() WHERE SCENARIO_ID = ?`, [scenarioId]);
  warmOrderCache(scenarioId);
  return { editGroupId, writtenRows: writes.length };
}

/**
 * Body: { scenarioId, path: {CATEGORY_NAME?, ...}, edits: GridEdit[],
 *         disaggMethod, reasonCode?, note?, confirm? }
 *
 * Without confirm=true every edit is previewed and nothing is written. With
 * it, each edit is committed in order: a Plan edit through the hierarchy
 * editor's preview + commit (so it is spread to children exactly as an edit
 * on /hierarchy is), a price edit as driver overrides plus volume response.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("A request body is required.");
    const scenarioId = typeof body.scenarioId === "string" ? body.scenarioId : null;
    if (!isScenarioId(scenarioId)) return badRequest("scenarioId must be a valid scenario id.");
    const scenario = await getScenarioSummary(scenarioId);
    if (!scenario) return badRequest("Scenario not found.", 404);
    if (scenario.STATUS !== "draft") {
      return badRequest(
        scenario.STATUS === "in_review"
          ? "This scenario is awaiting approval and is frozen. Withdraw the request to edit it."
          : "Only draft scenarios can be edited.",
        409,
      );
    }

    // The same keys the GET reads off the query string, roll-ups included, so
    // the node is read in the drill order the grid was drawn in.
    const pathRecord = (body.path ?? {}) as Record<string, unknown>;
    const pathParams = new URLSearchParams();
    for (const key of [...PATH_LEVELS, ...ROLLUP_PARAMS]) {
      const value = pathRecord[key];
      if (typeof value === "string" && value.trim()) pathParams.set(key, value.trim());
    }
    const path: HierarchyPathServer = parseHierarchyPath(pathParams);
    const order = drillOrder(rollupsOf(path));

    const rawEdits = Array.isArray(body.edits) ? body.edits : [];
    if (rawEdits.length === 0) return badRequest("No edits to apply.");
    if (rawEdits.length > MAX_EDITS) return badRequest(`At most ${MAX_EDITS} cells can be submitted at once.`);
    const context = await getContext();
    const edits: GridEdit[] = [];
    for (const raw of rawEdits as Record<string, unknown>[]) {
      const measure = raw.measure;
      const weekId = raw.weekId;
      const value = Number(raw.value);
      if (typeof measure !== "string" || !(GRID_EDITABLE as readonly string[]).includes(measure)) {
        return badRequest("Only Plan and Price change can be edited in the grid.");
      }
      if (typeof weekId !== "string" || !isWeekId(weekId) || weekId < context.CURRENT_WEEK || weekId > context.HORIZON_END_WEEK) {
        return badRequest(`Edits must be in the live horizon ${context.CURRENT_WEEK} to ${context.HORIZON_END_WEEK}.`);
      }
      if (!Number.isFinite(value)) return badRequest("Edit values must be numbers.");
      if (measure === "PLAN_UNITS" && value < 0) return badRequest("A plan cannot be negative.");
      if (measure === "PRICE_CHANGE_PCT" && Math.abs(value) > PRICE_CHANGE_LIMIT) {
        return badRequest(`A price change beyond ±${PRICE_CHANGE_LIMIT * 100}% is outside the range the elasticity assumptions support.`);
      }
      const isTotal = raw.isTotal === true;
      const rowKey = typeof raw.rowKey === "string" ? raw.rowKey : "";
      if (!isTotal && !rowKey) return badRequest("Each edit needs a rowKey.");
      const block = rowWriteBlock(path, isTotal, "scenario");
      if (block) return badRequest(block);
      edits.push({ rowKey, isTotal, weekId, measure, value, previous: null });
    }
    const overlaps = findOverlaps(edits);
    if (overlaps.length > 0) {
      return badRequest(`The batch makes two changes to the same cells in ${overlaps.join(", ")} (a total and a row beneath it, or Plan and Price on one row). Keep one of them.`, 409);
    }

    const disaggMethod = body.disaggMethod === "current_plan" ? "current_plan" : "statistical";
    const confirm = body.confirm === true;
    let reasonCode: string | null = null;
    let note: string | null = null;
    if (confirm) {
      reasonCode = typeof body.reasonCode === "string" ? body.reasonCode : null;
      if (!reasonCode) return badRequest("reasonCode is required.");
      const reason = await getReason(reasonCode);
      if (!reason) return badRequest("Unknown reason code.");
      note = normaliseOptionalText(body.note, MAX_NOTE_LENGTH);
      if (reason.REQUIRES_NOTE && !note) return badRequest(`Reason '${reasonCode}' requires a note.`);
    }

    const results: Array<Record<string, unknown>> = [];
    for (const edit of edits) {
      const node = nodeForRow(path, edit.rowKey, edit.isTotal);
      const nodeKey = serialiseNodeKey(node.level, node.nodePath, order);
      const nodeLabel = node.nodePath.SERIES_ID ?? node.nodePath[node.level as keyof NodePath] ?? nodeKey;

      if (edit.measure === "PLAN_UNITS") {
        const parsed = parsePreviewRequestBody({
          scenarioId,
          node: { level: node.level, key: nodeKey },
          disaggMethod,
          weekRange: { from: edit.weekId, to: edit.weekId },
          target: { mode: "absolute", value: edit.value },
        }, rollupsOf(path));
        if ("message" in parsed) return badRequest(parsed.message, parsed.status);
        const preview = await buildPreview(parsed);
        const summary = {
          measure: edit.measure,
          node: preview.node.label,
          weekId: edit.weekId,
          currentUnits: preview.node.currentUnits,
          targetUnits: preview.node.targetUnits,
          appliedDelta: preview.outcome.appliedDelta,
          feasible: preview.outcome.feasible,
          shortfall: preview.outcome.shortfall,
          lockedLeafCount: preview.outcome.lockedLeafCount,
          agentEditsReplaced: preview.outcome.agentEditsReplaced,
        };
        if (!confirm) {
          results.push(summary);
          continue;
        }
        if (!preview.outcome.feasible) {
          return badRequest(`${preview.node.label} in ${edit.weekId} cannot reach the target: ${preview.outcome.shortfall} units short after locks and zero floors. Nothing after the first ${results.length} edit(s) was written.`, 409);
        }
        const commit = await commitPreview({ ...parsed, reasonCode: reasonCode!, note }, preview);
        results.push({ ...summary, ...commit });
      } else {
        const plan = await planPriceEdit(path, edit, scenarioId);
        const summary = {
          measure: edit.measure,
          node: String(nodeLabel),
          weekId: edit.weekId,
          priceChangePct: edit.value,
          currentUnits: plan.currentUnits,
          targetUnits: plan.proposedUnits,
          appliedDelta: round2(plan.proposedUnits - plan.currentUnits),
          feasible: plan.writes.length > 0,
          lockedLeafCount: plan.locked,
        };
        if (!confirm) {
          results.push(summary);
          continue;
        }
        if (plan.writes.length === 0) return badRequest(`Every cell under ${nodeLabel} in ${edit.weekId} is locked.`, 409);
        const commit = await writePriceEdit(scenarioId, plan.writes, reasonCode!, note, node.level, String(nodeLabel));
        results.push({ ...summary, ...commit });
      }
    }

    const totalDelta = round2(results.reduce((total, r) => total + (Number(r.appliedDelta) || 0), 0));
    return NextResponse.json({
      ok: true,
      action: confirm ? "commit" : "preview",
      scenario: { id: scenario.SCENARIO_ID, name: scenario.SCENARIO_NAME },
      results,
      totalDelta,
      allFeasible: results.every((r) => r.feasible !== false),
    });
  } catch (err) {
    console.error("plan-grid POST failed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Failed to apply grid edits" }, { status: 500 });
  }
}
