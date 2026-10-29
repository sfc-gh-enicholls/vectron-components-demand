"use client";

/**
 * HierarchyFilter — the portfolio hierarchies, one tree picker per dimension.
 *
 * THE CONTROL
 * -----------
 * Product, customer and channel are each picked as a tree (DimensionPicker, the
 * Siemens IBP pattern): one trigger showing the chosen node and its trail, a
 * panel with the whole tree, and tabs for the dimension's alternate trees.
 * Under the hood a choice is still written as the PATH and roll-up described
 * below, so no route, query string or server contract changed when the flat
 * dropdowns were replaced. Choosing a node in an alternate tree is what sets
 * that dimension's roll-up.
 *
 * WHY THIS COMPONENT EXISTS
 * -------------------------
 * The hierarchy navigation was built inline on /plan and then NOT reused, so
 * /depletions, /maturation and /value each grew their own flat, unrelated
 * filters. A planner could pick a customer on one page and a category on another
 * with no sense of moving through one portfolio. Extracting it means a dropdown
 * added later cannot drift into a fifth variant of the same idea.
 *
 * THE MODEL: A PATH UNDER THE TREE
 * --------------------------------
 * The chosen nodes form a PATH through CATEGORY -> PRODUCT -> CUSTOMER -> CHANNEL
 * (or an alternate tree's levels), and the deepest non-empty level is the
 * selected node. A dimension at its root contributes nothing. That is the
 * same contract the hierarchy API already uses (NodePath in
 * src/app/api/hierarchy/shared.ts), so the server side needed no new concept.
 *
 * ROLL-UPS CHANGE THE PATH, NOT THE NUMBERS
 * -----------------------------------------
 * Each dimension can be drilled through an alternate tree — product family or
 * price tier for product, region or route to customer for customer, channel group
 * for channel (src/lib/dimensions.ts). The tabs in each picker offer them,
 * and the tree a node was chosen in becomes that dimension's roll-up. The leaves are the
 * same, so a total is the same whichever way it is rolled up. The default
 * trees reproduce the four original dropdowns exactly, and a default roll-up
 * is never written to the query string.
 *
 * CHILD RESET IS DELIBERATE
 * -------------------------
 * Choosing a node rewrites its dimension from the node's ancestry, so anything
 * below the old choice is cleared: a product
 * that belongs to the old category is not a valid descendant of the new one.
 * Without that, the path can express a node that does not exist and the server
 * quietly returns nothing. Other dimensions are not reset because customer and
 * channel are orthogonal to product in this portfolio: every product sells in
 * several customers and channels. Changing a dimension's roll-up clears every
 * selection in that dimension, since the old values belong to the old tree.
 *
 * LEVELS A PAGE CANNOT SUPPORT
 * ----------------------------
 * `enabledLevels` exists for the maturation page, where customer and channel are
 * genuinely meaningless: maturing liquid in cask is not allocated to a customer
 * until it is bottled. Offering those pickers there and silently ignoring them
 * would be worse than not offering them, so a page declares what it supports and
 * the component renders only that, with a stated reason. A dimension is shown
 * whenever its leaf level is enabled.
 */

import * as React from "react";
import { DimensionPicker } from "@/components/dimension-picker";
import { cn } from "@/lib/utils";
import {
  DIMENSION_OF,
  FALLBACK_CATALOGUE,
  PATH_LEVELS,
  ROLLUP_DIMENSIONS,
  hierarchiesFor,
  levelOrder,
  pathParams,
  pathTo,
  readRollups,
  rollupsToParams,
  selectNode,
  selectedNodeId,
  treeFor,
  type HierarchyDef,
  type PathLevel,
  type RollupDimension,
  type RollupParam,
  type Rollups,
} from "@/lib/dimensions";

export const ALL_VALUE = "__all__";

export type HierarchyLevel =
  | "CATEGORY_NAME" | "PRODUCT_NAME" | "CUSTOMER_NAME" | "CHANNEL_NAME";

