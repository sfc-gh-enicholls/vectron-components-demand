/**
 * The dimension hierarchies as Snowflake holds them, loaded once per process.
 *
 * WHY VALIDATE ON LOAD
 * --------------------
 * The app trusts the catalogue to describe trees: a roll-up drills level by
 * level and an edit at any node is spread to the leaves beneath it. A node list
 * with two roots, an orphan or a cycle would make "the leaves beneath it"
 * ambiguous, and the planner would see numbers that do not add up. Snowflake
 * carries the same checks (V_INTEGRITY_HIERARCHIES), but those report; this
 * refuses. Every tree's nodes are run through `validateHierarchy` and the load
 * throws on the first tree that fails, so a broken tree is an error page, never
 * a wrong total.
 *
 * WHY CACHE IN MODULE MEMORY
 * --------------------------
 * The trees change only when snowflake/16-hierarchies.sql is re-run, and the
 * node table runs to hundreds of rows for time alone. Reading it on every
 * request would be waste; a failed load is not cached, so the next request
 * retries.
 */
import {
  validateHierarchy,
  type Dimension,
  type HierarchyDef,
  type HNode,
} from "@/lib/dimensions";
import { query } from "@/lib/snowflake";

interface HierarchyRow {
  HIERARCHY_ID: string;
  DIMENSION: Dimension;
  HIERARCHY_NAME: string;
  DESCRIPTION: string | null;
  IS_DEFAULT: boolean;
  SORT_ORDER: number;
  ROOT_LABEL: string;
  LEVEL_NO: number;
  LEVEL_COLUMN: string;
  LEVEL_LABEL: string;
  ALL_LABEL: string;
  IS_LEAF: boolean;
  NODE_COUNT: number;
}

interface NodeRow {
  HIERARCHY_ID: string;
  NODE_ID: string;
  PARENT_NODE_ID: string | null;
  NODE_LABEL: string;
}

const DIMENSION_ORDER: Dimension[] = ["PRODUCT", "CUSTOMER", "CHANNEL", "TIME"];

let cache: Promise<HierarchyDef[]> | null = null;

async function load(): Promise<HierarchyDef[]> {
  const [rows, nodeRows] = await Promise.all([
    query<HierarchyRow>(
      `SELECT HIERARCHY_ID, DIMENSION, HIERARCHY_NAME, DESCRIPTION, IS_DEFAULT, SORT_ORDER,
              ROOT_LABEL, LEVEL_NO, LEVEL_COLUMN, LEVEL_LABEL, ALL_LABEL, IS_LEAF, NODE_COUNT
       FROM APP.V_HIERARCHY
       ORDER BY SORT_ORDER, HIERARCHY_ID, LEVEL_NO`,
    ),
    query<NodeRow>(
      `SELECT HIERARCHY_ID, NODE_ID, PARENT_NODE_ID, NODE_LABEL
       FROM CORE.DIM_HIERARCHY_NODE`,
    ),
  ]);

  const nodesByTree = new Map<string, HNode[]>();
  for (const row of nodeRows) {
    const list = nodesByTree.get(row.HIERARCHY_ID) ?? [];
    list.push({ id: row.NODE_ID, label: row.NODE_LABEL, parent: row.PARENT_NODE_ID ?? null });
    nodesByTree.set(row.HIERARCHY_ID, list);
  }

  const trees = new Map<string, HierarchyDef & { sortOrder: number }>();
  for (const row of rows) {
    const tree = trees.get(row.HIERARCHY_ID) ?? {
      id: row.HIERARCHY_ID,
      dimension: row.DIMENSION,
      name: row.HIERARCHY_NAME,
      description: row.DESCRIPTION ?? null,
      isDefault: Boolean(row.IS_DEFAULT),
      rootLabel: row.ROOT_LABEL,
      levels: [],
      sortOrder: Number(row.SORT_ORDER) || 0,
    };
    tree.levels.push({
      column: row.LEVEL_COLUMN,
      label: row.LEVEL_LABEL,
      allLabel: row.ALL_LABEL,
      isLeaf: Boolean(row.IS_LEAF),
      nodeCount: Number(row.NODE_COUNT) || 0,
    });
    trees.set(row.HIERARCHY_ID, tree);
  }

  for (const tree of trees.values()) {
    const errors = validateHierarchy(nodesByTree.get(tree.id) ?? []);
    if (errors.length > 0) {
      throw new Error(`Hierarchy ${tree.id} is not a valid tree: ${errors.slice(0, 5).join("; ")}`);
    }
  }

  return Array.from(trees.values())
    .sort((left, right) =>
      DIMENSION_ORDER.indexOf(left.dimension) - DIMENSION_ORDER.indexOf(right.dimension)
      || left.sortOrder - right.sortOrder)
    .map(({ sortOrder: _sortOrder, ...tree }) =>
      // Nodes go to the client so each dimension can be picked as a tree. Time
      // keeps its fixed week bucketing and is not picked, so its ~400 nodes stay
      // server-side.
      tree.dimension === "TIME" ? tree : { ...tree, nodes: nodesByTree.get(tree.id) ?? [] });
}

/** Every hierarchy, grouped by dimension in product, customer, channel, time order. */
export async function loadHierarchyCatalogue(): Promise<HierarchyDef[]> {
  if (!cache) {
    cache = load().catch((err) => {
      cache = null;
      throw err;
    });
  }
  return cache;
}
