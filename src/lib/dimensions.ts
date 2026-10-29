/**
 * Dimension hierarchies: which trees exist, and the drill order they imply.
 *
 * WHY THIS MODULE IS PURE
 * -----------------------
 * The trees live in Snowflake (CORE.DIM_HIERARCHY*, read through
 * APP.V_HIERARCHY), but the client needs the drill order before any fetch has
 * returned, and the server needs it inside synchronous helpers such as
 * `hierarchyPredicate`. So the catalogue is mirrored here as a constant and
 * every function takes the catalogue as an argument defaulting to it. Nothing
 * here imports the Snowflake driver, which keeps it unit-testable and safe to
 * import from a client component.
 *
 * THE MODEL: ONE TREE PER DIMENSION, CHOSEN PER REQUEST
 * -----------------------------------------------------
 * A plan lives at the leaf (product × customer × channel, by week). Each of the
 * product, customer and channel dimensions has a default tree and zero or more
 * alternates over the same leaves. The planner picks one tree per dimension
 * (a "roll-up"), and the drill path is the chosen product tree's levels, then
 * the customer tree's, then the channel tree's. The defaults reproduce the one
 * fixed path the app always had — CATEGORY_NAME > PRODUCT_NAME > CUSTOMER_NAME >
 * CHANNEL_NAME — so a request that names no roll-up behaves exactly as before.
 *
 * ALTERNATE LEVELS ARE ATTRIBUTES OF A LEAF
 * -----------------------------------------
 * Every non-default level (product family, region, …) is an attribute of exactly
 * one leaf column on APP.V_SERIES. That is what lets any view carrying the leaf
 * column be filtered by an alternate level without that view knowing the trees
 * exist: the filter becomes "leaf IN (leaves with this attribute)". `LEAF_OF`
 * records the mapping.
 *
 * QUERY-STRING CONTRACT
 * ---------------------
 * A roll-up travels as ROLLUP_PRODUCT / ROLLUP_CUSTOMER / ROLLUP_CHANNEL and is
 * emitted ONLY when it differs from the dimension's default, so a default URL
 * is byte-for-byte the URL the app produced before roll-ups existed.
 */

export type Dimension = "PRODUCT" | "CUSTOMER" | "CHANNEL" | "TIME";

/** The dimensions a planner can re-roll. Time keeps its fixed week bucketing. */
export type RollupDimension = Exclude<Dimension, "TIME">;

export const ROLLUP_DIMENSIONS: RollupDimension[] = ["PRODUCT", "CUSTOMER", "CHANNEL"];

export interface HierarchyLevelDef {
  column: string;
  label: string;
  allLabel: string;
  isLeaf: boolean;
  /** Nodes at this level; only present when loaded from Snowflake. */
  nodeCount?: number;
}

export interface HierarchyDef {
  id: string;
  dimension: Dimension;
  name: string;
  description: string | null;
  isDefault: boolean;
  rootLabel: string;
  levels: HierarchyLevelDef[];
  /** The tree itself; only present when loaded from Snowflake, never for time. */
  nodes?: HNode[];
}

export interface HNode {
  id: string;
  label: string;
  parent: string | null;
}

const level = (column: string, label: string, allLabel: string, isLeaf = false): HierarchyLevelDef =>
  ({ column, label, allLabel, isLeaf });

/**
 * The trees as deployed by snowflake/16-hierarchies.sql, in SORT_ORDER within
 * each dimension. Used before /api/hierarchies has answered, or if it fails.
 * Must match the Snowflake rows; the catalogue loader is the check on that.
 */
