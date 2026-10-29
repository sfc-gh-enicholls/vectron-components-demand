import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/snowflake";
import { getContext, getIntegrity } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import {
  hierarchyPredicate,
  parseHierarchyPath,
  pickLevels,
} from "@/lib/hierarchy-path";

export const dynamic = "force-dynamic";

const NPD_LEVELS = ["CATEGORY_NAME", "PRODUCT_NAME"] as const;

// Launch products with their category. V_NPD_TRACKING has no category, so it comes
// from APP.V_SERIES (all of a product's series share one). The option lists and the
// launch cards both read this, so the filter never offers a product with no launch.
const LAUNCH_SCOPE = `(
  SELECT DISTINCT t.PRODUCT_ID, t.PRODUCT_NAME, s.CATEGORY_NAME
  FROM APP.V_NPD_TRACKING t
  LEFT JOIN APP.V_SERIES s
    ON s.PRODUCT_ID = t.PRODUCT_ID
  WHERE t.LAUNCH_WEEK_ID IS NOT NULL
)`;

interface LaunchSummaryRow {
  PRODUCT_ID: string;
  PRODUCT_NAME: string;
  CATEGORY_NAME: string | null;
  LAUNCH_WEEK_ID: string;
  LIFECYCLE_STATUS: string;
  WEEKS_SINCE_LAUNCH: number;
  CUMULATIVE_UNITS: number;
}

interface AnalogueRow {
  NEW_PRODUCT_ID: string;
  NEW_PRODUCT_NAME: string;
  ANALOGUE_PRODUCT_ID: string;
  ANALOGUE_PRODUCT_NAME: string;
  SIMILARITY_SCORE: number;
  CANNIBALISATION_PCT: number;
  RATIONALE: string | null;
  ANALOGUE_LAUNCH_WEEK_ID: string | null;
  ANALOGUE_LIFECYCLE_STATUS: string | null;
}

interface LaunchCurveRow {
  WEEKS_SINCE_LAUNCH: number;
  UNITS: number;
}

interface ProductActualRow {
  PRODUCT_ID: string;
  PRODUCT_NAME: string;
  LAUNCH_WEEK_ID: string | null;
  WEEK_ID: string;
  WEEK_START_DATE: string;
  UNITS: number;
}

interface RecentWeekRow {
  WEEK_ID: string;
}

interface PhaseOutActualRow {
  PRODUCT_ID: string;
  PRODUCT_NAME: string;
  LIFECYCLE_STATUS: string;
  DELIST_WEEK_ID: string | null;
  WEEK_ID: string;
  UNITS: number;
}

