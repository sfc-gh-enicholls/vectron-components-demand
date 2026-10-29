import { disaggregate, disaggregateByPercent, type DisaggMethod } from "@/lib/disaggregate";
import { getContext, getIntegrity } from "@/lib/data";
import {
  ALT_LEVELS,
  BASE_LEVELS,
  LEVEL_LABELS,
  levelOrder,
  type PathLevel,
  type Rollups,
} from "@/lib/dimensions";
import { rollupsOf, type HierarchyPathServer } from "@/lib/hierarchy-path";
import { query } from "@/lib/snowflake";
import {
  MAX_NOTE_LENGTH,
  asDisaggMethod,
  getActor,
  getReason,
  getScenarioSummary,
  isScenarioId,
  isWeekId,
  normaliseOptionalText,
  round2,
  same2,
} from "../scenarios/shared";

export const dynamic = "force-dynamic";

export const LEVELS = {
  CATEGORY_NAME: "Category",
  PRODUCT_NAME: "Product",
  CUSTOMER_NAME: "Customer",
  CHANNEL_NAME: "Channel",
  SERIES_ID: "Series",
} as const;

/**
 * A node level: any path level (base or alternate-tree) or the series.
 *
 * WHY THE DRILL ORDER IS A PARAMETER
 * ----------------------------------
 * The order used to be the fixed CATEGORY > PRODUCT > CUSTOMER > CHANNEL > SERIES.
 * With roll-ups it is the chosen product, customer and channel trees' levels,
 * then SERIES_ID, then WEEK_ID (`drillOrder`). Every function that walks the
 * order takes it as an argument defaulting to the original, so a request with
 * no roll-up runs exactly the code path and produces exactly the keys it did.
 * An edit at an alternate node (Region = Europe) is still an edit on a set of
 * leaves, so preview and commit spread it by the same pro-rata logic.
 */
export type HierarchyLevel = PathLevel | "SERIES_ID";

/** Labels for every level, base levels first in their original order. */
export const LEVEL_NAMES: Record<HierarchyLevel, string> = { ...LEVELS, ...LEVEL_LABELS };

const DEFAULT_ORDER: HierarchyLevel[] = drillOrder();

/** Node levels in drill order for these roll-ups, ending at the series. */
export function drillOrder(rollups: Rollups = {}): HierarchyLevel[] {
  return [...levelOrder(rollups), "SERIES_ID"];
}

function nextLevel(level: HierarchyLevel, order: HierarchyLevel[]): HierarchyLevel | "WEEK_ID" {
  const index = order.indexOf(level);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : "WEEK_ID";
}

interface ReasonRow {
  REASON_CODE: string;
  REASON_LABEL: string;
  REASON_GROUP: string;
  REQUIRES_NOTE: boolean;
}

interface WeekRow {
  WEEK_ID: string;
}

export interface LeafRow {
  SERIES_ID: string;
  WEEK_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string | null;
  CUSTOMER_NAME: string | null;
  CHANNEL_NAME: string | null;
  CATEGORY_NAME: string | null;
  // Alternate-tree attributes, read so a roll-up can key nodes by them. Never
  // returned as-is: responses carry only the levels of the order in use.
  PRODUCT_LINE: string | null;
  PRICE_TIER: string | null;
  REGION: string | null;
  ROUTE_TO_CUSTOMER: string | null;
  DELIVERY_MODE: string | null;
  CHANNEL_GROUP: string | null;
  BASE_PLAN_UNITS: number;
  CURRENT_UNITS: number;
  STAT_UNITS: number;
  UNIT_PRICE_EUR: number;
  IS_LOCKED: boolean | null;
  EDIT_GROUP_ID: string | null;
  REASON_CODE: string | null;
  REASON_LABEL: string | null;
  NOTE: string | null;
  PARENT_LEVEL: string | null;
  PARENT_KEY: string | null;
  DISAGG_METHOD: string | null;
  EDITED_BY: string | null;
  EDITED_AT: string | null;
  // Provenance of any edit already sitting in this cell. Needed so a preview can
  // warn that committing will REPLACE an accepted agent recommendation: the edit
  // table is keyed on (scenario, series, week) and the latest write wins, so a
  // category-level edit silently absorbs an agent edit on an overlapping cell.
  ORIGIN: string | null;
  SOURCE_PROPOSAL_ID: string | null;
}

export type NodePath = Partial<Record<HierarchyLevel, string>>;

export interface EditGroupSummary {
  editGroupId: string;
  parentLevel: string | null;
  parentKey: string | null;
  disaggMethod: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  editedBy: string | null;
  editedAt: string | null;
  leafCount: number;
  deltaUnits: number;
  deltaValueEur: number;
}

export interface HierarchyChildRow {
  childId: string;
  childLabel: string;
  childLevel: HierarchyLevel | "WEEK_ID";
  nodeKey: string;
  committedUnits: number;
  scenarioUnits: number;
  statUnits: number;
  deltaUnits: number;
  committedValueEur: number;
  scenarioValueEur: number;
  deltaValueEur: number;
  seriesCount: number;
  lockedLeafCount: number;
  hasEdits: boolean;
  editGroups: EditGroupSummary[];
}

export interface HierarchyNodeRow extends HierarchyChildRow {
  path: NodePath;
  level: HierarchyLevel;
  childCount: number;
  children: HierarchyChildRow[];
}