export const FALLBACK_CATALOGUE: HierarchyDef[] = [
  {
    id: "PRODUCT_CATEGORY", dimension: "PRODUCT", name: "By category",
    description: "Category, then part family. The original portfolio structure.",
    isDefault: true, rootLabel: "Total portfolio",
    levels: [level("CATEGORY_NAME", "Category", "Total portfolio"), level("PRODUCT_NAME", "Part family", "All part families", true)],
  },
  {
    id: "PRODUCT_FAMILY", dimension: "PRODUCT", name: "By product line",
    description: "Product line (brake calipers, dampers, e-axles…), then part family.",
    isDefault: false, rootLabel: "Total portfolio",
    levels: [level("PRODUCT_LINE", "Product line", "All product lines"), level("PRODUCT_NAME", "Part family", "All part families", true)],
  },
  {
    id: "PRODUCT_TIER", dimension: "PRODUCT", name: "By technology tier",
    description: "Commodity, Standard, Engineered and Mechatronic, then part family.",
    isDefault: false, rootLabel: "Total portfolio",
    levels: [level("PRICE_TIER", "Technology tier", "All technology tiers"), level("PRODUCT_NAME", "Part family", "All part families", true)],
  },
  {
    id: "CUSTOMER_LIST", dimension: "CUSTOMER", name: "Customer list",
    description: "Customers as one flat list. The original structure.",
    isDefault: true, rootLabel: "All customers",
    levels: [level("CUSTOMER_NAME", "Customer", "All customers", true)],
  },
  {
    id: "CUSTOMER_REGION", dimension: "CUSTOMER", name: "By region",
    description: "Reporting region, then customer.",
    isDefault: false, rootLabel: "All customers",
    levels: [level("REGION", "Region", "All regions"), level("CUSTOMER_NAME", "Customer", "All customers", true)],
  },
  {
    id: "CUSTOMER_ROUTE", dimension: "CUSTOMER", name: "By route to customer",
    description: "OEM or aftermarket, then delivery mode (JIS, JIT, stock), then customer.",
    isDefault: false, rootLabel: "All customers",
    levels: [
      level("ROUTE_TO_CUSTOMER", "Route to customer", "All routes"),
      level("DELIVERY_MODE", "Delivery mode", "All delivery modes"),
      level("CUSTOMER_NAME", "Customer", "All customers", true),
    ],
  },
  {
    id: "CHANNEL_LIST", dimension: "CHANNEL", name: "Channel list",
    description: "Channels as one flat list. The original structure.",
    isDefault: true, rootLabel: "All channels",
    levels: [level("CHANNEL_NAME", "Channel", "All channels", true)],
  },
  {
    id: "CHANNEL_GROUP", dimension: "CHANNEL", name: "By channel group",
    description: "OE series or service and aftermarket, then channel.",
    isDefault: false, rootLabel: "All channels",
    levels: [level("CHANNEL_GROUP", "Channel group", "All channel groups"), level("CHANNEL_NAME", "Channel", "All channels", true)],
  },
  {
    id: "TIME_FISCAL", dimension: "TIME", name: "Fiscal calendar",
    description: "Fiscal year (calendar year), quarter, period, week.",
    isDefault: true, rootLabel: "All weeks",
    levels: [
      level("FISCAL_YEAR", "Fiscal year", "All years"),
      level("FISCAL_QUARTER", "Quarter", "All quarters"),
      level("FISCAL_PERIOD", "Period", "All periods"),
      level("WEEK_ID", "Week", "All weeks", true),
    ],
  },
  {
    id: "TIME_CALENDAR", dimension: "TIME", name: "Calendar",
    description: "Calendar year and month of each week's Monday, then ISO week.",
    isDefault: false, rootLabel: "All weeks",
    levels: [
      level("WEEK_START_DATE", "Year", "All years"),
      level("WEEK_START_DATE", "Month", "All months"),
      level("WEEK_ID", "Week", "All weeks", true),
    ],
  },
];

// ─── Levels ──────────────────────────────────────────────────────────

/** The original four levels, outermost first. */
export const BASE_LEVELS = ["CATEGORY_NAME", "PRODUCT_NAME", "CUSTOMER_NAME", "CHANNEL_NAME"] as const;
export type BaseLevel = (typeof BASE_LEVELS)[number];

/** Levels that exist only in an alternate tree. Each is a column on APP.V_SERIES. */
export const ALT_LEVELS = ["PRODUCT_LINE", "PRICE_TIER", "REGION", "ROUTE_TO_CUSTOMER", "DELIVERY_MODE", "CHANNEL_GROUP"] as const;
export type AltLevel = (typeof ALT_LEVELS)[number];

export type PathLevel = BaseLevel | AltLevel;

