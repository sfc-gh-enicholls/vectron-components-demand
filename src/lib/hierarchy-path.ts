/**
 * Server-side helpers for the hierarchy path filter.
 *
 * Kept separate from the client component so an API route can parse and apply a
 * path without importing React. The two files share the level names and nothing
 * else, which is the point: the contract is the four level columns, which exist
 * on APP.V_SERIES and therefore on every view joined to it.
 *
 * WHY THE PREDICATE IS BUILT WITH BIND PARAMETERS
 * -----------------------------------------------
 * The values come from a query string. Interpolating a product name straight into
 * SQL would be an injection hole, and product names here legitimately contain
 * apostrophes (Ballantine's), which would break the statement even with honest
 * input. So the builder returns a predicate with placeholders plus the values to
 * bind, and callers must pass both.
 *
 * ALTERNATE ROLL-UPS
 * ------------------
 * A path may also carry alternate-tree levels (PRODUCT_LINE, REGION, …) and the
 * ROLLUP_* keys naming which tree each dimension is drilled through; see
 * src/lib/dimensions.ts. An alternate level is an attribute of a leaf column,
 * so its predicate is "leaf IN (leaves with that attribute)" and works on any
 * alias that carries the leaf. ROLLUP_* keys only change the ORDER levels are
 * read in; they never produce SQL. A path with neither behaves exactly as the
 * four-level path always did.
 */

import {
  ALT_LEVELS,
  BASE_LEVELS,
  FALLBACK_CATALOGUE,
  LEAF_OF,
  PATH_LEVELS,
  ROLLUP_PARAM,
  ROLLUP_PARAMS,
  levelOrder,
  readRollups,
  type HierarchyDef,
  type PathLevel,
  type RollupDimension,
  type RollupParam,
  type Rollups,
} from "@/lib/dimensions";

export const HIERARCHY_LEVELS = BASE_LEVELS;

export type HierarchyLevelName = (typeof HIERARCHY_LEVELS)[number];

export type { AltLevel, PathLevel } from "@/lib/dimensions";

export type HierarchyPathServer = Partial<Record<PathLevel | RollupParam, string>>;

/**
 * Read the levels and roll-ups off a request's search params, ignoring anything
 * else. Empty strings and the sentinel "__all__" are treated as absent. A
 * ROLLUP_* value is kept only when it names a non-default tree of that
 * dimension; anything else is dropped, so the default tree applies.
 */
export function parseHierarchyPath(
  params: URLSearchParams,
  catalogue: HierarchyDef[] = FALLBACK_CATALOGUE,
): HierarchyPathServer {
  const path: HierarchyPathServer = {};
  for (const level of PATH_LEVELS) {
    const raw = params.get(level);
    if (raw && raw !== "__all__") path[level] = raw;
  }
  const rollups = readRollups((key) => params.get(key), catalogue);
  for (const [dimension, id] of Object.entries(rollups) as [RollupDimension, string][]) {
    path[ROLLUP_PARAM[dimension]] = id;
  }
  return path;
}

/** The roll-ups a path carries. */
export function rollupsOf(path: HierarchyPathServer): Rollups {
  return readRollups((key) => path[key]);
}

/** Path levels in this path's drill order (the four base levels by default). */
export function pathLevelOrder(path: HierarchyPathServer): PathLevel[] {
  return levelOrder(rollupsOf(path));
}

/**
 * A SQL predicate for the path, with bind values.
 *
 * Returns `{ sql: "1=1", binds: [] }` at the root so it can always be dropped
 * into a WHERE clause without the caller branching on emptiness.
 *
 * `alias` is the table alias carrying the level columns. An alternate level
 * needs only its leaf column on the alias; the attribute is looked up on
 * APP.V_SERIES.
 */
export function hierarchyPredicate(
  path: HierarchyPathServer,
  alias: string,
): { sql: string; binds: string[] } {
  const parts: string[] = [];
  const binds: string[] = [];
  for (const level of HIERARCHY_LEVELS) {
    const value = path[level];
    if (!value) continue;
    parts.push(`${alias}.${level} = ?`);
    binds.push(value);
  }
  for (const level of ALT_LEVELS) {
    const value = path[level];
    if (!value) continue;
    const leaf = LEAF_OF[level];
    parts.push(`${alias}.${leaf} IN (SELECT ${leaf} FROM APP.V_SERIES WHERE ${level} = ?)`);
    binds.push(value);
  }
  return parts.length > 0
    ? { sql: parts.join(" AND "), binds }
    : { sql: "1=1", binds: [] };
}

/**
 * The path restricted to the given levels.
 *
 * For a query whose source lacks some level columns — `V_DESTOCKING` has no
 * channel, the sensing weather feed has only customer. Pairing this with
 * `hierarchyPredicate` honours what the source can support; callers should say
 * in the UI which levels were dropped, rather than silently ignoring them.
 *
 * An alternate level is kept when its leaf level is allowed, since that is all
 * its predicate needs. Roll-ups are always kept: they carry no SQL.
 */
export function pickLevels(
  path: HierarchyPathServer,
  levels: readonly HierarchyLevelName[],
): HierarchyPathServer {
  const next: HierarchyPathServer = {};
  for (const level of levels) {
    if (path[level]) next[level] = path[level];
  }
  for (const level of ALT_LEVELS) {
    if (path[level] && levels.includes(LEAF_OF[level])) next[level] = path[level];
  }
  for (const key of ROLLUP_PARAMS) {
    if (path[key]) next[key] = path[key];
  }
  return next;
}

/** The deepest selected level in drill order, or null at the root. Stops at the first gap. */
export function deepestSelectedLevel(
  path: HierarchyPathServer,
): PathLevel | null {
  let deepest: PathLevel | null = null;
  for (const level of pathLevelOrder(path)) {
    if (!path[level]) break;
    deepest = level;
  }
  return deepest;
}

/**
 * Breadcrumb label for the selected node. Levels follow the drill order; any
 * selected level outside it (a category kept under a product-family roll-up) is
 * appended rather than dropped, so the label never hides a filter.
 */
export function hierarchyLabel(path: HierarchyPathServer): string {
  const order = pathLevelOrder(path);
  const parts = [...order, ...PATH_LEVELS.filter((level) => !order.includes(level))]
    .map((level) => path[level])
    .filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" / ") : "Total portfolio";
}