export interface PreviewChildRow {
  childId: string;
  childLabel: string;
  childLevel: HierarchyLevel | "WEEK_ID";
  nodeKey: string;
  currentUnits: number;
  proposedUnits: number;
  deltaUnits: number;
  deltaValueEur: number;
  shareOfChange: number | null;
  locked: boolean;
  excluded: boolean;
  clamped: boolean;
  lockedLeafCount: number;
  movedLeafCount: number;
}

export interface PreviewRequest {
  scenarioId: string;
  level: HierarchyLevel;
  nodeKey: string;
  nodePath: NodePath;
  disaggMethod: DisaggMethod;
  weekFrom: string;
  weekTo: string;
  targetMode: "absolute" | "percentage";
  targetValue: number;
  lockedChildIds: Set<string>;
  /** Drill order the node key was built in; the original four levels by default. */
  order: HierarchyLevel[];
}

export interface PreviewResponse {
  scenarioId: string;
  scenarioName: string;
  node: {
    level: HierarchyLevel;
    label: string;
    key: string;
    currentUnits: number;
    targetUnits: number;
    weekFrom: string;
    weekTo: string;
  };
  method: DisaggMethod;
  target: {
    mode: "absolute" | "percentage";
    value: number;
  };
  children: PreviewChildRow[];
  outcome: {
    feasible: boolean;
    shortfall: number;
    targetDelta: number;
    appliedDelta: number;
    lockedCount: number;
    lockedLeafCount: number;
    movedCount: number;
    excludedCount: number;
    clampedCount: number;
    /** Cells carrying an accepted agent edit that this commit would replace. */
    agentEditsReplaced: number;
  };
  leaves: Array<{
    seriesId: string;
    weekId: string;
    baseUnits: number;
    currentUnits: number;
    proposedUnits: number;
    deltaUnits: number;
    isLocked: boolean;
  }>;
}

export interface CommitApplyRequest extends PreviewRequest {
  reasonCode: string;
  note: string | null;
}

function badRequest(message: string, status = 400) {
  return { message, status };
}

function labelValue(value: string | null | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? value : fallback;
}

function requiredLevels(level: HierarchyLevel, order: HierarchyLevel[] = DEFAULT_ORDER): HierarchyLevel[] {
  return order.slice(0, order.indexOf(level) + 1);
}

/** The level named, or the order's first level when none is; null when not in the order. */
export function parseLevel(level: string | null | undefined, order: HierarchyLevel[] = DEFAULT_ORDER): HierarchyLevel | null {
  if (!level) return order[0];
  return (order as string[]).includes(level) ? (level as HierarchyLevel) : null;
}

export function serialiseNodeKey(level: HierarchyLevel, path: NodePath, order: HierarchyLevel[] = DEFAULT_ORDER): string {
  const payload: NodePath = {};
  for (const pathLevel of requiredLevels(level, order)) {
    payload[pathLevel] = path[pathLevel];
  }
  return JSON.stringify(payload);
}

export function parseNodeKey(level: HierarchyLevel, value: unknown, order: HierarchyLevel[] = DEFAULT_ORDER): NodePath | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const allowed = new Set(requiredLevels(level, order));
    const out: NodePath = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (!allowed.has(key as HierarchyLevel) || typeof raw !== "string" || raw.trim().length === 0) {
        return null;
      }
      out[key as HierarchyLevel] = raw.trim();
    }
    for (const pathLevel of requiredLevels(level, order)) {
      if (!out[pathLevel]) return null;
    }
    return out;
  } catch {
    return null;
  }
}

/** Base levels, then alternate levels, then the series: the original bind order when no alternate is set. */
const WHERE_LEVELS: HierarchyLevel[] = [...BASE_LEVELS, ...ALT_LEVELS, "SERIES_ID"];

function buildWhereFromPath(path: NodePath): { clause: string; binds: string[] } {
  const parts: string[] = [];
  const binds: string[] = [];
  for (const level of WHERE_LEVELS) {
    const value = path[level];
    if (!value) continue;
    if (level === "SERIES_ID") {
      parts.push("p.SERIES_ID = ?");
    } else {
      parts.push(`s.${level} = ?`);
    }
    binds.push(value);
  }
  return {
    clause: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "",
    binds,
  };
}

export async function loadWeeks(): Promise<string[]> {
  const rows = await query<WeekRow>(
    `SELECT DISTINCT WEEK_ID
     FROM APP.V_PLAN_FORWARD
     ORDER BY WEEK_ID`,
  );
  return rows.map((row) => row.WEEK_ID);
}

export async function loadReasons(): Promise<ReasonRow[]> {
  return query<ReasonRow>(
    `SELECT REASON_CODE, REASON_LABEL, REASON_GROUP, REQUIRES_NOTE
     FROM CORE.DIM_REASON_CODE
     ORDER BY REASON_GROUP, REASON_LABEL`,
  );
}

