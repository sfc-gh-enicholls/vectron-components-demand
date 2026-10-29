import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/snowflake";
import { getContext } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import { LEVEL_LABELS, PATH_LEVELS, leafOf, type PathLevel } from "@/lib/dimensions";
import {
  hierarchyLabel,
  hierarchyPredicate,
  parseHierarchyPath,
  pickLevels,
  type HierarchyLevelName,
  type HierarchyPathServer,
} from "@/lib/hierarchy-path";

/**
 * Demand sensing, 0-8 weeks.
 *
 * Two distinct things are surfaced here and they should not be conflated:
 *
 *   SIGNALS are divergences already visible in completed actuals that the
 *   forward plan does not yet reflect. They are evidence.
 *
 *   UPCOMING EVENTS are known-in-advance calendar facts. They are not
 *   evidence of anything, but they are where phasing error concentrates,
 *   because a moveable feast lands in a different ISO week each year.
 *
 * The hierarchy path scopes the signals at all four levels. The side panels
 * come from coarser sources (events and weather per customer, competitor
 * activity per customer and category), so each honours only the levels its
 * source carries and reports in `panels` which selected levels it could not.
 */
export const dynamic = "force-dynamic";

/** Cap on the ranked signal list. The severity and type counts are not capped. */
const SIGNAL_LIMIT = 150;

const EVENT_LEVELS = ["CUSTOMER_NAME"] as const;
const WEATHER_LEVELS = ["CUSTOMER_NAME"] as const;
const COMPETITOR_LEVELS = ["CATEGORY_NAME", "CUSTOMER_NAME"] as const;

const LEVEL_NOUN: Record<HierarchyLevelName, string> = {
  CATEGORY_NAME: "category",
  PRODUCT_NAME: "product",
  CUSTOMER_NAME: "customer",
  CHANNEL_NAME: "channel",
};

/** "product", "category or product", "category, product or channel". Alternate levels use their label. */
function listLevels(levels: PathLevel[]): string {
  const nouns = levels.map((level) => (level in LEVEL_NOUN ? LEVEL_NOUN[level as HierarchyLevelName] : LEVEL_LABELS[level].toLowerCase()));
  return nouns.length > 1
    ? `${nouns.slice(0, -1).join(", ")} or ${nouns.at(-1)}`
    : (nouns[0] ?? "");
}

/**
 * What a side panel did with the selected path. A panel whose source cannot
 * honour a selected level must not read as scoped, so the note says which
 * levels were applied and which were not, and why. Null at the root.
 */
function panelScope(
  path: HierarchyPathServer,
  levels: readonly HierarchyLevelName[],
  basis: string,
) {
  const applied = pickLevels(path, levels);
  // An alternate level is applied when its leaf is, so it is ignored when not.
  const ignored = PATH_LEVELS.filter((level) => path[level] && !levels.includes(leafOf(level)));
  // ROLLUP_* keys ride along in `applied` but are not a filter.
  const isFiltered = PATH_LEVELS.some((level) => Boolean(applied[level]));
  let note: string | null = null;
  if (isFiltered && ignored.length === 0) {
    note = `Filtered to ${hierarchyLabel(applied)}.`;
  } else if (isFiltered) {
    note = `Filtered to ${hierarchyLabel(applied)} only — ${basis}, not per ${listLevels(ignored)}.`;
  } else if (ignored.length > 0) {
    note = `Portfolio-wide, not narrowed by the selected ${listLevels(ignored)} — ${basis}.`;
  }
  return { applied, ignored, note };
}

/**
 * Events carry CUSTOMER_SCOPE, a comma-separated list of customer ids or ALL,
 * rather than a customer name. The selected name is resolved to its id inside
 * the statement, bound rather than interpolated, and matched as a whole token:
 * a substring test is wrong because LIKE '%MKT-C%' also matches 'MKT-CN'.
 * STRTOK_TO_ARRAY splits on both comma and space, so padded lists tokenise
 * cleanly. Expects the event table aliased `e`. An alternate customer level
 * (region, route to customer, deliveryMode) resolves to its customers the same way.
 */
function eventScopePredicate(path: HierarchyPathServer): { sql: string; binds: string[] } {
  const customer = hierarchyPredicate(pickLevels(path, EVENT_LEVELS), "dm");
  if (customer.binds.length === 0) return { sql: "1=1", binds: [] };
  return {
    sql: `(ARRAY_CONTAINS('ALL'::VARIANT, STRTOK_TO_ARRAY(UPPER(e.CUSTOMER_SCOPE), ', '))
           OR ARRAYS_OVERLAP(
                (SELECT ARRAY_AGG(UPPER(dm.CUSTOMER_ID)) FROM CORE.DIM_CUSTOMER dm
                 WHERE ${customer.sql}),
                STRTOK_TO_ARRAY(UPPER(e.CUSTOMER_SCOPE), ', ')))`,
    binds: customer.binds,
  };
}