/** Every level a path can carry: base levels first, so default iteration is unchanged. */
export const PATH_LEVELS: PathLevel[] = [...BASE_LEVELS, ...ALT_LEVELS];

/** The leaf column an alternate level is an attribute of. */
export const LEAF_OF: Record<AltLevel, BaseLevel> = {
  PRODUCT_LINE: "PRODUCT_NAME",
  PRICE_TIER: "PRODUCT_NAME",
  REGION: "CUSTOMER_NAME",
  ROUTE_TO_CUSTOMER: "CUSTOMER_NAME",
  DELIVERY_MODE: "CUSTOMER_NAME",
  CHANNEL_GROUP: "CHANNEL_NAME",
};

export const DIMENSION_OF: Record<PathLevel, RollupDimension> = {
  CATEGORY_NAME: "PRODUCT",
  PRODUCT_NAME: "PRODUCT",
  PRODUCT_LINE: "PRODUCT",
  PRICE_TIER: "PRODUCT",
  CUSTOMER_NAME: "CUSTOMER",
  REGION: "CUSTOMER",
  ROUTE_TO_CUSTOMER: "CUSTOMER",
  DELIVERY_MODE: "CUSTOMER",
  CHANNEL_NAME: "CHANNEL",
  CHANNEL_GROUP: "CHANNEL",
};

export const LEVEL_LABELS: Record<PathLevel, string> = {
  CATEGORY_NAME: "Category",
  PRODUCT_NAME: "Part family",
  CUSTOMER_NAME: "Customer",
  CHANNEL_NAME: "Channel",
  PRODUCT_LINE: "Product line",
  PRICE_TIER: "Technology tier",
  REGION: "Region",
  ROUTE_TO_CUSTOMER: "Route to customer",
  DELIVERY_MODE: "Delivery mode",
  CHANNEL_GROUP: "Channel group",
};

/** Label for the "no selection at this level" option. */
export const ALL_LABELS: Record<PathLevel, string> = {
  CATEGORY_NAME: "Total portfolio",
  PRODUCT_NAME: "All part families",
  CUSTOMER_NAME: "All customers",
  CHANNEL_NAME: "All channels",
  PRODUCT_LINE: "All product lines",
  PRICE_TIER: "All technology tiers",
  REGION: "All regions",
  ROUTE_TO_CUSTOMER: "All routes",
  DELIVERY_MODE: "All delivery modes",
  CHANNEL_GROUP: "All channel groups",
};

export function isPathLevel(value: string): value is PathLevel {
  return (PATH_LEVELS as string[]).includes(value);
}

export function isAltLevel(value: string): value is AltLevel {
  return (ALT_LEVELS as readonly string[]).includes(value);
}

/** The leaf column a level resolves to: itself for a base level. */
export function leafOf(pathLevel: PathLevel): BaseLevel {
  return isAltLevel(pathLevel) ? LEAF_OF[pathLevel] : pathLevel;
}

// ─── Roll-ups ────────────────────────────────────────────────────────

export type Rollups = Partial<Record<RollupDimension, string>>;

export const DEFAULT_ROLLUPS: Required<Rollups> = {
  PRODUCT: "PRODUCT_CATEGORY",
  CUSTOMER: "CUSTOMER_LIST",
  CHANNEL: "CHANNEL_LIST",
};

export const ROLLUP_PARAM = {
  PRODUCT: "ROLLUP_PRODUCT",
  CUSTOMER: "ROLLUP_CUSTOMER",
  CHANNEL: "ROLLUP_CHANNEL",
} as const satisfies Record<RollupDimension, string>;

export type RollupParam = (typeof ROLLUP_PARAM)[RollupDimension];

export const ROLLUP_PARAMS: RollupParam[] = ROLLUP_DIMENSIONS.map((dimension) => ROLLUP_PARAM[dimension]);

/** The trees of one dimension, in catalogue order. */
export function hierarchiesFor(dimension: Dimension, catalogue: HierarchyDef[] = FALLBACK_CATALOGUE): HierarchyDef[] {
  return catalogue.filter((tree) => tree.dimension === dimension);
}