export async function loadLeafRows(params: {
  path: NodePath;
  scenarioId?: string | null;
  weekFrom?: string;
  weekTo?: string;
}): Promise<LeafRow[]> {
  const { clause, binds } = buildWhereFromPath(params.path);
  const weekClause = params.weekFrom && params.weekTo
    ? " AND p.WEEK_ID BETWEEN ? AND ?"
    : "";
  const weekBinds = params.weekFrom && params.weekTo ? [params.weekFrom, params.weekTo] : [];

  if (params.scenarioId) {
    return query<LeafRow>(
      `SELECT
         p.SERIES_ID,
         p.WEEK_ID,
         s.SERIES_LABEL,
         s.PRODUCT_NAME,
         s.CUSTOMER_NAME,
         s.CHANNEL_NAME,
         s.CATEGORY_NAME,
         s.PRODUCT_LINE,
         s.PRICE_TIER,
         s.REGION,
         s.ROUTE_TO_CUSTOMER,
         s.DELIVERY_MODE,
         s.CHANNEL_GROUP,
         p.PLAN_UNITS AS BASE_PLAN_UNITS,
         COALESCE(e.EDIT_UNITS, p.PLAN_UNITS) AS CURRENT_UNITS,
         p.STAT_UNITS,
         p.UNIT_PRICE_EUR,
         p.IS_LOCKED,
         e.EDIT_GROUP_ID,
         e.REASON_CODE,
         r.REASON_LABEL,
         e.NOTE,
         e.PARENT_LEVEL,
         e.PARENT_KEY,
         e.DISAGG_METHOD,
         e.EDITED_BY,
         TO_VARCHAR(e.EDITED_AT) AS EDITED_AT,
         e.ORIGIN,
         e.SOURCE_PROPOSAL_ID
       FROM APP.V_PLAN_FORWARD p
       JOIN APP.V_SERIES s
         ON s.SERIES_ID = p.SERIES_ID
       LEFT JOIN CORE.FACT_SCENARIO_EDIT e
         ON e.SCENARIO_ID = ?
        AND e.SERIES_ID = p.SERIES_ID
        AND e.WEEK_ID = p.WEEK_ID
       LEFT JOIN CORE.DIM_REASON_CODE r
         ON r.REASON_CODE = e.REASON_CODE
       WHERE 1 = 1${weekClause}${clause}
       ORDER BY s.CATEGORY_NAME, s.PRODUCT_NAME, s.CUSTOMER_NAME, s.CHANNEL_NAME, s.SERIES_LABEL, p.WEEK_ID`,
      [params.scenarioId, ...weekBinds, ...binds],
    );
  }

  return query<LeafRow>(
    `SELECT
       p.SERIES_ID,
       p.WEEK_ID,
       s.SERIES_LABEL,
       s.PRODUCT_NAME,
       s.CUSTOMER_NAME,
       s.CHANNEL_NAME,
       s.CATEGORY_NAME,
       s.PRODUCT_LINE,
       s.PRICE_TIER,
       s.REGION,
       s.ROUTE_TO_CUSTOMER,
       s.DELIVERY_MODE,
       s.CHANNEL_GROUP,
       p.PLAN_UNITS AS BASE_PLAN_UNITS,
       p.PLAN_UNITS AS CURRENT_UNITS,
       p.STAT_UNITS,
       p.UNIT_PRICE_EUR,
       p.IS_LOCKED,
       NULL AS EDIT_GROUP_ID,
       NULL AS REASON_CODE,
       NULL AS REASON_LABEL,
       NULL AS NOTE,
       NULL AS PARENT_LEVEL,
       NULL AS PARENT_KEY,
       NULL AS DISAGG_METHOD,
       NULL AS EDITED_BY,
       NULL AS EDITED_AT,
       NULL AS ORIGIN,
       NULL AS SOURCE_PROPOSAL_ID
     FROM APP.V_PLAN_FORWARD p
     JOIN APP.V_SERIES s
       ON s.SERIES_ID = p.SERIES_ID
     WHERE 1 = 1${weekClause}${clause}
     ORDER BY s.CATEGORY_NAME, s.PRODUCT_NAME, s.CUSTOMER_NAME, s.CHANNEL_NAME, s.SERIES_LABEL, p.WEEK_ID`,
    [...weekBinds, ...binds],
  );
}

function pathForLevel(row: LeafRow, level: HierarchyLevel, order: HierarchyLevel[] = DEFAULT_ORDER): NodePath {
  const out: NodePath = {};
  for (const pathLevel of order) {
    out[pathLevel] = pathLevel === "SERIES_ID" ? row.SERIES_ID : labelValue(row[pathLevel], "Unassigned");
    if (pathLevel === level) return out;
  }
  return out;
}

function labelForLevel(row: LeafRow, level: HierarchyLevel, order: HierarchyLevel[] = DEFAULT_ORDER): string {
  if (level === "SERIES_ID") return row.SERIES_LABEL;
  return pathForLevel(row, level, order)[level] ?? "Unassigned";
}

function immediateChildMeta(row: LeafRow, level: HierarchyLevel, order: HierarchyLevel[] = DEFAULT_ORDER): {
  childId: string;
  childLabel: string;
  childLevel: HierarchyLevel | "WEEK_ID";
  childPathKey: string;
} {
  const childLevel = nextLevel(level, order);
  if (childLevel === "WEEK_ID") {
    return {
      childId: row.WEEK_ID,
      childLabel: row.WEEK_ID,
      childLevel,
      childPathKey: `${row.SERIES_ID}:${row.WEEK_ID}`,
    };
  }
  const childPath = pathForLevel(row, childLevel, order);
  return {
    childId: childLevel === "SERIES_ID" ? row.SERIES_ID : (childPath[childLevel] ?? "Unassigned"),
    childLabel: labelForLevel(row, childLevel, order),
    childLevel,
    childPathKey: serialiseNodeKey(childLevel, childPath, order),
  };
}

