import { NextRequest, NextResponse } from "next/server";
import { disaggregate, disaggregateByPercent, type DisaggMethod } from "@/lib/disaggregate";
import { getContext, getIntegrity } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import { ALT_LEVELS, BASE_LEVELS, PATH_LEVELS, type Rollups } from "@/lib/dimensions";
import {
  deepestSelectedLevel,
  hierarchyLabel,
  hierarchyPredicate,
  parseHierarchyPath,
  pathLevelOrder,
  rollupsOf,
  type HierarchyPathServer,
  type PathLevel,
} from "@/lib/hierarchy-path";
import { query } from "@/lib/snowflake";
import {
  MAX_NOTE_LENGTH,
  getActor,
  getReason,
  isScenarioId,
  isWeekId,
  normaliseOptionalText,
  round2,
  same2,
} from "../scenarios/shared";
import {
  LEVEL_NAMES,
  drillOrder,
  parseLevel,
  parseNodeKey,
  serialiseNodeKey,
  type HierarchyLevel,
  type NodePath,
} from "../hierarchy/shared";
import { getPersona } from "@/lib/persona";
import { ApprovalError, submitApproval } from "@/lib/approvals";

export const dynamic = "force-dynamic";

type Measure = "units" | "revenue";

type StreamRow = {
  STREAM_ID: string;
  STREAM_LABEL: string;
  DESCRIPTION: string | null;
  SEQUENCE_NO: number;
  COLOUR_TOKEN: string;
  IS_TARGET: boolean;
  OWNER_ROLE: string | null;
};

type ReasonRow = {
  REASON_CODE: string;
  REASON_LABEL: string;
  REASON_GROUP: string;
  REQUIRES_NOTE: boolean;
};

type ScenarioRow = {
  SCENARIO_ID: string;
  SCENARIO_NAME: string;
  STATUS: string;
  BASE_PLAN_WEEK: string;
  CREATED_AT: string;
  UPDATED_AT: string | null;
  DELTA_UNITS: number;
  DELTA_VALUE_EUR: number;
};

type WeekRow = {
  WEEK_ID: string;
  WEEK_START_DATE: string;
};

type ActualWeeklyRow = {
  WEEK_ID: string;
  ACTUAL_VALUE: number;
};

type ContributionWeeklyRow = {
  WEEK_ID: string;
  PLAN_VALUE: number;
  BASELINE_VALUE: number;
  EVENT_VALUE: number;
  PROMOTION_VALUE: number;
  SALES_VALUE: number;
  MARKETING_VALUE: number;
  FINANCE_VALUE: number;
  PLANNER_VALUE: number;
  AGENT_VALUE: number;
};

type ScenarioWeeklyRow = {
  SCENARIO_ID: string;
  SCENARIO_NAME: string;
  STATUS: string;
  WEEK_ID: string;
  SCENARIO_VALUE: number;
};

type AccuracyAggregateRow = {
  STREAM_ID: string;
  STREAM_LABEL: string;
  IS_TARGET: boolean;
  ROWS_SCORED: number;
  STREAM_ABS_ERROR_SUM: number;
  BASELINE_ABS_ERROR_SUM: number;
  BIAS_SUM: number;
  ACTUAL_SUM: number;
  BEAT_RATE: number;
};

type StreamLeafRow = {
  SERIES_ID: string;
  WEEK_ID: string;
  SERIES_LABEL: string;
  CATEGORY_NAME: string | null;
  PRODUCT_NAME: string | null;
  CUSTOMER_NAME: string | null;
  CHANNEL_NAME: string | null;
  PRODUCT_LINE: string | null;
  PRICE_TIER: string | null;
  REGION: string | null;
  ROUTE_TO_CUSTOMER: string | null;
  DELIVERY_MODE: string | null;
  CHANNEL_GROUP: string | null;
  BASE_UNITS: number;
  CURRENT_UNITS: number;
  STAT_UNITS: number;
  UNIT_PRICE_EUR: number;
};

type PreviewRequest = {
  streamId: string;
  level: HierarchyLevel;
  nodeKey: string;
  nodePath: NodePath;
  weekFrom: string;
  weekTo: string;
  targetMode: "absolute" | "percentage";
  targetValue: number;
  disaggMethod: DisaggMethod;
  /** Drill order the node key was built in (ROLLUP_* query params). */
  order: HierarchyLevel[];
};

type CommitRequest = PreviewRequest & {
  reasonCode: string;
  note: string | null;
};

/** Base levels, then alternate levels, then the series: the original bind order when no alternate is set. */
const WHERE_LEVELS: HierarchyLevel[] = [...BASE_LEVELS, ...ALT_LEVELS, "SERIES_ID"];

const STREAM_COMPONENT_ORDER = ["sales", "marketing", "finance", "planner", "agent"] as const;

const COMPONENT_META = {
  baseline: {
    key: "baseline",
    label: "Baseline",
    description: "Statistical baseline net of the derived event and promotion effects.",
    colourToken: "chart-1",
    kind: "baseline",
  },
  event: {
    key: "event",
    label: "Event (derived)",
    description: "Reconstructed from the calendar rather than directly measured.",
    colourToken: "chart-3",
    kind: "derived",
  },
  promotion: {
    key: "promotion",
    label: "Promotion (derived)",
    description: "Reconstructed from committed promotions rather than directly measured.",
    colourToken: "chart-5",
    kind: "derived",
  },
  agent: {
    key: "agent",
    label: "Agent",
    description: "Accepted agent proposals already absorbed into the committed plan.",
    colourToken: "chart-6",
    kind: "derived",
  },
} as const;