export function defaultHierarchyId(dimension: RollupDimension, catalogue: HierarchyDef[] = FALLBACK_CATALOGUE): string {
  return hierarchiesFor(dimension, catalogue).find((tree) => tree.isDefault)?.id ?? DEFAULT_ROLLUPS[dimension];
}

/** The tree in effect for a dimension: the chosen one if known, else the default. */
export function treeFor(
  dimension: RollupDimension,
  rollups: Rollups = {},
  catalogue: HierarchyDef[] = FALLBACK_CATALOGUE,
): HierarchyDef {
  const trees = hierarchiesFor(dimension, catalogue);
  const chosen = rollups[dimension];
  return trees.find((tree) => tree.id === chosen)
    ?? trees.find((tree) => tree.isDefault)
    ?? FALLBACK_CATALOGUE.find((tree) => tree.id === DEFAULT_ROLLUPS[dimension])!;
}

/** The path levels of one tree, outermost first. */
export function treeLevels(tree: HierarchyDef): PathLevel[] {
  return tree.levels.map((entry) => entry.column).filter(isPathLevel);
}

/**
 * Path level columns in drill order: product tree, then customer, then channel.
 * Defaults give exactly CATEGORY_NAME, PRODUCT_NAME, CUSTOMER_NAME, CHANNEL_NAME.
 */
export function levelOrder(rollups: Rollups = {}, catalogue: HierarchyDef[] = FALLBACK_CATALOGUE): PathLevel[] {
  return ROLLUP_DIMENSIONS.flatMap((dimension) => treeLevels(treeFor(dimension, rollups, catalogue)));
}

/** True when `id` names a tree of `dimension`. */
export function isKnownRollup(dimension: RollupDimension, id: string, catalogue: HierarchyDef[] = FALLBACK_CATALOGUE): boolean {
  return hierarchiesFor(dimension, catalogue).some((tree) => tree.id === id);
}

/**
 * Read roll-ups off a record keyed by ROLLUP_* names, keeping only known,
 * non-default trees. Unknown ids are ignored rather than rejected, so a stale
 * bookmark degrades to the default tree instead of an error page.
 */
export function readRollups(
  get: (key: RollupParam) => string | null | undefined,
  catalogue: HierarchyDef[] = FALLBACK_CATALOGUE,
): Rollups {
  const out: Rollups = {};
  for (const dimension of ROLLUP_DIMENSIONS) {
    const raw = get(ROLLUP_PARAM[dimension]);
    if (!raw) continue;
    if (!isKnownRollup(dimension, raw, catalogue)) continue;
    if (raw === defaultHierarchyId(dimension, catalogue)) continue;
    out[dimension] = raw;
  }
  return out;
}

/** Query-string pairs for the roll-ups, emitted only when non-default. */
export function rollupsToParams(rollups: Rollups, catalogue: HierarchyDef[] = FALLBACK_CATALOGUE): Record<string, string> {
  const params: Record<string, string> = {};
  for (const dimension of ROLLUP_DIMENSIONS) {
    const id = rollups[dimension];
    if (id && id !== defaultHierarchyId(dimension, catalogue)) params[ROLLUP_PARAM[dimension]] = id;
  }
  return params;
}

/**
 * Query-string pairs for a path: base levels in their original order, then
 * alternate levels, then non-default roll-ups. A path with only base levels
 * produces exactly the pairs the app emitted before roll-ups existed.
 */
export function pathParams(
  path: Partial<Record<PathLevel | RollupParam, string | null | undefined>>,
  catalogue: HierarchyDef[] = FALLBACK_CATALOGUE,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pathLevel of PATH_LEVELS) {
    const value = path[pathLevel];
    if (value) params[pathLevel] = value;
  }
  return { ...params, ...rollupsToParams(readRollups((key) => path[key], catalogue), catalogue) };
}

// ─── Tree validation and walking ─────────────────────────────────────

/**
 * Structural problems with a parent-child node list, or [] when it is a tree.
 *
 * Checks, in order: duplicate ids, exactly one root, every parent exists, and
 * no cycles. A cycle cannot reach the root, so it is found by walking up from
 * each node; the walk is bounded by the node count, which a cycle exceeds.
 */