interface SignalRow {
  SERIES_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string;
  CUSTOMER_NAME: string;
  CHANNEL_NAME: string;
  CATEGORY_NAME: string;
  SEGMENT_ABC: string;
  BASE_ANNUAL_VALUE_EUR: number;
  SIGNAL_TYPE: string;
  SIGNAL_LABEL: string;
  DEVIATION: number;
  OBSERVED: number;
  EXPECTED: number;
  SEVERITY: string;
  SUGGESTED_ACTION: string;
}

export async function GET(request: NextRequest) {
  try {
    const path = parseHierarchyPath(request.nextUrl.searchParams);
    const ctx = await getContext();

    // The same predicate on the capped list and on the uncapped counts, so the
    // toggles always count the population the list is drawn from.
    const signalScope = hierarchyPredicate(path, "s");
    const eventScope = eventScopePredicate(path);
    const weatherScope = hierarchyPredicate(pickLevels(path, WEATHER_LEVELS), "mk");
    // Competitor rows reach customer and category through separate dimension
    // joins, so each level is bound against its own alias.
    const competitorPath = pickLevels(path, COMPETITOR_LEVELS);
    const competitorCustomer = hierarchyPredicate(pickLevels(competitorPath, ["CUSTOMER_NAME"]), "mk");
    const competitorCategory = hierarchyPredicate(pickLevels(competitorPath, ["CATEGORY_NAME"]), "cat");

    const [signals, byType, upcoming, phasing, weather, competitor, agentRows, hierarchyOptions] =
      await Promise.all([
        query<SignalRow>(
          `SELECT SERIES_ID, SERIES_LABEL, PRODUCT_NAME, CUSTOMER_NAME, CHANNEL_NAME,
                  CATEGORY_NAME, SEGMENT_ABC, BASE_ANNUAL_VALUE_EUR,
                  SIGNAL_TYPE, SIGNAL_LABEL, DEVIATION, OBSERVED, EXPECTED,
                  SEVERITY, SUGGESTED_ACTION
           FROM APP.V_SENSING_SIGNALS s
           WHERE ${signalScope.sql}
           ORDER BY CASE SEVERITY WHEN 'Critical' THEN 1 WHEN 'High' THEN 2
                                  WHEN 'Medium' THEN 3 ELSE 4 END,
                    ABS(DEVIATION) * BASE_ANNUAL_VALUE_EUR DESC
           LIMIT ${SIGNAL_LIMIT}`,
          signalScope.binds,
        ),
        query(
          `SELECT SIGNAL_TYPE, SEVERITY, COUNT(*) AS N,
                  SUM(BASE_ANNUAL_VALUE_EUR) AS VALUE_AT_RISK
           FROM APP.V_SENSING_SIGNALS s
           WHERE ${signalScope.sql}
           GROUP BY 1, 2`,
          signalScope.binds,
        ),
        // Events landing inside the sensing horizon
        query(
          `SELECT e.EVENT_NAME, e.EVENT_TYPE, e.EVENT_DATE, e.WEEK_ID,
                  e.CUSTOMER_SCOPE, e.LEAD_WEEKS, e.DESCRIPTION,
                  DATEDIFF(week, cw.WEEK_START_DATE, w.WEEK_START_DATE) AS WEEKS_AWAY
           FROM CORE.DIM_EVENT e
           JOIN CORE.DIM_WEEK w  ON w.WEEK_ID = e.WEEK_ID
           CROSS JOIN (SELECT WEEK_START_DATE FROM CORE.DIM_WEEK WHERE WEEK_ID = ?) cw
           WHERE e.EVENT_TYPE IN ('LUNAR', 'FESTIVAL')
             AND w.WEEK_START_DATE >= cw.WEEK_START_DATE
             AND ${eventScope.sql}
           ORDER BY e.EVENT_DATE
           LIMIT 8`,
          [ctx.CURRENT_WEEK, ...eventScope.binds],
        ),
        /*
         * The phasing exhibit. For each recurring moveable feast, the ISO week
         * it falls in per year. This is the single clearest argument for weekly
         * grain: Chinese New Year moves by up to three weeks between years, so
         * a monthly year-on-year comparison of the peak is meaningless.
         *
         * The family name is the event name with its trailing year stripped.
         * Splitting on spaces does not work: it produces "Chinese New" for a
         * four-word name and leaves two-word names like "Diwali 2026"
         * fragmented into one group per year.
         */
        query(
          `SELECT REGEXP_REPLACE(e.EVENT_NAME, '\\\\s+[0-9]{4}$', '') AS EVENT_SERIES,
                  e.EVENT_NAME, e.EVENT_DATE, e.WEEK_ID, w.ISO_WEEK,
                  MONTHNAME(e.EVENT_DATE) AS FALLS_IN_MONTH,
                  e.CUSTOMER_SCOPE
           FROM CORE.DIM_EVENT e
           JOIN CORE.DIM_WEEK w ON w.WEEK_ID = e.WEEK_ID
           WHERE e.EVENT_TYPE IN ('LUNAR', 'FESTIVAL')
             AND ${eventScope.sql}
           ORDER BY EVENT_SERIES, e.EVENT_DATE`,
          eventScope.binds,
        ),
        // Modelled exogenous inputs, most recent completed week
        query(
          `SELECT m.CUSTOMER_ID, mk.CUSTOMER_NAME, w.TEMP_ANOMALY_C,
                  w.IS_HEATWAVE, w.IS_COLDSNAP,
                  m.AUTO_SENTIMENT_IDX, m.TARIFF_INDEX,
                  m.FLEET_MILEAGE_IDX
           FROM CORE.FACT_MACRO_WEEKLY m
           JOIN CORE.FACT_WEATHER_WEEKLY w
             ON w.CUSTOMER_ID = m.CUSTOMER_ID AND w.WEEK_ID = m.WEEK_ID
           JOIN CORE.DIM_CUSTOMER mk ON mk.CUSTOMER_ID = m.CUSTOMER_ID
           WHERE m.WEEK_ID = ?
             AND ${weatherScope.sql}
           ORDER BY mk.CUSTOMER_NAME`,
          [ctx.HISTORY_END_WEEK, ...weatherScope.binds],
        ),
        query(
          `SELECT c.COMPETITOR, c.ACTIVITY_TYPE, c.INTENSITY,
                  mk.CUSTOMER_NAME, cat.CATEGORY_NAME, c.WEEK_ID
           FROM CORE.FACT_COMPETITOR_ACTIVITY c
           JOIN APP.V_WEEK_INDEX wi   ON wi.WEEK_ID = c.WEEK_ID
           JOIN CORE.DIM_CUSTOMER mk    ON mk.CUSTOMER_ID = c.CUSTOMER_ID
           JOIN CORE.DIM_CATEGORY cat ON cat.CATEGORY_ID = c.CATEGORY_ID
           WHERE wi.WEEKS_AGO <= 4 AND c.INTENSITY >= 0.6
             AND ${competitorCustomer.sql}
             AND ${competitorCategory.sql}
           ORDER BY c.INTENSITY DESC
           LIMIT 20`,
          [...competitorCustomer.binds, ...competitorCategory.binds],
        ),
        query<{
          SERIES_ID: string;
          PROPOSAL_ID: string;
          PRIORITY: string;
          PROPOSAL_TYPE: string;
          CONFIDENCE: number;
        }>(
          `SELECT SERIES_ID, PROPOSAL_ID, PRIORITY, PROPOSAL_TYPE, CONFIDENCE
           FROM APP.V_AGENT_QUEUE
           WHERE RUN_TYPE = ?
             AND STATUS = ?
             AND SERIES_ID IS NOT NULL
           QUALIFY ROW_NUMBER() OVER (
             PARTITION BY SERIES_ID
             ORDER BY CASE PRIORITY
                        WHEN 'Critical' THEN 1
                        WHEN 'High' THEN 2
                        WHEN 'Medium' THEN 3
                        ELSE 4
                      END,
                      ABS(DELTA_VALUE_EUR) DESC,
                      CONFIDENCE DESC
           ) = 1`,
          ["live", "proposed"],
        ),
        loadHierarchyOptions("APP.V_SENSING_SIGNALS", path),
      ]);

    const agentBySeries = new Map(
      agentRows.map((row) => [
        row.SERIES_ID,
        {
          proposalId: row.PROPOSAL_ID,
          priority: row.PRIORITY,
          proposalType: row.PROPOSAL_TYPE,
          confidence: Number(row.CONFIDENCE) || 0,
        },
      ]),
    );

    return NextResponse.json({
      context: ctx,
      scope: { path, label: hierarchyLabel(path) },
      options: { hierarchy: hierarchyOptions },
      signalLimit: SIGNAL_LIMIT,
      signals: signals.map((row) => ({
        ...row,
        agentRecommendation: agentBySeries.get(row.SERIES_ID) ?? null,
      })),
      byType,
      upcoming,
      phasing,
      weather,
      competitor,
      panels: {
        events: panelScope(path, EVENT_LEVELS, "the event calendar is set per customer"),
        weather: panelScope(path, WEATHER_LEVELS, "weather and macro inputs are measured per customer"),
        competitor: panelScope(
          path,
          COMPETITOR_LEVELS,
          "competitor activity is recorded per customer and category",
        ),
      },
      /*
       * Surfaced to the UI so the provenance caveat is carried by the data
       * rather than hardcoded in a component and liable to drift out of sync.
       */
      provenance: {
        modelledInputs: ["weather", "macro", "competitor"],
        note:
          "Weather, macro and competitor activity are modelled inputs with " +
          "realistic structure, not observed feeds. Signals derived from " +
          "OE pull, call-offs, aftermarket promotions and stock come from the " +
          "transactional data.",
      },
    });
  } catch (err) {
    console.error("sensing route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load sensing" },
      { status: 500 },
    );
  }
}