function summariseEditGroups(rows: LeafRow[]): EditGroupSummary[] {
  const groups = new Map<string, EditGroupSummary>();
  for (const row of rows) {
    if (!row.EDIT_GROUP_ID) continue;
    const editGroupId = row.EDIT_GROUP_ID;
    const current = groups.get(editGroupId) ?? {
      editGroupId,
      parentLevel: row.PARENT_LEVEL,
      parentKey: row.PARENT_KEY,
      disaggMethod: row.DISAGG_METHOD,
      reasonCode: row.REASON_CODE,
      reasonLabel: row.REASON_LABEL,
      editedBy: row.EDITED_BY,
      editedAt: row.EDITED_AT,
      leafCount: 0,
      deltaUnits: 0,
      deltaValueEur: 0,
    };
    current.leafCount += 1;
    current.deltaUnits += (Number(row.CURRENT_UNITS) || 0) - (Number(row.BASE_PLAN_UNITS) || 0);
    current.deltaValueEur += ((Number(row.CURRENT_UNITS) || 0) - (Number(row.BASE_PLAN_UNITS) || 0)) * (Number(row.UNIT_PRICE_EUR) || 0);
    if (!current.editedAt || (row.EDITED_AT && row.EDITED_AT > current.editedAt)) {
      current.editedAt = row.EDITED_AT;
      current.editedBy = row.EDITED_BY;
      current.reasonCode = row.REASON_CODE;
      current.reasonLabel = row.REASON_LABEL;
      current.parentLevel = row.PARENT_LEVEL;
      current.parentKey = row.PARENT_KEY;
      current.disaggMethod = row.DISAGG_METHOD;
    }
    groups.set(editGroupId, current);
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      deltaUnits: round2(group.deltaUnits),
      deltaValueEur: round2(group.deltaValueEur),
    }))
    .sort((left, right) => {
      if ((right.editedAt ?? "") !== (left.editedAt ?? "")) {
        return (right.editedAt ?? "").localeCompare(left.editedAt ?? "");
      }
      return Math.abs(right.deltaValueEur) - Math.abs(left.deltaValueEur);
    });
}

function buildAggregateRow(params: {
  level: HierarchyLevel;
  label: string;
  id: string;
  nodeKey: string;
  rows: LeafRow[];
}): HierarchyChildRow {
  const seriesCount = new Set(params.rows.map((row) => row.SERIES_ID)).size;
  const committedUnits = round2(params.rows.reduce((sum, row) => sum + (Number(row.BASE_PLAN_UNITS) || 0), 0));
  const scenarioUnits = round2(params.rows.reduce((sum, row) => sum + (Number(row.CURRENT_UNITS) || 0), 0));
  const statUnits = round2(params.rows.reduce((sum, row) => sum + (Number(row.STAT_UNITS) || 0), 0));
  const committedValueEur = round2(params.rows.reduce(
    (sum, row) => sum + (Number(row.BASE_PLAN_UNITS) || 0) * (Number(row.UNIT_PRICE_EUR) || 0),
    0,
  ));
  const scenarioValueEur = round2(params.rows.reduce(
    (sum, row) => sum + (Number(row.CURRENT_UNITS) || 0) * (Number(row.UNIT_PRICE_EUR) || 0),
    0,
  ));
  return {
    childId: params.id,
    childLabel: params.label,
    childLevel: params.level,
    nodeKey: params.nodeKey,
    committedUnits,
    scenarioUnits,
    statUnits,
    deltaUnits: round2(scenarioUnits - committedUnits),
    committedValueEur,
    scenarioValueEur,
    deltaValueEur: round2(scenarioValueEur - committedValueEur),
    seriesCount,
    lockedLeafCount: params.rows.filter((row) => Boolean(row.IS_LOCKED)).length,
    hasEdits: params.rows.some((row) => row.EDIT_GROUP_ID !== null),
    editGroups: summariseEditGroups(params.rows),
  };
}

export function buildHierarchyNodes(level: HierarchyLevel, rows: LeafRow[], order: HierarchyLevel[] = DEFAULT_ORDER): HierarchyNodeRow[] {
  const nodes = new Map<string, { label: string; path: NodePath; rows: LeafRow[] }>();
  for (const row of rows) {
    const path = pathForLevel(row, level, order);
    const nodeKey = serialiseNodeKey(level, path, order);
    const slot = nodes.get(nodeKey) ?? { label: labelForLevel(row, level, order), path, rows: [] };
    slot.rows.push(row);
    nodes.set(nodeKey, slot);
  }

  return Array.from(nodes.entries())
    .map(([nodeKey, slot]) => {
      const childMap = new Map<string, { label: string; childLevel: HierarchyLevel | "WEEK_ID"; rows: LeafRow[] }>();
      for (const row of slot.rows) {
        const child = immediateChildMeta(row, level, order);
        const childSlot = childMap.get(child.childPathKey) ?? {
          label: child.childLabel,
          childLevel: child.childLevel,
          rows: [],
        };
        childSlot.rows.push(row);
        childMap.set(child.childPathKey, childSlot);
      }

      const children = Array.from(childMap.entries())
        .map(([childNodeKey, childSlot]) => buildAggregateRow({
          level: childSlot.childLevel === "WEEK_ID" ? "SERIES_ID" : childSlot.childLevel,
          label: childSlot.label,
          id: childSlot.childLevel === "WEEK_ID" ? childSlot.rows[0]?.WEEK_ID ?? childSlot.label : childSlot.label,
          nodeKey: childNodeKey,
          rows: childSlot.rows,
        }))
        .map((child) => ({
          ...child,
          childLevel: childMap.get(child.nodeKey)?.childLevel ?? child.childLevel,
        }))
        .sort((left, right) => {
          const valueGap = Math.abs(right.deltaValueEur) - Math.abs(left.deltaValueEur);
          if (valueGap !== 0) return valueGap;
          return right.scenarioValueEur - left.scenarioValueEur;
        });

      const aggregate = buildAggregateRow({
        level,
        label: slot.label,
        id: slot.path[level] ?? slot.label,
        nodeKey,
        rows: slot.rows,
      });

      return {
        ...aggregate,
        path: slot.path,
        level,
        childCount: children.length,
        children,
      };
    })
    .sort((left, right) => {
      const valueGap = Math.abs(right.deltaValueEur) - Math.abs(left.deltaValueEur);
      if (valueGap !== 0) return valueGap;
      return right.scenarioValueEur - left.scenarioValueEur;
    });
}

