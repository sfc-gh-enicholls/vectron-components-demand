/**
 * Cascading option lists for the hierarchy filter, built server-side.
 *
 * WHY THIS IS SHARED
 * ------------------
 * Each route used to build its own option lists, and they drifted. One returned
 * `{ categories, products, customers, channels }` while the client component reads
 * `options.CATEGORY_NAME` etc., so its dropdowns offered nothing but "All"; the
 * API still filtered correctly when called with query parameters, which is how
 * the bug survived testing. Another cascaded only product on category, so customers
 * a product does not sell in stayed on offer. One function, returning exactly the
 * client's `HierarchyOptions` shape, removes both failure modes.
 *
 * Kept apart from `hierarchy-path.ts` so that file stays free of the Snowflake
 * driver and remains unit-testable without a connection.
 *
 * CASCADE RULE
 * ------------
 * Each level's list is narrowed by the selected levels ABOVE it, and never by
 * itself or the levels below. So the product list under Cognac shows every Cognac
 * product, not only the one already chosen, and a planner can move sideways
 * (switch product within the category) without first resetting to All.
 */

import { LEAF_OF, isAltLevel, type AltLevel, type PathLevel } from "@/lib/dimensions";
import {
  HIERARCHY_LEVELS,
  hierarchyPredicate,
  pathLevelOrder,
  type HierarchyLevelName,
  type HierarchyPathServer,
} from "@/lib/hierarchy-path";
import { query } from "@/lib/snowflake";

/** Same shape as the client's `HierarchyOptions`. */
export type HierarchyOptionsServer = Partial<Record<PathLevel, string[]>>;

/**
 * The selected levels a level's list is narrowed by: those before it in the
 * path's drill order. A level outside the drill order (a category under a
 * product-family roll-up) keeps the original four-level rule.
 */
function aboveFor(level: PathLevel, path: HierarchyPathServer, order: PathLevel[]): HierarchyPathServer {
  const parents: readonly PathLevel[] = order.includes(level)
    ? order.slice(0, order.indexOf(level))
    : HIERARCHY_LEVELS.slice(0, HIERARCHY_LEVELS.indexOf(level as HierarchyLevelName));
  const above: HierarchyPathServer = {};
  for (const parent of parents) {
    if (path[parent]) above[parent] = path[parent];
  }
  return above;
}

type OptionRow = { OPTION_VALUE: string };

/**
 * Load the option list for each requested level.
 *
 * `source` is a view or parenthesised subquery exposing the level columns. It is
 * interpolated into SQL, so it MUST be a constant written in the route, never
 * anything derived from the request. The selected values themselves are always
 * bound, never interpolated.
 *
 * Pass the page's OWN data universe as the source rather than `APP.V_SERIES`
 * when the page covers a subset of the portfolio: offering a product that has no
 * rows on this page would let a planner select an empty screen.
 *
 * Levels not listed in `levels` are omitted from the result, which is what a
 * page that honours only some levels wants.
 *
 * When the path picks an alternate roll-up, that tree's alternate levels are
 * listed too, read off APP.V_SERIES through the leaf column — but only where
 * the leaf is among `levels`, since the source must carry it to be joined.
 * With default roll-ups the queries and result are exactly the four-level ones.
 */
export async function loadHierarchyOptions(
  source: string,
  path: HierarchyPathServer,
  levels: readonly HierarchyLevelName[] = HIERARCHY_LEVELS,
): Promise<HierarchyOptionsServer> {
  const order = pathLevelOrder(path);
  const altLevels = order.filter(
    (level): level is AltLevel => isAltLevel(level) && levels.includes(LEAF_OF[level]),
  );
  const entries = await Promise.all([
    ...levels.map(async (level) => {
      const predicate = hierarchyPredicate(aboveFor(level, path, order), "o");
      const rows = await query<OptionRow>(
        `SELECT DISTINCT o.${level} AS OPTION_VALUE
         FROM ${source} o
         WHERE o.${level} IS NOT NULL
           AND ${predicate.sql}
         ORDER BY OPTION_VALUE`,
        predicate.binds,
      );
      return [level, rows.map((row) => row.OPTION_VALUE)] as const;
    }),
    ...altLevels.map(async (level) => {
      const leaf = LEAF_OF[level];
      const predicate = hierarchyPredicate(aboveFor(level, path, order), "o");
      const rows = await query<OptionRow>(
        `SELECT DISTINCT v.${level} AS OPTION_VALUE
         FROM ${source} o
         JOIN APP.V_SERIES v ON v.${leaf} = o.${leaf}
         WHERE v.${level} IS NOT NULL
           AND ${predicate.sql}
         ORDER BY OPTION_VALUE`,
        predicate.binds,
      );
      return [level, rows.map((row) => row.OPTION_VALUE)] as const;
    }),
  ]);
  return Object.fromEntries(entries) as HierarchyOptionsServer;
}