export type { PathLevel } from "@/lib/dimensions";

/** The four levels, outermost first. Order is the default hierarchy. */
export const HIERARCHY_ORDER: HierarchyLevel[] = [
  "CATEGORY_NAME", "PRODUCT_NAME", "CUSTOMER_NAME", "CHANNEL_NAME",
];

export const HIERARCHY_LABELS: Record<HierarchyLevel, string> = {
  CATEGORY_NAME: "Category",
  PRODUCT_NAME: "Product",
  CUSTOMER_NAME: "Customer",
  CHANNEL_NAME: "Channel",
};

export type HierarchyPath = Partial<Record<PathLevel | RollupParam, string | null>>;

export type HierarchyOptions = Partial<Record<PathLevel, string[]>>;

export function toSelectValue(value: string | null | undefined): string {
  return value ?? ALL_VALUE;
}

export function fromSelectValue(value: string | null): string | null {
  return value === null || value === ALL_VALUE ? null : value;
}

/** The roll-ups a client path carries (non-default only). */
export function pathRollups(path: HierarchyPath): Rollups {
  return readRollups((key) => path[key]);
}

/** Path levels in this path's drill order. */
export function pathOrder(path: HierarchyPath): PathLevel[] {
  return levelOrder(pathRollups(path));
}

/**
 * The deepest level actually selected, or null at the root.
 * Stops at the first gap: a path with a category and a customer but no product is
 * a category-level selection filtered by customer, not a customer-level node.
 */
export function deepestLevel(path: HierarchyPath): PathLevel | null {
  let deepest: PathLevel | null = null;
  for (const level of pathOrder(path)) {
    if (!path[level]) break;
    deepest = level;
  }
  return deepest;
}

/** Human-readable breadcrumb, e.g. "Blended Scotch / Chivas Regal 12". */
export function pathLabel(path: HierarchyPath): string {
  const order = pathOrder(path);
  const parts = [...order, ...PATH_LEVELS.filter((level) => !order.includes(level))]
    .map((level) => path[level])
    .filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" / ") : "Total portfolio";
}

/**
 * Query-string pairs for the path, omitting empty levels and default roll-ups.
 * A path with only the four original levels yields exactly the pairs it always
 * did.
 */
export function pathToParams(path: HierarchyPath): Record<string, string> {
  return pathParams(path);
}

/**
 * "?ROLLUP_…=…" for a POST whose body carries a node key built under a
 * non-default roll-up, so the server reads the key in that drill order.
 * Empty under the defaults, leaving the URL exactly as it was.
 */
export function rollupQuery(path: HierarchyPath): string {
  const query = new URLSearchParams(rollupsToParams(pathRollups(path))).toString();
  return query ? `?${query}` : "";
}

// ─── Catalogue hook ──────────────────────────────────────────────────

let catalogueCache: HierarchyDef[] | null = null;
let cataloguePromise: Promise<HierarchyDef[]> | null = null;

function fetchCatalogue(): Promise<HierarchyDef[]> {
  if (!cataloguePromise) {
    cataloguePromise = fetch("/api/hierarchies")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok || !Array.isArray(json.hierarchies)) throw new Error(json.error ?? "Failed to load hierarchies");
        catalogueCache = json.hierarchies as HierarchyDef[];
        return catalogueCache;
      })
      .catch(() => {
        // Fall back for this page view; a later mount may try again.
        cataloguePromise = null;
        return FALLBACK_CATALOGUE;
      });
  }
  return cataloguePromise;
}

/**
 * The hierarchy catalogue from /api/hierarchies, fetched once per page load and
 * shared across every component that asks. Until it arrives (or if it fails)
 * the built-in copy is returned, which carries the same trees without counts.
 */