/**
 * The deepest level the scope selects, counting past gaps, or null at the root.
 *
 * Deliberately not `deepestSelectedLevel`, which stops at the first gap: for
 * Cognac + China (no product) it returns category, and a product listing under that
 * scope would show each Cognac product's China rows only. See `rowsInScope`.
 */
export function scopeFloor(scope: HierarchyPathServer): HierarchyLevel | null {
  let floor: HierarchyLevel | null = null;
  for (const level of levelOrder(rollupsOf(scope))) {
    if (scope[level]) floor = level;
  }
  return floor;
}

/**
 * The level to list: the requested one, or the scope's floor when the scope
 * selects something deeper. Listing above the scope could only ignore part of
 * it or split a node, so it is never done.
 */
export function listLevelForScope(level: HierarchyLevel, scope: HierarchyPathServer): HierarchyLevel {
  const order = drillOrder(rollupsOf(scope));
  const floor = scopeFloor(scope);
  return floor && order.indexOf(floor) > order.indexOf(level) ? floor : level;
}

/**
 * Leaf rows of the nodes at `level` whose path matches every selected scope level.
 *
 * A listed node must carry the WHOLE node's numbers, because the node is what
 * an edit writes to: preview and commit reload every row under its key. A product
 * row showing only its China rows would invite an absolute target typed against
 * China that is then spread over every customer.
 *
 * Matching on each row's node path (the values its key is built from) means a
 * node passes whole or not at all, whatever blank or missing values do in SQL.
 * `listLevelForScope` keeps `level` at or below every scope level; a scope level
 * below `level` is absent from the node path, so it matches nothing — an empty
 * list, never a partial node.
 *
 * Only levels of the drill order in use count: a level from another tree
 * (a category under a product-family roll-up) is not part of any node's key.
 */
function rowsInScope(rows: LeafRow[], level: HierarchyLevel, scope: HierarchyPathServer, order: HierarchyLevel[]): LeafRow[] {
  const selected = levelOrder(rollupsOf(scope)).filter((scopeLevel) => Boolean(scope[scopeLevel]));
  if (selected.length === 0) return rows;
  return rows.filter((row) => {
    const path = pathForLevel(row, level, order);
    return selected.every((scopeLevel) => path[scopeLevel] === scope[scopeLevel]);
  });
}

export async function loadHierarchyPayload(
  level: HierarchyLevel,
  scenarioId?: string | null,
  scope: HierarchyPathServer = {},
) {
  const order = drillOrder(rollupsOf(scope));
  const listLevel = listLevelForScope(level, scope);
  const [context, integrity, weeks, reasons, portfolioRows, scenario] = await Promise.all([
    getContext(),
    getIntegrity(),
    loadWeeks(),
    loadReasons(),
    loadLeafRows({ path: {}, scenarioId }),
    scenarioId ? getScenarioSummary(scenarioId) : Promise.resolve(null),
  ]);

  if (scenarioId && !scenario) {
    throw new Error("Scenario not found.");
  }

  // The scope picks which nodes are listed and totalled; it never splits one.
  const rows = rowsInScope(portfolioRows, listLevel, scope, order);
  const nodes = buildHierarchyNodes(listLevel, rows, order);
  const overallCommittedUnits = round2(rows.reduce((sum, row) => sum + (Number(row.BASE_PLAN_UNITS) || 0), 0));
  const overallScenarioUnits = round2(rows.reduce((sum, row) => sum + (Number(row.CURRENT_UNITS) || 0), 0));
  const overallCommittedValue = round2(rows.reduce(
    (sum, row) => sum + (Number(row.BASE_PLAN_UNITS) || 0) * (Number(row.UNIT_PRICE_EUR) || 0),
    0,
  ));
  const overallScenarioValue = round2(rows.reduce(
    (sum, row) => sum + (Number(row.CURRENT_UNITS) || 0) * (Number(row.UNIT_PRICE_EUR) || 0),
    0,
  ));

  return {
    context,
    integrity,
    level: listLevel,
    levelLabel: LEVEL_NAMES[listLevel],
    scenario: scenario ? {
      scenarioId: scenario.SCENARIO_ID,
      scenarioName: scenario.SCENARIO_NAME,
      status: scenario.STATUS,
    } : null,
    weeks,
    reasons,
    overall: {
      committedUnits: overallCommittedUnits,
      scenarioUnits: overallScenarioUnits,
      deltaUnits: round2(overallScenarioUnits - overallCommittedUnits),
      committedValueEur: overallCommittedValue,
      scenarioValueEur: overallScenarioValue,
      deltaValueEur: round2(overallScenarioValue - overallCommittedValue),
      nodeCount: nodes.length,
      editedNodeCount: nodes.filter((node) => node.hasEdits).length,
    },
    nodes,
  };
}