const ROOT_NODE_KEY = "{}";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parsePositiveInt(raw: string | null, fallback: number, min: number, max: number) {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function labelValue(value: string | null | undefined, fallback: string) {
  return value && value.trim().length > 0 ? value : fallback;
}

function nodeLabel(level: HierarchyLevel, path: NodePath): string {
  if (Object.keys(path).length === 0) return "Total portfolio";
  if (level === "SERIES_ID") return path.SERIES_ID ?? "Selected series";
  return path[level] ?? LEVEL_NAMES[level];
}

function parsePlanNodeKey(level: HierarchyLevel, raw: unknown, order: HierarchyLevel[]): NodePath | null {
  if (raw === ROOT_NODE_KEY && level === order[0]) {
    return {};
  }
  return parseNodeKey(level, raw, order);
}

function joinWords(words: string[]) {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * Why a stream input cannot be entered on this path, or null when it can.
 *
 * WHY A SKIPPED LEVEL BLOCKS WRITING BUT NOT VIEWING
 * --------------------------------------------------
 * Any combination of levels is a valid thing to look at: Cognac in China is a
 * perfectly good view. A write is different. It is stored against a node,
 * NODE_LEVEL plus a NODE_KEY that hierarchy/shared.ts parses back, and a node
 * is a contiguous path down Category > Product > Customer > Channel. Cognac in China
 * skips the product, so there is no node to store it against. The old selection
 * serialised it anyway, at CUSTOMER_NAME, into a key parseNodeKey rejects, so the
 * planner filled in the form and only found out at preview.
 *
 * Insisting on a contiguous path also keeps the rows written identical to the
 * rows viewed. The chart filters V_PLAN_CONTRIBUTION on its own level columns
 * and a commit filters the same view through V_SERIES; the two carry identical
 * level values on every row, so a node selects one set of series either way.
 *
 * The page shows this text and POST returns it, so the explanation a planner
 * reads cannot drift from the rule the server enforces.
 */
function writeBlockedReason(path: HierarchyPathServer): string | null {
  // The node runs down the chosen roll-up's levels. A level selected from
  // another tree (a category under a product-family roll-up) narrows the view but
  // is not part of any node, so writing there would spread wider than viewed.
  const order = pathLevelOrder(path);
  const outside = PATH_LEVELS.filter((level) => path[level] && !order.includes(level));
  if (outside.length > 0) {
    return `Overrides are entered on a node of the hierarchy in use. ${outside.map((level) => path[level]).join(" / ")} is not a level of the chosen roll-up — clear the ${joinWords(outside.map((level) => LEVEL_NAMES[level].toLowerCase()))}.`;
  }
  const selected = order.filter((level) => path[level]);
  const nodeLevel = deepestSelectedLevel(path);
  const depth = nodeLevel ? order.indexOf(nodeLevel) + 1 : 0;
  if (selected.length === depth) return null;

  // Levels left blank above the deepest one chosen, and the chosen levels
  // stranded below the first blank.
  const deepest = selected[selected.length - 1];
  const missing = order.slice(depth, order.indexOf(deepest)).filter((level) => !path[level]);
  const stranded = order.slice(depth).filter((level) => path[level]);
  const word = (level: PathLevel) => LEVEL_NAMES[level].toLowerCase();

  if (path.PRODUCT_NAME && missing.length === 1 && missing[0] === "CATEGORY_NAME") {
    // Every product sits under exactly one category, so this is a node with its
    // top level left blank, not a cross-section. The fix needs spelling out
    // because choosing a category resets the product.
    return `Overrides are entered on a node of the hierarchy, which starts at the category. Choose the category first — changing it resets the product, so pick ${path.PRODUCT_NAME} again afterwards.`;
  }
  const missingWords = joinWords(missing.map(word));
  return `Overrides are entered on a node of the hierarchy. ${stranded.map((level) => path[level]).join(" / ")} without a ${missingWords} is a cross-section, not a node — choose a ${missingWords}, or clear the ${joinWords(stranded.map(word))}.`;
}

/**
 * The node a stream input entered on this view is written to.
 *
 * At the root the key is ROOT_NODE_KEY, which parsePlanNodeKey maps back to the
 * whole portfolio, as before. A path with a skipped level gets no level and no
 * key at all, so the page has nothing to send: not a key the server would
 * reject, and not the nearest real node, which the server would accept and
 * write across rows the planner was not looking at.
 */
function selectionFromPath(path: HierarchyPathServer) {
  const blockedReason = writeBlockedReason(path);
  if (blockedReason) {
    return {
      level: null,
      key: null,
      label: hierarchyLabel(path),
      path,
      isRoot: false,
      writable: false,
      blockedReason,
    };
  }
  const order = drillOrder(rollupsOf(path));
  const level: HierarchyLevel = deepestSelectedLevel(path) ?? order[0];
  // ROLLUP_* keys are not levels: a path carrying only a roll-up is the root.
  const isRoot = PATH_LEVELS.every((pathLevel) => !path[pathLevel]);
  return {
    level,
    key: isRoot ? ROOT_NODE_KEY : serialiseNodeKey(level, path, order),
    label: isRoot ? "Total portfolio" : nodeLabel(level, path),
    path,
    isRoot,
    writable: true,
    blockedReason: null,
  };
}

/**
 * The reason a submitted node key was refused, when the reason is a skipped
 * level. parseNodeKey already refuses such keys; this replaces its bare
 * "invalid" with the explanation the page gives, for any caller that sends one.
 */
function skippedLevelReason(rawKey: string, rollups: Rollups): string | null {
  try {
    const parsed = JSON.parse(rawKey) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const path: HierarchyPathServer = {};
    for (const [dimension, id] of Object.entries(rollups)) {
      path[`ROLLUP_${dimension}` as keyof HierarchyPathServer] = id;
    }
    for (const level of PATH_LEVELS) {
      const value = (parsed as Record<string, unknown>)[level];
      if (typeof value === "string" && value.trim().length > 0) path[level] = value.trim();
    }
    return writeBlockedReason(path);
  } catch {
    return null;
  }
}

function buildPathClause(path: NodePath) {
  const parts: string[] = [];
  const binds: string[] = [];
  for (const level of WHERE_LEVELS) {
    const value = path[level];
    if (!value) continue;
    parts.push(`s.${level} = ?`);
    binds.push(value);
  }
  return {
    clause: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "",
    binds,
  };
}

function childLevelForNode(level: HierarchyLevel, nodePath: NodePath, order: HierarchyLevel[]): HierarchyLevel | "WEEK_ID" {
  if (level === order[0] && Object.keys(nodePath).length === 0) {
    return order[0];
  }
  const index = order.indexOf(level);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : "WEEK_ID";
}

function immediateChildMeta(row: StreamLeafRow, level: HierarchyLevel, nodePath: NodePath, order: HierarchyLevel[]) {
  const childLevel = childLevelForNode(level, nodePath, order);
  if (childLevel === "WEEK_ID") {
    return {
      childId: row.WEEK_ID,
      childLabel: row.WEEK_ID,
      childLevel,
      nodeKey: `${row.SERIES_ID}:${row.WEEK_ID}`,
    };
  }

  // The child's path is every level of the drill order down to the child.
  const childPath: NodePath = {};
  for (const pathLevel of order.slice(0, order.indexOf(childLevel) + 1)) {
    childPath[pathLevel] = pathLevel === "SERIES_ID" ? row.SERIES_ID : labelValue(row[pathLevel], "Unassigned");
  }

  return {
    childId: childLevel === "SERIES_ID" ? row.SERIES_ID : (childPath[childLevel] ?? "Unassigned"),
    childLabel: childLevel === "SERIES_ID"
      ? row.SERIES_LABEL
      : labelValue(row[childLevel], "Unassigned"),
    childLevel,
    nodeKey: serialiseNodeKey(childLevel, childPath, order),
  };
}

function sum(rows: number[]) {
  return round2(rows.reduce((total, value) => total + value, 0));
}

function toMeasureSql(column: string, priceColumn: string, measure: Measure) {
  return measure === "revenue" ? `${column} * ${priceColumn}` : column;
}

async function loadStreamMetadata() {
  return query<StreamRow>(
    `SELECT STREAM_ID, STREAM_LABEL, DESCRIPTION, SEQUENCE_NO, COLOUR_TOKEN, IS_TARGET, OWNER_ROLE
     FROM CORE.DIM_INPUT_STREAM
     ORDER BY SEQUENCE_NO`,
  );
}

async function loadReasons() {
  return query<ReasonRow>(
    `SELECT REASON_CODE, REASON_LABEL, REASON_GROUP, REQUIRES_NOTE
     FROM CORE.DIM_REASON_CODE
     ORDER BY REASON_GROUP, REASON_LABEL`,
  );
}

async function loadScenarios() {
  return query<ScenarioRow>(
    `SELECT SCENARIO_ID, SCENARIO_NAME, STATUS, BASE_PLAN_WEEK, CREATED_AT, UPDATED_AT, DELTA_UNITS, DELTA_VALUE_EUR
     FROM APP.V_SCENARIO_SUMMARY
     ORDER BY COALESCE(UPDATED_AT, CREATED_AT) DESC, CREATED_AT DESC`,
  );
}

async function loadWeekWindow(historyEndWeek: string, weeksBack: number, weeksForward: number) {
  const rows = await query<WeekRow>(
    `SELECT WEEK_ID, TO_VARCHAR(WEEK_START_DATE) AS WEEK_START_DATE
     FROM CORE.DIM_WEEK
     WHERE WEEK_START_DATE BETWEEN (
       SELECT DATEADD('week', ?, WEEK_START_DATE)
       FROM CORE.DIM_WEEK
       WHERE WEEK_ID = ?
     ) AND (
       SELECT DATEADD('week', ?, WEEK_START_DATE)
       FROM CORE.DIM_WEEK
       WHERE WEEK_ID = ?
     )
     ORDER BY WEEK_START_DATE`,
    [-(weeksBack - 1), historyEndWeek, weeksForward, historyEndWeek],
  );
  return rows;
}

async function loadActuals(path: HierarchyPathServer, fromWeek: string, toWeek: string, measure: Measure) {
  const where = hierarchyPredicate(path, "s");
  return query<ActualWeeklyRow>(
    `SELECT a.WEEK_ID,
            SUM(${measure === "revenue" ? "a.POS_REVENUE_EUR" : "a.POS_UNITS"}) AS ACTUAL_VALUE
     FROM APP.V_ACTUALS_WEEKLY a
     JOIN APP.V_SERIES s
       ON s.SERIES_ID = a.SERIES_ID
     WHERE a.WEEK_ID BETWEEN ? AND ?
       AND ${where.sql}
     GROUP BY a.WEEK_ID
     ORDER BY a.WEEK_ID`,
    [fromWeek, toWeek, ...where.binds],
  );
}

async function loadContributionSeries(path: HierarchyPathServer, fromWeek: string, toWeek: string, measure: Measure) {
  const where = hierarchyPredicate(path, "p");

  return query<ContributionWeeklyRow>(
    `SELECT p.WEEK_ID,
            SUM(${toMeasureSql("p.PLAN_UNITS", "p.UNIT_PRICE_EUR", measure)}) AS PLAN_VALUE,
            SUM(${toMeasureSql("p.BASELINE_UNITS", "p.UNIT_PRICE_EUR", measure)}) AS BASELINE_VALUE,
            SUM(${toMeasureSql("p.EVENT_UNITS", "p.UNIT_PRICE_EUR", measure)}) AS EVENT_VALUE,
            SUM(${toMeasureSql("p.PROMO_UNITS", "p.UNIT_PRICE_EUR", measure)}) AS PROMOTION_VALUE,
            SUM(${toMeasureSql("p.SALES_DELTA", "p.UNIT_PRICE_EUR", measure)}) AS SALES_VALUE,
            SUM(${toMeasureSql("p.MARKETING_DELTA", "p.UNIT_PRICE_EUR", measure)}) AS MARKETING_VALUE,
            SUM(${toMeasureSql("p.FINANCE_DELTA", "p.UNIT_PRICE_EUR", measure)}) AS FINANCE_VALUE,
            SUM(${toMeasureSql("p.PLANNER_DELTA", "p.UNIT_PRICE_EUR", measure)}) AS PLANNER_VALUE,
            SUM(${toMeasureSql("p.AGENT_DELTA", "p.UNIT_PRICE_EUR", measure)}) AS AGENT_VALUE
     FROM APP.V_PLAN_CONTRIBUTION p
     WHERE p.WEEK_ID BETWEEN ? AND ?
       AND ${where.sql}
     GROUP BY p.WEEK_ID
     ORDER BY p.WEEK_ID`,
    [fromWeek, toWeek, ...where.binds],
  );
}

async function loadScenarioOverlay(
  path: HierarchyPathServer,
  scenarioIds: string[],
  fromWeek: string,
  toWeek: string,
  measure: Measure,
) {
  if (scenarioIds.length === 0) return [];
  const where = hierarchyPredicate(path, "s");
  const placeholders = scenarioIds.map(() => "?").join(", ");
  return query<ScenarioWeeklyRow>(
    `SELECT sp.SCENARIO_ID,
            ss.SCENARIO_NAME,
            ss.STATUS,
            sp.WEEK_ID,
            SUM(${measure === "revenue" ? "sp.SCENARIO_VALUE_EUR" : "sp.SCENARIO_UNITS"}) AS SCENARIO_VALUE
     FROM APP.V_SCENARIO_PLAN sp
     JOIN APP.V_SERIES s
       ON s.SERIES_ID = sp.SERIES_ID
     JOIN APP.V_SCENARIO_SUMMARY ss
       ON ss.SCENARIO_ID = sp.SCENARIO_ID
     WHERE sp.SCENARIO_ID IN (${placeholders})
       AND sp.WEEK_ID BETWEEN ? AND ?
       AND ${where.sql}
     GROUP BY sp.SCENARIO_ID, ss.SCENARIO_NAME, ss.STATUS, sp.WEEK_ID
     ORDER BY ss.SCENARIO_NAME, sp.WEEK_ID`,
    [...scenarioIds, fromWeek, toWeek, ...where.binds],
  );
}

async function loadAccuracy(path: HierarchyPathServer, measure: Measure) {
  const where = hierarchyPredicate(path, "s");
  const factor = measure === "revenue" ? "a.UNIT_PRICE_EUR" : "1";
  return query<AccuracyAggregateRow>(
    `SELECT a.STREAM_ID,
            a.STREAM_LABEL,
            a.IS_TARGET,
            COUNT(*) AS ROWS_SCORED,
            SUM(a.STREAM_ABS_ERROR * ${factor}) AS STREAM_ABS_ERROR_SUM,
            SUM(a.BASELINE_ABS_ERROR * ${factor}) AS BASELINE_ABS_ERROR_SUM,
            SUM(a.STREAM_BIAS * ${factor}) AS BIAS_SUM,
            SUM(a.ACTUAL_UNITS * ${factor}) AS ACTUAL_SUM,
            AVG(IFF(a.BEAT_BASELINE, 1, 0)) AS BEAT_RATE
     FROM APP.V_CONSENSUS_ACCURACY a
     JOIN APP.V_SERIES s
       ON s.SERIES_ID = a.SERIES_ID
     WHERE ${where.sql}
     GROUP BY a.STREAM_ID, a.STREAM_LABEL, a.IS_TARGET
     ORDER BY MIN(CASE a.STREAM_ID
       WHEN 'sales' THEN 10
       WHEN 'marketing' THEN 20
       WHEN 'finance' THEN 30
       WHEN 'planner' THEN 40
       ELSE 999 END)`,
    where.binds,
  );
}

async function loadStreamLeafRows(params: {
  streamId: string;
  cycleWeek: string;
  nodePath: NodePath;
  weekFrom: string;
  weekTo: string;
}) {
  const path = buildPathClause(params.nodePath);
  return query<StreamLeafRow>(
    `SELECT p.SERIES_ID,
            p.WEEK_ID,
            s.SERIES_LABEL,
            s.CATEGORY_NAME,
            s.PRODUCT_NAME,
            s.CUSTOMER_NAME,
            s.CHANNEL_NAME,
            s.PRODUCT_LINE,
            s.PRICE_TIER,
            s.REGION,
            s.ROUTE_TO_CUSTOMER,
            s.DELIVERY_MODE,
            s.CHANNEL_GROUP,
            p.STAT_UNITS AS BASE_UNITS,
            COALESCE(i.INPUT_UNITS, p.STAT_UNITS) AS CURRENT_UNITS,
            p.STAT_UNITS,
            p.UNIT_PRICE_EUR
     FROM APP.V_PLAN_CONTRIBUTION p
     JOIN APP.V_SERIES s
       ON s.SERIES_ID = p.SERIES_ID
     LEFT JOIN CORE.FACT_PLAN_INPUT i
       ON i.CYCLE_WEEK = ?
      AND i.STREAM_ID = ?
      AND i.SERIES_ID = p.SERIES_ID
      AND i.WEEK_ID = p.WEEK_ID
     WHERE p.WEEK_ID BETWEEN ? AND ?${path.clause}
     ORDER BY s.CATEGORY_NAME, s.PRODUCT_NAME, s.CUSTOMER_NAME, s.CHANNEL_NAME, s.SERIES_LABEL, p.WEEK_ID`,
    [params.cycleWeek, params.streamId, params.weekFrom, params.weekTo, ...path.binds],
  );
}

function parseStreams(raw: string | null, available: string[]) {
  if (!raw || raw.trim().length === 0) {
    return available;
  }
  const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (requested.length === 0) return available;
  const valid = new Set(available);
  const invalid = requested.filter((value) => !valid.has(value));
  if (invalid.length > 0) {
    return { error: `Unknown stream id: ${invalid.join(", ")}.` } as const;
  }
  return Array.from(new Set(requested));
}

function parseScenarioIds(raw: string | null) {
  if (!raw || raw.trim().length === 0) return [];
  const ids = Array.from(new Set(raw.split(",").map((value) => value.trim()).filter(Boolean)));
  if (ids.length > 3) {
    return { error: "A maximum of 3 scenarioIds is allowed so the overlay stays readable." } as const;
  }
  const invalid = ids.filter((value) => !isScenarioId(value));
  if (invalid.length > 0) {
    return { error: `Invalid scenario id: ${invalid.join(", ")}.` } as const;
  }
  return ids;
}

function parsePreviewBody(body: unknown, rollups: Rollups = {}): PreviewRequest | { message: string; status: number } {
  const order = drillOrder(rollups);
  if (!body || typeof body !== "object") {
    return { message: "A request body is required.", status: 400 };
  }
  const record = body as Record<string, unknown>;
  const streamId = typeof record.stream === "string" ? record.stream.trim() : "";
  if (!streamId) {
    return { message: "stream is required.", status: 400 };
  }

  const node = (record.node ?? {}) as Record<string, unknown>;
  const level = parseLevel(typeof node.level === "string" ? node.level : null, order);
  if (!level) {
    return { message: "node.level is invalid.", status: 400 };
  }
  const nodeKey = typeof node.key === "string" ? node.key : "";
  const nodePath = parsePlanNodeKey(level, nodeKey, order);
  if (!nodePath) {
    // A key that skips a level is refused here, before any row is read, with
    // the same explanation the page shows next to its disabled form.
    return { message: skippedLevelReason(nodeKey, rollups) ?? "node.key is invalid for the selected level.", status: 400 };
  }

  const weekRange = (record.weekRange ?? {}) as Record<string, unknown>;
  const weekFrom = typeof weekRange.from === "string" ? weekRange.from : null;
  const weekTo = typeof weekRange.to === "string" ? weekRange.to : null;
  if (!isWeekId(weekFrom) || !isWeekId(weekTo)) {
    return { message: "weekRange.from and weekRange.to must be valid planning weeks.", status: 400 };
  }
  if (weekFrom > weekTo) {
    return { message: "weekRange.from must be earlier than or equal to weekRange.to.", status: 400 };
  }

  const target = (record.target ?? {}) as Record<string, unknown>;
  const targetMode = target.mode === "absolute" ? "absolute" : target.mode === "percentage" ? "percentage" : null;
  if (!targetMode) {
    return { message: "target.mode must be 'absolute' or 'percentage'.", status: 400 };
  }
  const targetValue = typeof target.value === "number" ? target.value : Number(target.value);
  if (!Number.isFinite(targetValue)) {
    return { message: "target.value must be numeric.", status: 400 };
  }
  if (targetMode === "absolute" && targetValue < 0) {
    return { message: "Absolute targets cannot be negative.", status: 400 };
  }

  const disaggMethod = record.disaggMethod === "statistical" || record.disaggMethod === "current_plan"
    ? record.disaggMethod
    : null;
  if (!disaggMethod) {
    return { message: "disaggMethod must be 'statistical' or 'current_plan'.", status: 400 };
  }

  return {
    streamId,
    level,
    nodeKey,
    nodePath,
    weekFrom,
    weekTo,
    targetMode,
    targetValue,
    disaggMethod,
    order,
  };
}

async function parseCommitBody(body: unknown, rollups: Rollups = {}): Promise<CommitRequest | { message: string; status: number }> {
  const preview = parsePreviewBody(body, rollups);
  if ("message" in preview) return preview;

  const record = body as Record<string, unknown>;
  if (record.confirm !== true) {
    return { message: "Set confirm=true to commit this input.", status: 409 };
  }

  const reasonCode = typeof record.reasonCode === "string" ? record.reasonCode : null;
  if (!reasonCode) {
    return { message: "reasonCode is required.", status: 400 };
  }
  const reason = await getReason(reasonCode);
  if (!reason) {
    return { message: "Unknown reason code.", status: 400 };
  }
  const note = normaliseOptionalText(record.note, MAX_NOTE_LENGTH);
  if (reason.REQUIRES_NOTE && !note) {
    return { message: `Reason '${reasonCode}' requires a note.`, status: 400 };
  }

  return {
    ...preview,
    reasonCode,
    note,
  };
}

async function buildPreview(previewRequest: PreviewRequest, cycleWeek: string) {
  const rows = await loadStreamLeafRows({
    streamId: previewRequest.streamId,
    cycleWeek,
    nodePath: previewRequest.nodePath,
    weekFrom: previewRequest.weekFrom,
    weekTo: previewRequest.weekTo,
  });
  if (rows.length === 0) {
    throw new Error("No forward rows match that hierarchy selection.");
  }

  const parentCurrent = sum(rows.map((row) => Number(row.CURRENT_UNITS) || 0));
  const targetUnits = previewRequest.targetMode === "absolute"
    ? round2(previewRequest.targetValue)
    : round2(parentCurrent * (1 + previewRequest.targetValue));
  if (targetUnits < 0) {
    throw new Error("This target would drive the stream below zero.");
  }

  const outcome = previewRequest.targetMode === "absolute"
    ? disaggregate(
        targetUnits,
        rows.map((row) => ({
          id: `${row.SERIES_ID}:${row.WEEK_ID}`,
          currentUnits: Number(row.CURRENT_UNITS) || 0,
          statUnits: Number(row.STAT_UNITS) || 0,
          locked: false,
        })),
        previewRequest.disaggMethod,
      )
    : disaggregateByPercent(
        previewRequest.targetValue,
        rows.map((row) => ({
          id: `${row.SERIES_ID}:${row.WEEK_ID}`,
          currentUnits: Number(row.CURRENT_UNITS) || 0,
          statUnits: Number(row.STAT_UNITS) || 0,
          locked: false,
        })),
        previewRequest.disaggMethod,
      );

  const byLeafId = new Map(outcome.children.map((child) => [child.id, child]));
  const childGroups = new Map<string, {
    childLabel: string;
    childLevel: HierarchyLevel | "WEEK_ID";
    nodeKey: string;
    rows: StreamLeafRow[];
  }>();

  for (const row of rows) {
    const child = immediateChildMeta(row, previewRequest.level, previewRequest.nodePath, previewRequest.order);
    const slot = childGroups.get(child.childId) ?? {
      childLabel: child.childLabel,
      childLevel: child.childLevel,
      nodeKey: child.nodeKey,
      rows: [],
    };
    slot.rows.push(row);
    childGroups.set(child.childId, slot);
  }

  const children = Array.from(childGroups.entries())
    .map(([childId, group]) => {
      const descendants = group.rows.map((row) => byLeafId.get(`${row.SERIES_ID}:${row.WEEK_ID}`)!);
      const currentUnits = sum(descendants.map((child) => child.currentUnits));
      const proposedUnits = sum(descendants.map((child) => child.newUnits));
      const deltaUnits = round2(proposedUnits - currentUnits);
      return {
        childId,
        childLabel: group.childLabel,
        childLevel: group.childLevel,
        nodeKey: group.nodeKey,
        currentUnits,
        proposedUnits,
        deltaUnits,
        deltaValueEur: round2(group.rows.reduce((total, row) => {
          const leaf = byLeafId.get(`${row.SERIES_ID}:${row.WEEK_ID}`)!;
          return total + leaf.deltaUnits * (Number(row.UNIT_PRICE_EUR) || 0);
        }, 0)),
        shareOfChange: Math.abs(outcome.appliedDelta) > 0 ? round2(deltaUnits / outcome.appliedDelta) : null,
        movedLeafCount: descendants.filter((child) => !same2(child.deltaUnits, 0)).length,
        excluded: descendants.every((child) => child.excluded),
        clamped: descendants.some((child) => child.clamped),
      };
    })
    .sort((left, right) => Math.abs(right.deltaValueEur) - Math.abs(left.deltaValueEur));

  return {
    streamId: previewRequest.streamId,
    node: {
      level: previewRequest.level,
      label: nodeLabel(previewRequest.level, previewRequest.nodePath),
      key: previewRequest.nodeKey,
      currentUnits: parentCurrent,
      targetUnits,
      weekFrom: previewRequest.weekFrom,
      weekTo: previewRequest.weekTo,
    },
    method: previewRequest.disaggMethod,
    target: {
      mode: previewRequest.targetMode,
      value: previewRequest.targetValue,
    },
    children,
    outcome: {
      feasible: outcome.feasible,
      shortfall: round2(outcome.shortfall),
      targetDelta: round2(outcome.targetDelta),
      appliedDelta: round2(outcome.appliedDelta),
      movedCount: children.filter((child) => !same2(child.deltaUnits, 0)).length,
      excludedCount: children.filter((child) => child.excluded).length,
      clampedCount: children.filter((child) => child.clamped).length,
    },
    leaves: rows.map((row) => {
      const child = byLeafId.get(`${row.SERIES_ID}:${row.WEEK_ID}`)!;
      return {
        seriesId: row.SERIES_ID,
        weekId: row.WEEK_ID,
        baseUnits: round2(Number(row.BASE_UNITS) || 0),
        currentUnits: round2(Number(row.CURRENT_UNITS) || 0),
        proposedUnits: round2(child.newUnits),
        deltaUnits: round2(child.newUnits - (Number(row.BASE_UNITS) || 0)),
      };
    }),
  };
}

/**
 * Sales, marketing and finance inputs are STAGED, not written: they go to
 * CORE.FACT_PLAN_INPUT_PENDING under one approval request, and reach
 * FACT_PLAN_INPUT (and so V_PLAN_CONTRIBUTION) only when the demand lead
 * accepts them. The planner stream is the demand lead's own reconciliation,
 * so it is written directly, and only by the demand lead.
 */
async function stageSubmission(
  commitRequest: CommitRequest,
  preview: Awaited<ReturnType<typeof buildPreview>>,
  cycleWeek: string,
) {
  const persona = await getPersona();
  const requestId = crypto.randomUUID();
  const editGroupId = crypto.randomUUID();
  const rows = preview.leaves;
  if (rows.length === 0) throw new ApprovalError("This submission changes nothing.", 400);

  const selects = rows
    .map(
      () => `SELECT ? AS REQUEST_ID, ? AS CYCLE_WEEK, ? AS STREAM_ID, ? AS SERIES_ID, ? AS WEEK_ID,
                    ? AS BASE_UNITS, ? AS INPUT_UNITS, ? AS DELTA_UNITS, ? AS NODE_LEVEL,
                    ? AS NODE_KEY, ? AS DISAGG_METHOD, ? AS EDIT_GROUP_ID, ? AS REASON_CODE,
                    ? AS NOTE, ? AS SUBMITTED_BY, ? AS IS_DELETE`,
    )
    .join(" UNION ALL ");
  const binds = rows.flatMap((row) => [
    requestId,
    cycleWeek,
    commitRequest.streamId,
    row.seriesId,
    row.weekId,
    row.baseUnits,
    row.proposedUnits,
    round2(row.proposedUnits - row.baseUnits),
    commitRequest.level,
    commitRequest.nodeKey,
    commitRequest.disaggMethod,
    editGroupId,
    commitRequest.reasonCode,
    commitRequest.note,
    persona.displayName,
    same2(row.proposedUnits, row.baseUnits),
  ]);
  await query(
    `INSERT INTO CORE.FACT_PLAN_INPUT_PENDING (
       REQUEST_ID, CYCLE_WEEK, STREAM_ID, SERIES_ID, WEEK_ID, BASE_UNITS, INPUT_UNITS,
       DELTA_UNITS, NODE_LEVEL, NODE_KEY, DISAGG_METHOD, EDIT_GROUP_ID, REASON_CODE,
       NOTE, SUBMITTED_BY, IS_DELETE
     ) ${selects}`,
    binds,
  );

  const moved = rows.filter((row) => !same2(row.proposedUnits, row.baseUnits));
  try {
    await submitApproval({
      objectType: "stream_submission",
      objectId: requestId,
      requestId,
      streamId: commitRequest.streamId,
      title: `${commitRequest.streamId} input on ${preview.node.label}, ${preview.node.weekFrom} to ${preview.node.weekTo}`,
      summary: {
        streamId: commitRequest.streamId,
        node: preview.node.label,
        weekFrom: preview.node.weekFrom,
        weekTo: preview.node.weekTo,
        currentUnits: preview.node.currentUnits,
        targetUnits: preview.node.targetUnits,
        appliedDeltaUnits: preview.outcome.appliedDelta,
        cellsMoved: moved.length,
        reasonCode: commitRequest.reasonCode,
      },
      note: commitRequest.note,
      persona,
    });
  } catch (err) {
    // Nothing is left half-submitted: staged rows without a request are removed.
    await query(`DELETE FROM CORE.FACT_PLAN_INPUT_PENDING WHERE REQUEST_ID = ?`, [requestId]);
    throw err;
  }

  return {
    cycleWeek,
    streamId: commitRequest.streamId,
    editGroupId,
    requestId,
    status: "submitted" as const,
    stagedRows: rows.length,
    mergedRows: 0,
    deletedRows: 0,
    nodeLevel: commitRequest.level,
    nodeKey: commitRequest.nodeKey,
    submittedBy: persona.displayName,
  };
}

async function commitPreview(commitRequest: CommitRequest, preview: Awaited<ReturnType<typeof buildPreview>>, cycleWeek: string) {
  if (commitRequest.streamId !== "planner") {
    return stageSubmission(commitRequest, preview, cycleWeek);
  }
  const persona = await getPersona();
  if (persona.roleId !== "demand_lead") {
    throw new ApprovalError("Only the demand planning lead writes the planner reconciliation.", 403);
  }
  // Written without an approval, so the cycle lock must be checked here.
  const cycle = await query<{ STATUS: string }>(
    `SELECT STATUS FROM CORE.DIM_PLAN_CYCLE WHERE CYCLE_WEEK = ?`,
    [cycleWeek],
  );
  if (cycle[0] && cycle[0].STATUS !== "open") {
    throw new ApprovalError(`The ${cycleWeek} cycle is ${cycle[0].STATUS.replace("_", " ")}. The reconciliation is frozen until the next cycle opens.`, 409);
  }
  const actor = await getActor();
  const editGroupId = crypto.randomUUID();

  const rowsToDelete = preview.leaves.filter((leaf) => same2(leaf.proposedUnits, leaf.baseUnits));
  const rowsToMerge = preview.leaves.filter((leaf) => !same2(leaf.proposedUnits, leaf.baseUnits));

  if (rowsToDelete.length > 0) {
    const tupleList = rowsToDelete.map(() => "(?, ?)").join(", ");
    const binds = rowsToDelete.flatMap((row) => [row.seriesId, row.weekId]);
    await query(
      `DELETE FROM CORE.FACT_PLAN_INPUT
       WHERE CYCLE_WEEK = ?
         AND STREAM_ID = ?
         AND (SERIES_ID, WEEK_ID) IN (${tupleList})`,
      [cycleWeek, commitRequest.streamId, ...binds],
    );
  }

  if (rowsToMerge.length > 0) {
    const selects = rowsToMerge
      .map(
        () => `SELECT ? AS CYCLE_WEEK, ? AS STREAM_ID, ? AS SERIES_ID, ? AS WEEK_ID,
                      ? AS BASE_UNITS, ? AS INPUT_UNITS, ? AS DELTA_UNITS,
                      ? AS NODE_LEVEL, ? AS NODE_KEY, ? AS DISAGG_METHOD,
                      ? AS EDIT_GROUP_ID, ? AS REASON_CODE, ? AS NOTE, ? AS SUBMITTED_BY`,
      )
      .join(" UNION ALL ");

    const binds = rowsToMerge.flatMap((row) => [
      cycleWeek,
      commitRequest.streamId,
      row.seriesId,
      row.weekId,
      row.baseUnits,
      row.proposedUnits,
      round2(row.proposedUnits - row.baseUnits),
      commitRequest.level,
      commitRequest.nodeKey,
      commitRequest.disaggMethod,
      editGroupId,
      commitRequest.reasonCode,
      commitRequest.note,
      actor,
    ]);

    await query(
      `MERGE INTO CORE.FACT_PLAN_INPUT AS target
       USING (${selects}) AS source
       ON target.CYCLE_WEEK = source.CYCLE_WEEK
          AND target.STREAM_ID = source.STREAM_ID
          AND target.SERIES_ID = source.SERIES_ID
          AND target.WEEK_ID = source.WEEK_ID
       WHEN MATCHED THEN UPDATE SET
         BASE_UNITS = source.BASE_UNITS,
         INPUT_UNITS = source.INPUT_UNITS,
         DELTA_UNITS = source.DELTA_UNITS,
         NODE_LEVEL = source.NODE_LEVEL,
         NODE_KEY = source.NODE_KEY,
         DISAGG_METHOD = source.DISAGG_METHOD,
         EDIT_GROUP_ID = source.EDIT_GROUP_ID,
         REASON_CODE = source.REASON_CODE,
         NOTE = source.NOTE,
         SUBMITTED_BY = source.SUBMITTED_BY,
         SUBMITTED_AT = CURRENT_TIMESTAMP()
       WHEN NOT MATCHED THEN INSERT (
         CYCLE_WEEK, STREAM_ID, SERIES_ID, WEEK_ID,
         BASE_UNITS, INPUT_UNITS, DELTA_UNITS,
         NODE_LEVEL, NODE_KEY, DISAGG_METHOD,
         EDIT_GROUP_ID, REASON_CODE, NOTE, SUBMITTED_BY, SUBMITTED_AT
       ) VALUES (
         source.CYCLE_WEEK, source.STREAM_ID, source.SERIES_ID, source.WEEK_ID,
         source.BASE_UNITS, source.INPUT_UNITS, source.DELTA_UNITS,
         source.NODE_LEVEL, source.NODE_KEY, source.DISAGG_METHOD,
         source.EDIT_GROUP_ID, source.REASON_CODE, source.NOTE, source.SUBMITTED_BY, CURRENT_TIMESTAMP()
       )`,
      binds,
    );
  }

  return {
    cycleWeek,
    streamId: commitRequest.streamId,
    editGroupId,
    mergedRows: rowsToMerge.length,
    deletedRows: rowsToDelete.length,
    nodeLevel: commitRequest.level,
    nodeKey: commitRequest.nodeKey,
    submittedBy: actor,
  };
}

export async function GET(request: NextRequest) {
  try {
    const path = parseHierarchyPath(request.nextUrl.searchParams);
    const weeksBack = parsePositiveInt(request.nextUrl.searchParams.get("weeksBack"), 26, 4, 104);
    const weeksForward = parsePositiveInt(request.nextUrl.searchParams.get("weeksForward"), 20, 4, 28);
    const measureParam = request.nextUrl.searchParams.get("measure");
    const measure: Measure = measureParam === null || measureParam === "units"
      ? "units"
      : measureParam === "revenue"
        ? "revenue"
        : (() => {
            throw new Error("measure must be 'units' or 'revenue'.");
          })();

    // The integrity sweep is only run when explicitly asked for.
    //
    // V_DATA_INTEGRITY runs ten assertions, one of which scans 1.3m driver rows,
    // and it costs about 2.9s of a 5s response. It powers a warning banner, so
    // it is worth having — but re-running it on every filter change, timeline
    // adjustment and units toggle made the whole view feel broken. The page asks
    // for it once on mount and keeps the result.
    const wantIntegrity = request.nextUrl.searchParams.get("includeIntegrity") === "1";

    const [context, integrity, streamRows, reasons, scenarioRows] = await Promise.all([
      getContext(),
      wantIntegrity ? getIntegrity() : Promise.resolve([]),
      loadStreamMetadata(),
      loadReasons(),
      loadScenarios(),
    ]);

    const streamIds = [...streamRows.map((row) => row.STREAM_ID), "agent"];
    const streams = parseStreams(request.nextUrl.searchParams.get("streams"), streamIds);
    if ("error" in streams) {
      return badRequest(streams.error);
    }

    const scenarioIds = parseScenarioIds(request.nextUrl.searchParams.get("scenarioIds"));
    if ("error" in scenarioIds) {
      return badRequest(scenarioIds.error);
    }

    const weekRows = await loadWeekWindow(context.HISTORY_END_WEEK, weeksBack, weeksForward);
    if (weekRows.length === 0) {
      return badRequest("No weeks found for the requested window.", 404);
    }

    const fromWeek = weekRows[0]?.WEEK_ID ?? context.HISTORY_END_WEEK;
    const toWeek = weekRows.at(-1)?.WEEK_ID ?? context.HISTORY_END_WEEK;
    const forecastFromWeek = context.CURRENT_WEEK;
    // V_SERIES, not V_PLAN_CONTRIBUTION: the two hold the same 726 series and
    // the same level values, but a DISTINCT through the contribution view spends
    // over a second compiling it, four times per request, for an identical list.
    const optionsPromise = loadHierarchyOptions("APP.V_SERIES", path);

    const [actualRows, contributionRows, scenarioOverlayRows, accuracyRows, hierarchyOptions] = await Promise.all([
      loadActuals(path, fromWeek, context.HISTORY_END_WEEK, measure),
      loadContributionSeries(path, forecastFromWeek, toWeek, measure),
      loadScenarioOverlay(path, scenarioIds, forecastFromWeek, toWeek, measure),
      loadAccuracy(path, measure),
      optionsPromise,
    ]);

    const actualByWeek = new Map(actualRows.map((row) => [row.WEEK_ID, Number(row.ACTUAL_VALUE) || 0]));
    const contributionByWeek = new Map(contributionRows.map((row) => [row.WEEK_ID, {
      plan: Number(row.PLAN_VALUE) || 0,
      baseline: Number(row.BASELINE_VALUE) || 0,
      event: Number(row.EVENT_VALUE) || 0,
      promotion: Number(row.PROMOTION_VALUE) || 0,
      sales: Number(row.SALES_VALUE) || 0,
      marketing: Number(row.MARKETING_VALUE) || 0,
      finance: Number(row.FINANCE_VALUE) || 0,
      planner: Number(row.PLANNER_VALUE) || 0,
      agent: Number(row.AGENT_VALUE) || 0,
    }]));

    const scenariosById = new Map<string, {
      scenarioId: string;
      scenarioName: string;
      status: string;
      weeks: Record<string, number>;
    }>();
    for (const row of scenarioOverlayRows) {
      const slot = scenariosById.get(row.SCENARIO_ID) ?? {
        scenarioId: row.SCENARIO_ID,
        scenarioName: row.SCENARIO_NAME,
        status: row.STATUS,
        weeks: {},
      };
      slot.weeks[row.WEEK_ID] = Number(row.SCENARIO_VALUE) || 0;
      scenariosById.set(row.SCENARIO_ID, slot);
    }

    const weekly = weekRows.map((week) => {
      const contribution = contributionByWeek.get(week.WEEK_ID);
      const overlay: Record<string, number | null> = {};
      for (const [scenarioId, scenario] of scenariosById.entries()) {
        overlay[scenarioId] = scenario.weeks[week.WEEK_ID] ?? null;
      }
      return {
        weekId: week.WEEK_ID,
        weekStartDate: week.WEEK_START_DATE,
        actual: actualByWeek.get(week.WEEK_ID) ?? null,
        plan: contribution?.plan ?? null,
        baseline: contribution?.baseline ?? null,
        event: contribution?.event ?? null,
        promotion: contribution?.promotion ?? null,
        sales: contribution?.sales ?? null,
        marketing: contribution?.marketing ?? null,
        finance: contribution?.finance ?? null,
        planner: contribution?.planner ?? null,
        agent: contribution?.agent ?? null,
        scenarios: overlay,
      };
    });

    const forecastWeeks = weekly.filter((row) => row.plan !== null);
    const planTotal = sum(forecastWeeks.map((row) => row.plan ?? 0));
    const baselineTotal = sum(forecastWeeks.map((row) => row.baseline ?? 0));

    // A scope with no forward plan (a product in a customer it does not sell in) has
    // no weeks to compare, and `IN ()` is a syntax error, so skip the query.
    const lastYearWhere = hierarchyPredicate(path, "s");
    const lastYearIsoWeeks = forecastWeeks.length === 0 ? [] : await query<{ LY_VALUE: number }>(
      `WITH target_weeks AS (
         SELECT ISO_WEEK
         FROM CORE.DIM_WEEK
         WHERE WEEK_ID IN (${forecastWeeks.map(() => "?").join(", ")})
       )
       SELECT SUM(${measure === "revenue" ? "a.POS_REVENUE_EUR" : "a.POS_UNITS"}) AS LY_VALUE
       FROM APP.V_ACTUALS_WEEKLY a
       JOIN CORE.DIM_WEEK w
         ON w.WEEK_ID = a.WEEK_ID
       JOIN APP.V_SERIES s
         ON s.SERIES_ID = a.SERIES_ID
       JOIN target_weeks tw
         ON tw.ISO_WEEK = w.ISO_WEEK
       WHERE w.ISO_YEAR = (
         SELECT ISO_YEAR - 1
         FROM CORE.DIM_WEEK
         WHERE WEEK_ID = ?
       )
         AND ${lastYearWhere.sql}`,
      [
        ...forecastWeeks.map((row) => row.weekId),
        context.HISTORY_END_WEEK,
        ...lastYearWhere.binds,
      ],
    );

    const lastYearTotal = Number(lastYearIsoWeeks[0]?.LY_VALUE) || 0;

    const componentSummary = [
      {
        ...COMPONENT_META.event,
        value: sum(forecastWeeks.map((row) => row.event ?? 0)),
      },
      {
        ...COMPONENT_META.promotion,
        value: sum(forecastWeeks.map((row) => row.promotion ?? 0)),
      },
      ...STREAM_COMPONENT_ORDER.map((streamId) => {
        const source = streamRows.find((row) => row.STREAM_ID === streamId);
        const value = sum(forecastWeeks.map((row) => row[streamId] ?? 0));
        return {
          key: streamId,
          label: source?.STREAM_LABEL ?? streamId,
          description: source?.DESCRIPTION ?? null,
          colourToken: source?.COLOUR_TOKEN ?? (streamId === "agent" ? "chart-6" : "accent"),
          isTarget: source?.IS_TARGET ?? false,
          ownerRole: source?.OWNER_ROLE ?? null,
          value,
        };
      }),
    ].map((item) => ({
      ...item,
      pctOfBaseline: baselineTotal !== 0 ? round2(item.value / baselineTotal) : null,
      active: streams.includes(item.key),
    }));

    const overlaySummary = Array.from(scenariosById.values()).map((scenario) => {
      const total = sum(forecastWeeks.map((week) => scenario.weeks[week.weekId] ?? 0));
      const delta = round2(total - planTotal);
      return {
        scenarioId: scenario.scenarioId,
        scenarioName: scenario.scenarioName,
        status: scenario.status,
        total,
        delta,
        deltaPct: planTotal !== 0 ? round2(delta / planTotal) : null,
      };
    });

    return NextResponse.json({
      context,
      integrity,
      filters: {
        path,
        weeksBack,
        weeksForward,
        measure,
        streams,
        scenarioIds,
      },
      selection: selectionFromPath(path),
      todayWeek: context.HISTORY_END_WEEK,
      weekly,
      kpis: {
        planTotal,
        lastYearTotal,
        vsLastYear: round2(planTotal - lastYearTotal),
        vsLastYearPct: lastYearTotal !== 0 ? round2(planTotal / lastYearTotal - 1) : null,
        components: componentSummary,
      },
      options: {
        hierarchy: hierarchyOptions,
      },
      streams: streamRows.map((row) => ({
        streamId: row.STREAM_ID,
        streamLabel: row.STREAM_LABEL,
        description: row.DESCRIPTION,
        sequenceNo: Number(row.SEQUENCE_NO) || 0,
        colourToken: row.COLOUR_TOKEN,
        isTarget: row.IS_TARGET,
        ownerRole: row.OWNER_ROLE,
      })),
      scenarios: {
        available: scenarioRows.map((row) => ({
          scenarioId: row.SCENARIO_ID,
          scenarioName: row.SCENARIO_NAME,
          status: row.STATUS,
          basePlanWeek: row.BASE_PLAN_WEEK,
          deltaUnits: Number(row.DELTA_UNITS) || 0,
          deltaValueEur: Number(row.DELTA_VALUE_EUR) || 0,
          updatedAt: row.UPDATED_AT,
          createdAt: row.CREATED_AT,
        })),
        overlays: overlaySummary,
      },
      accuracy: accuracyRows.map((row) => {
        const actualTotal = Number(row.ACTUAL_SUM) || 0;
        return {
          streamId: row.STREAM_ID,
          streamLabel: row.STREAM_LABEL,
          isTarget: row.IS_TARGET,
          rowsScored: Number(row.ROWS_SCORED) || 0,
          wape: actualTotal !== 0 ? round2((Number(row.STREAM_ABS_ERROR_SUM) || 0) / actualTotal) : null,
          baselineWape: actualTotal !== 0 ? round2((Number(row.BASELINE_ABS_ERROR_SUM) || 0) / actualTotal) : null,
          bias: actualTotal !== 0 ? round2((Number(row.BIAS_SUM) || 0) / actualTotal) : null,
          beatBaselinePct: row.BEAT_RATE === null || row.BEAT_RATE === undefined ? null : round2(Number(row.BEAT_RATE)),
        };
      }),
      reasons,
      notes: {
        derivedComponents: ["event", "promotion"],
      },
    });
  } catch (err) {
    console.error("plan-view route failed:", err);
    const message = (err as Error).message ?? "Failed to load consensus plan view";
    const status = message.startsWith("measure must") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    // ROLLUP_* query params name the drill order the node key was built in.
    const rollups = rollupsOf(parseHierarchyPath(request.nextUrl.searchParams));
    const previewRequest = parsePreviewBody(body, rollups);
    if ("message" in previewRequest) {
      return badRequest(previewRequest.message, previewRequest.status);
    }

    const context = await getContext();
    const streamMetadata = await loadStreamMetadata();
    if (!streamMetadata.some((row) => row.STREAM_ID === previewRequest.streamId)) {
      return badRequest("Unknown stream.");
    }
    if (previewRequest.weekFrom < context.CURRENT_WEEK || previewRequest.weekTo > context.HORIZON_END_WEEK) {
      return badRequest(`weekRange must stay within the live horizon ${context.CURRENT_WEEK} to ${context.HORIZON_END_WEEK}.`);
    }

    const preview = await buildPreview(previewRequest, context.HISTORY_END_WEEK);
    const raw = body as Record<string, unknown>;
    if (raw.confirm !== true) {
      return NextResponse.json({ ok: true, action: "preview", preview });
    }

    const commitRequest = await parseCommitBody(body, rollups);
    if ("message" in commitRequest) {
      return badRequest(commitRequest.message, commitRequest.status);
    }
    if (!preview.outcome.feasible) {
      return badRequest(
        `Preview is infeasible. Shortfall ${preview.outcome.shortfall.toFixed(2)} units remains after zero floors.`,
        409,
      );
    }

    const commit = await commitPreview(commitRequest, preview, context.HISTORY_END_WEEK);
    return NextResponse.json({ ok: true, action: "commit", preview, commit });
  } catch (err) {
    if (err instanceof ApprovalError) {
      return NextResponse.json({ error: err.message, detail: err.detail ?? null }, { status: err.status });
    }
    console.error("plan-view submit failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to submit plan input" },
      { status: 500 },
    );
  }
}