export function validateHierarchy(nodes: HNode[]): string[] {
  const errors: string[] = [];
  const byId = new Map<string, HNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    else byId.set(node.id, node);
  }

  const roots = nodes.filter((node) => node.parent === null);
  if (roots.length !== 1) errors.push(`Expected exactly one root, found ${roots.length}`);

  for (const node of nodes) {
    if (node.parent !== null && !byId.has(node.parent)) {
      errors.push(`Node ${node.id} has missing parent ${node.parent}`);
    }
  }

  const reported = new Set<string>();
  for (const node of byId.values()) {
    let current: HNode | undefined = node;
    const seen = new Set<string>();
    while (current && current.parent !== null) {
      if (seen.has(current.id)) {
        if (!reported.has(current.id)) {
          errors.push(`Cycle detected at node ${current.id}`);
          for (const id of seen) reported.add(id);
        }
        break;
      }
      seen.add(current.id);
      current = byId.get(current.parent);
    }
  }
  return errors;
}

/** Direct children of a node, in input order. */
export function children(nodes: HNode[], id: string): HNode[] {
  return nodes.filter((node) => node.parent === id);
}

/** Leaves at or below a node: nodes with no children. */
export function leavesOf(nodes: HNode[], id: string): HNode[] {
  const kids = children(nodes, id);
  if (kids.length === 0) {
    const self = nodes.find((node) => node.id === id);
    return self ? [self] : [];
  }
  return kids.flatMap((kid) => leavesOf(nodes, kid.id));
}

/** The node and its ancestors, root first. Empty for an unknown id. */
export function pathTo(nodes: HNode[], id: string): HNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out: HNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    out.unshift(current);
    seen.add(current.id);
    current = current.parent === null ? undefined : byId.get(current.parent);
  }
  return out;
}

// ─── Picking a node ──────────────────────────────────────────────────

/** A filter path: level and roll-up parameters to a value, null when unset. */
export type NodeSelectionPath = Partial<Record<string, string | null>>;

function rootOf(tree: HierarchyDef): string {
  return tree.nodes?.find((node) => node.parent === null)?.id ?? tree.id;
}

/**
 * The node a path selects in a tree: its deepest set level, matched by label
 * and by any set ancestors. A path that names a product without its category (a
 * deep link) still finds the product. Unmatched paths resolve to the root.
 */
export function selectedNodeId(tree: HierarchyDef, path: NodeSelectionPath): string {
  const nodes = tree.nodes ?? [];
  const columns = tree.levels.map((entry) => entry.column);
  let deepest = -1;
  columns.forEach((column, index) => {
    if (path[column]) deepest = index;
  });
  if (deepest < 0 || nodes.length === 0) return rootOf(tree);
  for (const candidate of nodes) {
    if (candidate.label !== path[columns[deepest]]) continue;
    const trail = pathTo(nodes, candidate.id);
    if (trail.length !== deepest + 2) continue;
    if (columns.slice(0, deepest).every((column, index) => !path[column] || trail[index + 1].label === path[column])) {
      return candidate.id;
    }
  }
  return rootOf(tree);
}

/**
 * The path after choosing `nodeId` in `tree`: this dimension's levels are
 * rewritten from the node's ancestry (so anything below it is cleared), the
 * roll-up becomes that tree (omitted when it is the default), and the other
 * dimensions are untouched because they are orthogonal to this one.
 */
export function selectNode(path: NodeSelectionPath, tree: HierarchyDef, nodeId: string, catalogue: HierarchyDef[] = FALLBACK_CATALOGUE): NodeSelectionPath {
  const dimension = tree.dimension as RollupDimension;
  const next: NodeSelectionPath = { ...path };
  for (const level of PATH_LEVELS) if (DIMENSION_OF[level] === dimension) next[level] = null;
  pathTo(tree.nodes ?? [], nodeId).slice(1).forEach((node, index) => {
    const column = tree.levels[index]?.column;
    if (column) next[column] = node.label;
  });
  next[ROLLUP_PARAM[dimension]] = tree.id === defaultHierarchyId(dimension, catalogue) ? null : tree.id;
  return next;
}