function toImmediateChildGroups(level: HierarchyLevel, rows: LeafRow[], order: HierarchyLevel[]) {
  const groups = new Map<string, {
    childLabel: string;
    childLevel: HierarchyLevel | "WEEK_ID";
    nodeKey: string;
    rows: LeafRow[];
  }>();
  for (const row of rows) {
    const child = immediateChildMeta(row, level, order);
    const slot = groups.get(child.childId) ?? {
      childLabel: child.childLabel,
      childLevel: child.childLevel,
      nodeKey: child.childPathKey,
      rows: [],
    };
    slot.rows.push(row);
    groups.set(child.childId, slot);
  }
  return groups;
}

/**
 * `rollups` come from the request's ROLLUP_* query params (or the grid's path),
 * so the node key is read in the drill order it was built in.
 */
export function parsePreviewRequestBody(body: unknown, rollups: Rollups = {}): PreviewRequest | { message: string; status: number } {
  const order = drillOrder(rollups);
  if (!body || typeof body !== "object") return badRequest("A preview request body is required.");
  const record = body as Record<string, unknown>;
  const scenarioId = typeof record.scenarioId === "string" ? record.scenarioId : null;
  if (!isScenarioId(scenarioId)) return badRequest("scenarioId must be a valid scenario id.");

  const node = (record.node ?? {}) as Record<string, unknown>;
  const level = parseLevel(typeof node.level === "string" ? node.level : null, order);
  if (!level) return badRequest("node.level is invalid.");

  const nodeKey = typeof node.key === "string" ? node.key : "";
  const nodePath = parseNodeKey(level, nodeKey, order);
  if (!nodePath) return badRequest("node.key is invalid for the selected level.");

  const disaggMethod = asDisaggMethod(typeof record.disaggMethod === "string" ? record.disaggMethod : null);
  if (!disaggMethod) return badRequest("disaggMethod must be 'statistical' or 'current_plan'.");

  const weekRange = (record.weekRange ?? {}) as Record<string, unknown>;
  const weekFrom = typeof weekRange.from === "string" ? weekRange.from : null;
  const weekTo = typeof weekRange.to === "string" ? weekRange.to : null;
  if (!isWeekId(weekFrom) || !isWeekId(weekTo)) {
    return badRequest("weekRange.from and weekRange.to must be valid planning weeks.");
  }
  if (weekFrom > weekTo) return badRequest("weekRange.from must be earlier than or equal to weekRange.to.");

  const target = (record.target ?? {}) as Record<string, unknown>;
  const targetMode = target.mode === "percentage" ? "percentage" : target.mode === "absolute" ? "absolute" : null;
  if (!targetMode) return badRequest("target.mode must be 'absolute' or 'percentage'.");
  const targetValue = typeof target.value === "number" ? target.value : Number(target.value);
  if (!Number.isFinite(targetValue)) return badRequest("target.value must be numeric.");
  if (targetMode === "absolute" && targetValue < 0) return badRequest("Absolute targets cannot be negative.");

  const lockedChildIdsRaw = Array.isArray(record.lockedChildIds) ? record.lockedChildIds : [];
  const lockedChildIds = new Set<string>();
  for (const childId of lockedChildIdsRaw) {
    if (typeof childId !== "string" || childId.trim().length === 0) {
      return badRequest("lockedChildIds must contain only child ids.");
    }
    lockedChildIds.add(childId);
  }

  return {
    scenarioId,
    level,
    nodeKey,
    nodePath,
    disaggMethod,
    weekFrom,
    weekTo,
    targetMode,
    targetValue,
    lockedChildIds,
    order,
  };
}