function placeholderList(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await getContext();
    const path = pickLevels(parseHierarchyPath(request.nextUrl.searchParams), NPD_LEVELS);
    const requestedProduct = path.PRODUCT_NAME ?? null;
    // Category narrows the launch cards; the product then picks one of them. Under
    // an alternate product roll-up its parent level (product family, price tier)
    // plays the category's part.
    const launchPath = pickLevels(path, ["CATEGORY_NAME"]);
    if (path.PRODUCT_LINE) launchPath.PRODUCT_LINE = path.PRODUCT_LINE;
    if (path.PRICE_TIER) launchPath.PRICE_TIER = path.PRICE_TIER;
    const launchPredicate = hierarchyPredicate(launchPath, "l");
    const phaseOutPredicate = hierarchyPredicate(path, "s");

    const [hierarchyOptions, launchSummaryRows, analogueRows, recentWeeks, phaseOutActuals, integrity] = await Promise.all([
      loadHierarchyOptions(LAUNCH_SCOPE, path, NPD_LEVELS),
      query<LaunchSummaryRow>(
        `WITH weekly AS (
           SELECT
             t.PRODUCT_ID,
             t.PRODUCT_NAME,
             l.CATEGORY_NAME,
             t.LAUNCH_WEEK_ID,
             t.LIFECYCLE_STATUS,
             t.WEEKS_SINCE_LAUNCH,
             MAX(t.UNITS) AS WEEKLY_UNITS
           FROM APP.V_NPD_TRACKING t
           JOIN ${LAUNCH_SCOPE} l
             ON l.PRODUCT_ID = t.PRODUCT_ID
           WHERE t.LAUNCH_WEEK_ID IS NOT NULL
             AND ${launchPredicate.sql}
           GROUP BY 1, 2, 3, 4, 5, 6
         )
         SELECT
           PRODUCT_ID,
           PRODUCT_NAME,
           CATEGORY_NAME,
           LAUNCH_WEEK_ID,
           LIFECYCLE_STATUS,
           MAX(WEEKS_SINCE_LAUNCH) AS WEEKS_SINCE_LAUNCH,
           SUM(WEEKLY_UNITS) AS CUMULATIVE_UNITS
         FROM weekly
         GROUP BY 1, 2, 3, 4, 5
         ORDER BY LAUNCH_WEEK_ID, PRODUCT_NAME`,
        launchPredicate.binds,
      ),
      query<AnalogueRow>(
        `SELECT
           n.NEW_PRODUCT_ID,
           nb.PRODUCT_NAME AS NEW_PRODUCT_NAME,
           n.ANALOGUE_PRODUCT_ID,
           ab.PRODUCT_NAME AS ANALOGUE_PRODUCT_NAME,
           n.SIMILARITY_SCORE,
           n.CANNIBALISATION_PCT,
           n.RATIONALE,
           ab.LAUNCH_WEEK_ID AS ANALOGUE_LAUNCH_WEEK_ID,
           ab.LIFECYCLE_STATUS AS ANALOGUE_LIFECYCLE_STATUS
         FROM CORE.NPD_ANALOGUE n
         JOIN CORE.DIM_PRODUCT nb
           ON nb.PRODUCT_ID = n.NEW_PRODUCT_ID
         JOIN CORE.DIM_PRODUCT ab
           ON ab.PRODUCT_ID = n.ANALOGUE_PRODUCT_ID
         LEFT JOIN ${LAUNCH_SCOPE} l
           ON l.PRODUCT_ID = n.NEW_PRODUCT_ID
         WHERE ${launchPredicate.sql}
         ORDER BY nb.PRODUCT_NAME, n.SIMILARITY_SCORE DESC, ab.PRODUCT_NAME`,
        launchPredicate.binds,
      ),
      query<RecentWeekRow>(
        `SELECT WEEK_ID
         FROM APP.V_WEEK_INDEX
         WHERE WEEKS_AGO <= 25
         ORDER BY WEEK_START_DATE`,
      ),
      query<PhaseOutActualRow>(
        `SELECT
           s.PRODUCT_ID,
           s.PRODUCT_NAME,
           s.LIFECYCLE_STATUS,
           s.DELIST_WEEK_ID,
           p.WEEK_ID,
           SUM(p.UNITS) AS UNITS
         FROM CORE.FACT_POS_WEEKLY p
         JOIN APP.V_SERIES s
           ON s.SERIES_ID = p.SERIES_ID
         JOIN APP.V_WEEK_INDEX wi
           ON wi.WEEK_ID = p.WEEK_ID
         WHERE wi.WEEKS_AGO <= 25
           AND (
             s.DELIST_WEEK_ID IS NOT NULL
             OR s.LIFECYCLE_STATUS = ?
           )
           AND ${phaseOutPredicate.sql}
         GROUP BY 1, 2, 3, 4, 5
         ORDER BY s.PRODUCT_NAME, p.WEEK_ID`,
        ["Decline", ...phaseOutPredicate.binds],
      ),
      getIntegrity(),
    ]);

    const analoguesByLaunch = new Map<string, AnalogueRow[]>();
    for (const row of analogueRows) {
      const list = analoguesByLaunch.get(row.NEW_PRODUCT_ID) ?? [];
      list.push(row);
      analoguesByLaunch.set(row.NEW_PRODUCT_ID, list);
    }

    const categoryLaunches = launchSummaryRows.map((row) => ({
      productId: row.PRODUCT_ID,
      productName: row.PRODUCT_NAME,
      categoryName: row.CATEGORY_NAME,
      launchWeekId: row.LAUNCH_WEEK_ID,
      lifecycleStatus: row.LIFECYCLE_STATUS,
      weeksSinceLaunch: Number(row.WEEKS_SINCE_LAUNCH) || 0,
      cumulativeUnits: Number(row.CUMULATIVE_UNITS) || 0,
      analogues: (analoguesByLaunch.get(row.PRODUCT_ID) ?? []).map((analogue) => ({
        analogueProductId: analogue.ANALOGUE_PRODUCT_ID,
        analogueProductName: analogue.ANALOGUE_PRODUCT_NAME,
        similarityScore: Number(analogue.SIMILARITY_SCORE) || 0,
        cannibalisationPct: Number(analogue.CANNIBALISATION_PCT) || 0,
        rationale: analogue.RATIONALE,
        analogueLaunchWeekId: analogue.ANALOGUE_LAUNCH_WEEK_ID,
        analogueLifecycleStatus: analogue.ANALOGUE_LIFECYCLE_STATUS,
      })),
    }));

    // A product that is not a launch in the selected category is an empty scope, so
    // no cards are offered rather than launches that sit outside it.
    const launches = requestedProduct && !categoryLaunches.some((launch) => launch.productName === requestedProduct)
      ? []
      : categoryLaunches;
    const selectedLaunch = (requestedProduct
      ? launches.find((launch) => launch.productName === requestedProduct)
      : launches[0]) ?? null;

    const rationaleRows = analogueRows
      .filter((row) => !requestedProduct || row.NEW_PRODUCT_NAME === requestedProduct)
      .map((row) => ({
        newProductId: row.NEW_PRODUCT_ID,
        newProductName: row.NEW_PRODUCT_NAME,
        analogueProductId: row.ANALOGUE_PRODUCT_ID,
        analogueProductName: row.ANALOGUE_PRODUCT_NAME,
        similarityScore: Number(row.SIMILARITY_SCORE) || 0,
        cannibalisationPct: Number(row.CANNIBALISATION_PCT) || 0,
        rationale: row.RATIONALE,
      }));

    const recentWeekIds = recentWeeks.map((row) => row.WEEK_ID);
    const phaseOutByProduct = new Map<string, {
      productId: string;
      productName: string;
      lifecycleStatus: string;
      delistWeekId: string | null;
      weeklyUnits: Map<string, number>;
    }>();

    for (const row of phaseOutActuals) {
      let entry = phaseOutByProduct.get(row.PRODUCT_ID);
      if (!entry) {
        entry = {
          productId: row.PRODUCT_ID,
          productName: row.PRODUCT_NAME,
          lifecycleStatus: row.LIFECYCLE_STATUS,
          delistWeekId: row.DELIST_WEEK_ID,
          weeklyUnits: new Map<string, number>(),
        };
        phaseOutByProduct.set(row.PRODUCT_ID, entry);
      }
      entry.weeklyUnits.set(row.WEEK_ID, Number(row.UNITS) || 0);
    }

    const phaseOut = Array.from(phaseOutByProduct.values())
      .map((product) => {
        const sparkline = recentWeekIds.map((weekId) => product.weeklyUnits.get(weekId) ?? 0);
        const recent13 = sparkline.slice(-13).reduce((sum, value) => sum + value, 0);
        const prior13 = sparkline.slice(0, Math.max(sparkline.length - 13, 0)).reduce((sum, value) => sum + value, 0);
        return {
          productId: product.productId,
          productName: product.productName,
          lifecycleStatus: product.lifecycleStatus,
          delistWeekId: product.delistWeekId,
          sparkline,
          latestWeekUnits: sparkline[sparkline.length - 1] ?? 0,
          recent13Units: recent13,
          prior13Units: prior13,
          recentDelta: prior13 > 0 ? recent13 / prior13 - 1 : null,
        };
      })
      .sort((left, right) => right.recent13Units - left.recent13Units);

    if (!selectedLaunch) {
      return NextResponse.json({
        context: ctx,
        filters: { path },
        options: { hierarchy: hierarchyOptions },
        launches,
        selectedProductId: null,
        selectedProductName: null,
        selectedLaunch: null,
        selectedByDefault: false,
        curveComparisons: [],
        cannibalisation: [],
        rationaleRows,
        phaseOut,
        integrity,
      });
    }

    const selectedAnalogueRows = analoguesByLaunch.get(selectedLaunch.productId) ?? [];
    const analogueProductIds = Array.from(new Set(selectedAnalogueRows.map((row) => row.ANALOGUE_PRODUCT_ID)));

    const [launchCurveRows, analogueActualRows] = await Promise.all([
      query<LaunchCurveRow>(
        `SELECT
           WEEKS_SINCE_LAUNCH,
           MAX(UNITS) AS UNITS
         FROM APP.V_NPD_TRACKING
         WHERE PRODUCT_ID = ?
         GROUP BY 1
         ORDER BY 1`,
        [selectedLaunch.productId],
      ),
      analogueProductIds.length > 0
        ? query<ProductActualRow>(
            `SELECT
               s.PRODUCT_ID,
               b.PRODUCT_NAME,
               b.LAUNCH_WEEK_ID,
               w.WEEK_ID,
               w.WEEK_START_DATE,
               SUM(p.UNITS) AS UNITS
             FROM CORE.FACT_POS_WEEKLY p
             JOIN CORE.DIM_SERIES s
               ON s.SERIES_ID = p.SERIES_ID
             JOIN CORE.DIM_PRODUCT b
               ON b.PRODUCT_ID = s.PRODUCT_ID
             JOIN CORE.DIM_WEEK w
               ON w.WEEK_ID = p.WEEK_ID
             WHERE s.PRODUCT_ID IN (${placeholderList(analogueProductIds.length)})
             GROUP BY 1, 2, 3, 4, 5
             ORDER BY s.PRODUCT_ID, w.WEEK_START_DATE`,
            analogueProductIds,
          )
        : Promise.resolve([] as ProductActualRow[]),
    ]);

    const launchCurve = launchCurveRows.map((row) => ({
      weeksSinceLaunch: Number(row.WEEKS_SINCE_LAUNCH) || 0,
      units: Number(row.UNITS) || 0,
    }));

    const analogueActualsByProduct = new Map<string, ProductActualRow[]>();
    for (const row of analogueActualRows) {
      const list = analogueActualsByProduct.get(row.PRODUCT_ID) ?? [];
      list.push({
        ...row,
        UNITS: Number(row.UNITS) || 0,
      });
      analogueActualsByProduct.set(row.PRODUCT_ID, list);
    }

    const curveComparisons = selectedAnalogueRows.map((analogue) => {
      const fullHistory = analogueActualsByProduct.get(analogue.ANALOGUE_PRODUCT_ID) ?? [];
      const referenceHistory = analogue.ANALOGUE_LAUNCH_WEEK_ID
        ? fullHistory.filter((row) => row.WEEK_ID >= analogue.ANALOGUE_LAUNCH_WEEK_ID!)
        : fullHistory;
      const comparisonWindow = referenceHistory.slice(0, launchCurve.length);
      const baseWindow = referenceHistory.slice(0, Math.min(13, referenceHistory.length));
      const baseAverage = baseWindow.length > 0
        ? baseWindow.reduce((sum, row) => sum + row.UNITS, 0) / baseWindow.length
        : 0;

      return {
        analogueProductId: analogue.ANALOGUE_PRODUCT_ID,
        analogueProductName: analogue.ANALOGUE_PRODUCT_NAME,
        similarityScore: Number(analogue.SIMILARITY_SCORE) || 0,
        cannibalisationPct: Number(analogue.CANNIBALISATION_PCT) || 0,
        rationale: analogue.RATIONALE,
        referenceType: analogue.ANALOGUE_LAUNCH_WEEK_ID ? "launch" : "earliest_observed",
        referenceStartWeekId: comparisonWindow[0]?.WEEK_ID ?? null,
        baseAverage13: baseAverage,
        baseWindowWeeks: baseWindow.length,
        points: launchCurve.map((point, index) => {
          const referencePoint = comparisonWindow[index];
          return {
            weeksSinceLaunch: point.weeksSinceLaunch,
            launchUnits: point.units,
            launchIndex: baseAverage > 0 ? (point.units / baseAverage) * 100 : null,
            analogueUnits: referencePoint ? referencePoint.UNITS : null,
            analogueIndex: referencePoint && baseAverage > 0 ? (referencePoint.UNITS / baseAverage) * 100 : null,
            analogueWeekId: referencePoint?.WEEK_ID ?? null,
          };
        }),
      };
    });

    const cannibalisation = selectedAnalogueRows.map((analogue) => {
      const grossLaunchUnits = selectedLaunch.cumulativeUnits;
      const cannibalisationPct = Number(analogue.CANNIBALISATION_PCT) || 0;
      const cannibalisedUnits = grossLaunchUnits * cannibalisationPct;
      return {
        analogueProductId: analogue.ANALOGUE_PRODUCT_ID,
        analogueProductName: analogue.ANALOGUE_PRODUCT_NAME,
        similarityScore: Number(analogue.SIMILARITY_SCORE) || 0,
        cannibalisationPct,
        grossLaunchUnits,
        cannibalisedUnits,
        incrementalUnits: grossLaunchUnits - cannibalisedUnits,
        rationale: analogue.RATIONALE,
      };
    });

    return NextResponse.json({
      context: ctx,
      filters: { path },
      options: { hierarchy: hierarchyOptions },
      launches,
      selectedProductId: selectedLaunch.productId,
      selectedProductName: selectedLaunch.productName,
      selectedLaunch,
      selectedByDefault: !requestedProduct,
      curveComparisons,
      cannibalisation,
      rationaleRows,
      phaseOut,
      integrity,
    });
  } catch (err) {
    console.error("npd route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load NPD" },
      { status: 500 },
    );
  }
}