export function useHierarchyCatalogue(): { catalogue: HierarchyDef[]; loaded: boolean } {
  const [catalogue, setCatalogue] = React.useState<HierarchyDef[] | null>(catalogueCache);
  React.useEffect(() => {
    if (catalogueCache) return;
    let cancelled = false;
    void fetchCatalogue().then((result) => {
      if (!cancelled) setCatalogue(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { catalogue: catalogue ?? FALLBACK_CATALOGUE, loaded: Boolean(catalogue && catalogue !== FALLBACK_CATALOGUE) };
}

// ─── Component ───────────────────────────────────────────────────────

const DIMENSION_LABELS: Record<RollupDimension, string> = {
  PRODUCT: "Product",
  CUSTOMER: "Customer",
  CHANNEL: "Channel",
};

/** The leaf column of a dimension: what a plan is held at. */
const LEAF_COLUMN: Record<RollupDimension, PathLevel> = {
  PRODUCT: "PRODUCT_NAME",
  CUSTOMER: "CUSTOMER_NAME",
  CHANNEL: "CHANNEL_NAME",
};

export function HierarchyFilter({
  path,
  options,
  onChange,
  enabledLevels = HIERARCHY_ORDER,
  unsupportedNote,
  className,
}: {
  path: HierarchyPath;
  options: HierarchyOptions;
  onChange: (next: HierarchyPath) => void;
  /** Levels this page can actually honour. Dimensions without them are not rendered. */
  enabledLevels?: HierarchyLevel[];
  /** Shown when enabledLevels is a subset, to say why. */
  unsupportedNote?: string;
  className?: string;
}) {
  const { catalogue } = useHierarchyCatalogue();
  const rollups = pathRollups(path);

  // The leaves this page has, per dimension, so the tree offers only nodes with
  // data here. A page's option lists cascade (the product list narrows to the
  // chosen category), which would hide sibling branches once something in the
  // dimension is chosen, so the set is taken while the dimension is unselected
  // and kept. A deep link that arrives already selected offers the whole tree.
  const leafCache = React.useRef<Partial<Record<RollupDimension, Set<string>>>>({});
  const dimensions = ROLLUP_DIMENSIONS.filter((dimension) =>
    enabledLevels.includes(LEAF_COLUMN[dimension] as HierarchyLevel));
  for (const dimension of dimensions) {
    const list = options[LEAF_COLUMN[dimension]];
    const chosen = PATH_LEVELS.some((level) => DIMENSION_OF[level] === dimension && path[level]);
    if (!chosen && list && list.length > 0) leafCache.current[dimension] = new Set(list);
  }

  const allowedFor = React.useCallback((dimension: RollupDimension) => (tree: HierarchyDef): Set<string> | null => {
    const leaves = leafCache.current[dimension];
    const nodes = tree.nodes ?? [];
    if (!leaves || nodes.length === 0) return null;
    const parents = new Set(nodes.map((node) => node.parent));
    const offered = new Set<string>();
    for (const node of nodes) {
      if (parents.has(node.id) || !leaves.has(node.label)) continue;
      for (const step of pathTo(nodes, node.id)) offered.add(step.id);
    }
    return offered;
  }, []);

  return (
    <div className={className}>
      <div className={cn("grid gap-3", dimensions.length > 1 && "sm:grid-cols-2 md:grid-cols-3")}>
        {dimensions.map((dimension) => {
          const tree = treeFor(dimension, rollups, catalogue);
          return (
            <DimensionPicker
              key={dimension}
              label={DIMENSION_LABELS[dimension]}
              trees={hierarchiesFor(dimension, catalogue)}
              treeId={tree.id}
              nodeId={selectedNodeId(tree, path)}
              allowed={allowedFor(dimension)}
              onSelect={(chosenTree, node) => onChange(selectNode(path, chosenTree, node.id, catalogue))}
            />
          );
        })}
      </div>
      <p className="mt-2 text-xs text-text-tertiary">
        Viewing <span className="font-medium text-foreground">{pathLabel(path)}</span>
        {unsupportedNote ? <span> &mdash; {unsupportedNote}</span> : null}
      </p>
    </div>
  );
}