export async function buildPreview(request: PreviewRequest): Promise<PreviewResponse> {
  const scenario = await getScenarioSummary(request.scenarioId);
  if (!scenario) throw new Error("Scenario not found.");
  if (scenario.STATUS !== "draft") throw new Error("Only draft scenarios can be edited.");

  const rows = await loadLeafRows({
    path: request.nodePath,
    scenarioId: request.scenarioId,
    weekFrom: request.weekFrom,
    weekTo: request.weekTo,
  });
  if (rows.length === 0) throw new Error("No forward-plan rows match that hierarchy selection.");

  const childGroups = toImmediateChildGroups(request.level, rows, request.order);
  for (const childId of request.lockedChildIds) {
    if (!childGroups.has(childId)) {
      throw new Error("A requested locked child does not belong to the selected node.");
    }
  }

  const parentCurrent = round2(rows.reduce((sum, row) => sum + (Number(row.CURRENT_UNITS) || 0), 0));
  const targetUnits = request.targetMode === "absolute"
    ? round2(request.targetValue)
    : round2(parentCurrent * (1 + request.targetValue));
  if (targetUnits < 0) throw new Error("This target would drive the node below zero.");

  const outcome = request.targetMode === "absolute"
    ? disaggregate(
        targetUnits,
        rows.map((row) => ({
          id: `${row.SERIES_ID}:${row.WEEK_ID}`,
          currentUnits: Number(row.CURRENT_UNITS) || 0,
          statUnits: Number(row.STAT_UNITS) || 0,
          locked: Boolean(row.IS_LOCKED) || request.lockedChildIds.has(immediateChildMeta(row, request.level, request.order).childId),
        })),
        request.disaggMethod,
      )
    : disaggregateByPercent(
        request.targetValue,
        rows.map((row) => ({
          id: `${row.SERIES_ID}:${row.WEEK_ID}`,
          currentUnits: Number(row.CURRENT_UNITS) || 0,
          statUnits: Number(row.STAT_UNITS) || 0,
          locked: Boolean(row.IS_LOCKED) || request.lockedChildIds.has(immediateChildMeta(row, request.level, request.order).childId),
        })),
        request.disaggMethod,
      );

  const byLeafId = new Map(outcome.children.map((child) => [child.id, child]));

  const previewChildren = Array.from(childGroups.entries())
    .map(([childId, group]) => {
      const descendants = group.rows.map((row) => byLeafId.get(`${row.SERIES_ID}:${row.WEEK_ID}`)!);
      const currentUnits = round2(descendants.reduce((sum, child) => sum + child.currentUnits, 0));
      const proposedUnits = round2(descendants.reduce((sum, child) => sum + child.newUnits, 0));
      const deltaUnits = round2(proposedUnits - currentUnits);
      return {
        childId,
        childLabel: group.childLabel,
        childLevel: group.childLevel,
        nodeKey: group.nodeKey,
        currentUnits,
        proposedUnits,
        deltaUnits,
        deltaValueEur: round2(group.rows.reduce((sum, row) => {
          const child = byLeafId.get(`${row.SERIES_ID}:${row.WEEK_ID}`)!;
          return sum + child.deltaUnits * (Number(row.UNIT_PRICE_EUR) || 0);
        }, 0)),
        shareOfChange: Math.abs(outcome.appliedDelta) > 0 ? round2(deltaUnits / outcome.appliedDelta) : null,
        locked: request.lockedChildIds.has(childId),
        excluded: !request.lockedChildIds.has(childId) && descendants.every((child) => child.excluded),
        clamped: descendants.some((child) => child.clamped),
        lockedLeafCount: group.rows.filter((row) => Boolean(row.IS_LOCKED)).length,
        movedLeafCount: descendants.filter((child) => !same2(child.deltaUnits, 0)).length,
      } satisfies PreviewChildRow;
    })
    .sort((left, right) => {
      const valueGap = Math.abs(right.deltaValueEur) - Math.abs(left.deltaValueEur);
      if (valueGap !== 0) return valueGap;
      return right.proposedUnits - left.proposedUnits;
    });

  return {
    scenarioId: scenario.SCENARIO_ID,
    scenarioName: scenario.SCENARIO_NAME,
    node: {
      level: request.level,
      label: rows[0] ? labelForLevel(rows[0], request.level, request.order) : "Selected node",
      key: request.nodeKey,
      currentUnits: parentCurrent,
      targetUnits,
      weekFrom: request.weekFrom,
      weekTo: request.weekTo,
    },
    method: request.disaggMethod,
    target: {
      mode: request.targetMode,
      value: request.targetValue,
    },
    children: previewChildren,
    outcome: {
      feasible: outcome.feasible,
      shortfall: round2(outcome.shortfall),
      targetDelta: round2(outcome.targetDelta),
      appliedDelta: round2(outcome.appliedDelta),
      lockedCount: request.lockedChildIds.size,
      lockedLeafCount: rows.filter((row) => Boolean(row.IS_LOCKED)).length,
      movedCount: previewChildren.filter((child) => !same2(child.deltaUnits, 0)).length,
      excludedCount: previewChildren.filter((child) => child.excluded).length,
      clampedCount: previewChildren.filter((child) => child.clamped).length,
      // A commit replaces whatever is in each cell. Where that is an accepted
      // agent edit, the planner is about to discard a recommendation they
      // previously accepted, and the row's provenance will flip to 'planner'.
      // Silently absorbing it would make the scenario's agent-contribution
      // figure under-count, so the preview has to say so before they confirm.
      agentEditsReplaced: rows.filter(
        (row) => row.ORIGIN === "agent" && !same2(byLeafId.get(`${row.SERIES_ID}:${row.WEEK_ID}`)?.deltaUnits ?? 0, 0),
      ).length,
    },
    leaves: rows.map((row) => {
      const child = byLeafId.get(`${row.SERIES_ID}:${row.WEEK_ID}`)!;
      return {
        seriesId: row.SERIES_ID,
        weekId: row.WEEK_ID,
        baseUnits: round2(Number(row.BASE_PLAN_UNITS) || 0),
        currentUnits: round2(Number(row.CURRENT_UNITS) || 0),
        proposedUnits: round2(child.newUnits),
        deltaUnits: round2(child.deltaUnits),
        isLocked: Boolean(row.IS_LOCKED),
      };
    }),
  };
}

export async function parseCommitApplyBody(body: unknown, rollups: Rollups = {}): Promise<CommitApplyRequest | { message: string; status: number }> {
  const preview = parsePreviewRequestBody(body, rollups);
  if ("message" in preview) return preview;

  const record = body as Record<string, unknown>;
  const confirm = record.confirm === true;
  if (!confirm) return badRequest("Set confirm=true to commit this edit.", 409);

  const reasonCode = typeof record.reasonCode === "string" ? record.reasonCode : null;
  if (!reasonCode) return badRequest("reasonCode is required.");
  const reason = await getReason(reasonCode);
  if (!reason) return badRequest("Unknown reason code.");

  const note = normaliseOptionalText(record.note, MAX_NOTE_LENGTH);
  if (reason.REQUIRES_NOTE && !note) {
    return badRequest(`Reason '${reasonCode}' requires a note.`);
  }

  return {
    ...preview,
    reasonCode,
    note,
  };
}

export async function deleteEditGroup(scenarioId: string, editGroupId: string) {
  const rows = await query<{ SERIES_ID: string }>(
    `SELECT SERIES_ID
     FROM CORE.FACT_SCENARIO_EDIT
     WHERE SCENARIO_ID = ?
       AND EDIT_GROUP_ID = ?`,
    [scenarioId, editGroupId],
  );
  await query(
    `DELETE FROM CORE.FACT_SCENARIO_EDIT
     WHERE SCENARIO_ID = ?
       AND EDIT_GROUP_ID = ?`,
    [scenarioId, editGroupId],
  );
  // A price edit writes its driver under the same edit group; revert both.
  await query(
    `DELETE FROM CORE.FACT_SCENARIO_DRIVER
     WHERE SCENARIO_ID = ?
       AND EDIT_GROUP_ID = ?`,
    [scenarioId, editGroupId],
  );
  await query(
    `UPDATE CORE.DIM_SCENARIO
     SET UPDATED_AT = CURRENT_TIMESTAMP()
     WHERE SCENARIO_ID = ?`,
    [scenarioId],
  );
  return rows.length;
}

export async function commitPreview(request: CommitApplyRequest, preview: PreviewResponse) {
  const scenario = await getScenarioSummary(request.scenarioId);
  if (!scenario) throw new Error("Scenario not found.");
  if (scenario.STATUS !== "draft") throw new Error("Only draft scenarios can be edited.");
  if (!preview.outcome.feasible) throw new Error("Infeasible previews cannot be committed.");

  const actor = await getActor();
  const editGroupId = crypto.randomUUID();

  const rowsToDelete = preview.leaves
    .filter((leaf) => same2(leaf.proposedUnits, leaf.baseUnits))
    .map((leaf) => ({ seriesId: leaf.seriesId, weekId: leaf.weekId }));
  const rowsToMerge = preview.leaves
    .filter((leaf) => !same2(leaf.proposedUnits, leaf.baseUnits))
    .map((leaf) => ({
      scenarioId: request.scenarioId,
      seriesId: leaf.seriesId,
      weekId: leaf.weekId,
      baseUnits: leaf.baseUnits,
      editUnits: leaf.proposedUnits,
      deltaUnits: round2(leaf.proposedUnits - leaf.baseUnits),
      origin: "planner",
      reasonCode: request.reasonCode,
      note: request.note,
      editGroupId,
      parentLevel: request.level,
      parentKey: request.nodePath[request.level] ?? preview.node.label,
      disaggMethod: request.disaggMethod,
      editedBy: actor,
    }));

  if (rowsToDelete.length > 0) {
    const deleteBinds = rowsToDelete.flatMap((row) => [row.seriesId, row.weekId]);
    const tupleList = rowsToDelete.map(() => "(?, ?)").join(", ");
    await query(
      `DELETE FROM CORE.FACT_SCENARIO_EDIT
       WHERE SCENARIO_ID = ?
         AND (SERIES_ID, WEEK_ID) IN (${tupleList})`,
      [request.scenarioId, ...deleteBinds],
    );
  }

  if (rowsToMerge.length > 0) {
    const selects = rowsToMerge
      .map(
        () => `SELECT ? AS SCENARIO_ID, ? AS SERIES_ID, ? AS WEEK_ID, ? AS BASE_UNITS,
                      ? AS EDIT_UNITS, ? AS DELTA_UNITS, ? AS ORIGIN,
                      ? AS REASON_CODE, ? AS NOTE, ? AS EDIT_GROUP_ID,
                      ? AS PARENT_LEVEL, ? AS PARENT_KEY, ? AS DISAGG_METHOD,
                      ? AS EDITED_BY`,
      )
      .join(" UNION ALL ");
    const binds = rowsToMerge.flatMap((row) => [
      row.scenarioId,
      row.seriesId,
      row.weekId,
      row.baseUnits,
      row.editUnits,
      row.deltaUnits,
      row.origin,
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
         SOURCE_PROPOSAL_ID = NULL,
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
         source.EDIT_UNITS, source.DELTA_UNITS, source.ORIGIN, NULL,
         source.REASON_CODE, source.NOTE, source.EDIT_GROUP_ID,
         source.PARENT_LEVEL, source.PARENT_KEY, source.DISAGG_METHOD,
         source.EDITED_BY, CURRENT_TIMESTAMP()
       )`,
      binds,
    );
  }

  await query(
    `UPDATE CORE.DIM_SCENARIO
     SET UPDATED_AT = CURRENT_TIMESTAMP()
     WHERE SCENARIO_ID = ?`,
    [request.scenarioId],
  );

  return {
    editGroupId,
    writtenRows: rowsToMerge.length,
    deletedRows: rowsToDelete.length,
  };
}
