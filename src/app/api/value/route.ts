import { NextRequest, NextResponse } from "next/server";
import { getContext } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import { query } from "@/lib/snowflake";
import {
  parseHierarchyPath, hierarchyPredicate, hierarchyLabel, pickLevels,
} from "@/lib/hierarchy-path";

export const dynamic = "force-dynamic";

const GROUP_LEVELS = [
  "Total",
  "Category",
  "Product",
  "Customer",
  "Technology tier",
  "Region",
  "Channel",
] as const;

/**
 * The landed-cost build-up is one category x customer cell, and the hierarchy
 * scope need not pin either half of it. Whatever the scope leaves open falls
 * back to these — the cell the tab opened on when it had its own selects — so
 * the root view is unchanged. The fallbacks behind them are in GET.
 */
const DEFAULT_LANDED_CATEGORY = "Brake systems";
const DEFAULT_LANDED_CUSTOMER = "Ford (EU & Mexico)";

type GroupLevel = (typeof GROUP_LEVELS)[number];

/**
 * Column that each breakout level groups by, in V_REVENUE_BRIDGE_BASE.
 *
 * 'Total' has no column: it is the whole scope in one row, so a literal is used.
 * Every value here comes from the GROUP_LEVELS allowlist, which is why these can
 * be interpolated into SQL — they are never user text.
 */
const GROUP_COLUMN: Record<GroupLevel, string> = {
  "Total": "'All products'",
  "Category": "b.CATEGORY_NAME",
  "Product": "b.PRODUCT_NAME",
  "Customer": "b.CUSTOMER_NAME",
  "Technology tier": "b.PRICE_TIER",
  "Region": "b.REGION",
  "Channel": "b.CHANNEL_NAME",
};

/**
 * Build the bridge for one breakout level, restricted to a hierarchy scope.
 *
 * WHY THIS RECOMPUTES INSTEAD OF FILTERING V_REVENUE_BRIDGE
 * ---------------------------------------------------------
 * V_REVENUE_BRIDGE is pre-aggregated per level over the WHOLE portfolio, and the
 * volume and mix effects both reference p0_bar — the base-period average price
 * OF THE GROUP BEING VIEWED. Narrow the population and p0_bar changes, so the
 * stored effects are no longer the right ones. Filtering the pre-aggregated view
 * would return effects computed against the unscoped average price, which would
 * break the identity volume + price + mix = revenue change.
 *
 * What IS additive is the underlying material: q0, q1, r0, r1, the price effect,
 * and current volume valued at base prices. Those are summed here and the three
 * effects assembled afterwards, which is the same construction as the view in
 * snowflake/09-value.sql. The definitions are deliberately identical.
 */
function bridgeSql(level: GroupLevel, predicateSql: string): string {
  return `
    WITH agg AS (
      SELECT ${GROUP_COLUMN[level]} AS GROUP_KEY,
             SUM(b.Q0) AS Q0, SUM(b.R0) AS R0,
             SUM(b.Q1) AS Q1, SUM(b.R1) AS R1,
             SUM(b.PRICE_EFFECT_EUR) AS PRICE_EFFECT_EUR,
             SUM(b.R1_AT_BASE_PRICE_EUR) AS R1_AT_BASE_PRICE_EUR,
             COUNT(*) AS SERIES_COUNT,
             SUM(IFF(b.IS_NEW, 1, 0)) AS NEW_SERIES,
             SUM(IFF(b.IS_DISCONTINUED, 1, 0)) AS DISCONTINUED_SERIES
      FROM VECTRON_DEMAND.APP.V_REVENUE_BRIDGE_BASE b
      WHERE ${predicateSql}
      GROUP BY 1
    ),
    eff AS (
      -- Fall back to the current average price where there is no base volume,
      -- which keeps the identity exact and puts a launch entirely in volume.
      SELECT a.*,
             COALESCE(a.R0 / NULLIF(a.Q0, 0), a.R1 / NULLIF(a.Q1, 0), 0) AS P0_BAR
      FROM agg a
    )
    SELECT '${level}' AS GROUP_LEVEL, GROUP_KEY,
           Q0, R0, Q1, R1, SERIES_COUNT, NEW_SERIES, DISCONTINUED_SERIES,
           R1 - R0                                        AS REVENUE_CHANGE_EUR,
           Q1 - Q0                                        AS VOLUME_CHANGE_UNITS,
           (Q1 - Q0) / NULLIF(Q0, 0)                      AS VOLUME_GROWTH,
           (R1 - R0) / NULLIF(R0, 0)                      AS VALUE_GROWTH,
           (R1 - R0) / NULLIF(R0, 0)
             - (Q1 - Q0) / NULLIF(Q0, 0)                  AS VALUE_MINUS_VOLUME_GAP,
           P0_BAR                                         AS BASE_AVG_PRICE,
           R1 / NULLIF(Q1, 0)                             AS CURRENT_AVG_PRICE,
           (Q1 - Q0) * P0_BAR                             AS VOLUME_EFFECT_EUR,
           PRICE_EFFECT_EUR,
           R1_AT_BASE_PRICE_EUR - Q1 * P0_BAR             AS MIX_EFFECT_EUR
    FROM eff
    WHERE GROUP_KEY IS NOT NULL
    ORDER BY ABS(R1 - R0) DESC, GROUP_KEY
  `;
}

/**
 * The price tier shift, restricted to a hierarchy scope.
 *
 * V_PRICE_TIER_SHIFT takes each tier's share over the WHOLE portfolio, so it
 * cannot be filtered either: keep only one category's rows and the shares no longer sum
 * to one within Cognac. The tier totals are additive, though, so they are summed
 * over the scope from V_REVENUE_BRIDGE_BASE and the shares taken afterwards, with
 * the definitions copied from snowflake/09-value.sql. At the root this returns
 * the view exactly — every tier, every column.
 *
 * Ordered by price so the tiers read upwards; the current price stands in for a
 * tier with no base volume, whose base price does not exist.
 */
function priceTierShiftSql(predicateSql: string): string {
  return `
    WITH t AS (
      SELECT b.PRICE_TIER,
             SUM(b.Q0) AS Q0, SUM(b.R0) AS R0, SUM(b.Q1) AS Q1, SUM(b.R1) AS R1
      FROM VECTRON_DEMAND.APP.V_REVENUE_BRIDGE_BASE b
      WHERE ${predicateSql}
      GROUP BY 1
    )
    SELECT PRICE_TIER, Q0, R0, Q1, R1,
           Q0 / NULLIF(SUM(Q0) OVER (), 0)            AS BASE_VOLUME_SHARE,
           Q1 / NULLIF(SUM(Q1) OVER (), 0)            AS CURRENT_VOLUME_SHARE,
           R0 / NULLIF(SUM(R0) OVER (), 0)            AS BASE_VALUE_SHARE,
           R1 / NULLIF(SUM(R1) OVER (), 0)            AS CURRENT_VALUE_SHARE,
           Q1 / NULLIF(SUM(Q1) OVER (), 0)
             - Q0 / NULLIF(SUM(Q0) OVER (), 0)        AS VOLUME_SHARE_SHIFT,
           R1 / NULLIF(SUM(R1) OVER (), 0)
             - R0 / NULLIF(SUM(R0) OVER (), 0)        AS VALUE_SHARE_SHIFT,
           R0 / NULLIF(Q0, 0)                         AS BASE_AVG_PRICE,
           R1 / NULLIF(Q1, 0)                         AS CURRENT_AVG_PRICE
    FROM t
    ORDER BY COALESCE(BASE_AVG_PRICE, CURRENT_AVG_PRICE), PRICE_TIER
  `;
}

type RevenueBridgeRow = {
  GROUP_LEVEL: GroupLevel;
  GROUP_KEY: string;
  Q0: number;
  R0: number;
  Q1: number;
  R1: number;
  SERIES_COUNT: number;
  NEW_SERIES: number;
  DISCONTINUED_SERIES: number;
  REVENUE_CHANGE_EUR: number;
  VOLUME_CHANGE_UNITS: number;
  VOLUME_GROWTH: number | null;
  VALUE_GROWTH: number | null;
  VALUE_MINUS_VOLUME_GAP: number | null;
  BASE_AVG_PRICE: number;
  CURRENT_AVG_PRICE: number;
  VOLUME_EFFECT_EUR: number;
  PRICE_EFFECT_EUR: number;
  MIX_EFFECT_EUR: number;
};

/**
 * Shares and average prices are NULL where the scope has no volume in a period.
 * A scope holding only a launch has no base year, so there is no base share to
 * shift from; coercing that to zero would report a shift and a base price that
 * do not exist.
 */
type PriceTierShiftRow = {
  PRICE_TIER: string;
  Q0: number;
  R0: number;
  Q1: number;
  R1: number;
  BASE_VOLUME_SHARE: number | null;
  CURRENT_VOLUME_SHARE: number | null;
  BASE_VALUE_SHARE: number | null;
  CURRENT_VALUE_SHARE: number | null;
  VOLUME_SHARE_SHIFT: number | null;
  VALUE_SHARE_SHIFT: number | null;
  BASE_AVG_PRICE: number | null;
  CURRENT_AVG_PRICE: number | null;
};

/** One category x customer cell of V_LANDED_COST, averaged over its series in scope. */
type LandedCostCellRow = {
  CATEGORY_NAME: string;
  CUSTOMER_ID: string;
  CUSTOMER_NAME: string;
  EXW_EUR_CASE: number;
  FREIGHT_EUR_CASE: number;
  TARIFF_EUR_CASE: number;
  EXCISE_EUR_CASE: number;
  AD_VALOREM_EUR_CASE: number;
  TRADE_MARGIN_EUR_CASE: number;
  VAT_EUR_CASE: number;
  SHELF_EUR_CASE: number;
  SHELF_EUR_BOTTLE: number;
  TAX_SHARE_OF_SHELF: number;
  EXW_SHARE_OF_SHELF: number;
};

type DutyExposureRow = {
  CATEGORY_NAME: string;
  CUSTOMER_ID: string;
  CUSTOMER_NAME: string;
  PLAN_UNITS: number;
  PLAN_EXW_EUR: number;
  PLAN_SHELF_EUR: number;
  AVG_TARIFF_PCT: number | null;
  AVG_TAX_SHARE: number | null;
};

type DutyPassThroughRow = {
  CUSTOMER_ID: string;
  CUSTOMER_NAME: string;
  AVG_EXW_EUR_CASE: number;
  AVG_SHELF_EUR_CASE: number;
  TAX_SHARE_OF_SHELF: number;
  EXW_SHARE_OF_SHELF: number;
};

function parseGroupLevel(raw: string | null): GroupLevel {
  const value = raw?.trim() as GroupLevel | undefined;
  if (value && GROUP_LEVELS.includes(value)) {
    return value;
  }
  return "Category";
}

function toNumber(value: number | null | undefined) {
  return Number(value) || 0;
}

function toNullableNumber(value: number | null | undefined) {
  return value === null || value === undefined ? null : Number(value);
}

function mapBridgeRow(row: RevenueBridgeRow) {
  const revenueChangeEur = toNumber(row.REVENUE_CHANGE_EUR);
  const volumeEffectEur = toNumber(row.VOLUME_EFFECT_EUR);
  const priceEffectEur = toNumber(row.PRICE_EFFECT_EUR);
  const mixEffectEur = toNumber(row.MIX_EFFECT_EUR);

  return {
    groupLevel: row.GROUP_LEVEL,
    groupKey: row.GROUP_KEY,
    q0: toNumber(row.Q0),
    r0: toNumber(row.R0),
    q1: toNumber(row.Q1),
    r1: toNumber(row.R1),
    seriesCount: toNumber(row.SERIES_COUNT),
    newSeries: toNumber(row.NEW_SERIES),
    discontinuedSeries: toNumber(row.DISCONTINUED_SERIES),
    revenueChangeEur,
    volumeChangeUnits: toNumber(row.VOLUME_CHANGE_UNITS),
    volumeGrowth: row.VOLUME_GROWTH,
    valueGrowth: row.VALUE_GROWTH,
    valueMinusVolumeGap: row.VALUE_MINUS_VOLUME_GAP,
    baseAvgPrice: toNumber(row.BASE_AVG_PRICE),
    currentAvgPrice: toNumber(row.CURRENT_AVG_PRICE),
    volumeEffectEur,
    priceEffectEur,
    mixEffectEur,
    effectResidualEur:
      revenueChangeEur - (volumeEffectEur + priceEffectEur + mixEffectEur),
  };
}

function mapPriceTierShiftRow(row: PriceTierShiftRow) {
  return {
    priceTier: row.PRICE_TIER,
    q0: toNumber(row.Q0),
    r0: toNumber(row.R0),
    q1: toNumber(row.Q1),
    r1: toNumber(row.R1),
    baseVolumeShare: toNullableNumber(row.BASE_VOLUME_SHARE),
    currentVolumeShare: toNullableNumber(row.CURRENT_VOLUME_SHARE),
    baseValueShare: toNullableNumber(row.BASE_VALUE_SHARE),
    currentValueShare: toNullableNumber(row.CURRENT_VALUE_SHARE),
    volumeShareShift: toNullableNumber(row.VOLUME_SHARE_SHIFT),
    valueShareShift: toNullableNumber(row.VALUE_SHARE_SHIFT),
    baseAvgPrice: toNullableNumber(row.BASE_AVG_PRICE),
    currentAvgPrice: toNullableNumber(row.CURRENT_AVG_PRICE),
  };
}

function weightedAverage<
  TValueKey extends string,
  TWeightKey extends string,
  TRow extends Record<TValueKey | TWeightKey, number | null | undefined>,
>(
  rows: TRow[],
  valueKey: TValueKey,
  weightKey: TWeightKey,
) {
  const weightedSum = rows.reduce((sum, row) => {
    const value = row[valueKey];
    const weight = row[weightKey];
    if (value === null || value === undefined || weight === null || weight === undefined) {
      return sum;
    }
    return sum + Number(value) * Number(weight);
  }, 0);

  const totalWeight = rows.reduce((sum, row) => {
    const weight = row[weightKey];
    return sum + toNumber(weight);
  }, 0);

  return totalWeight === 0 ? null : weightedSum / totalWeight;
}

export async function GET(request: NextRequest) {
  try {
    const groupLevel = parseGroupLevel(request.nextUrl.searchParams.get("groupLevel"));

    const contextPromise = getContext();
    const hierarchyPath = parseHierarchyPath(request.nextUrl.searchParams);
    const scope = hierarchyPredicate(hierarchyPath, "b");
    // V_LANDED_COST is per series and carries all four levels, so the build-up
    // and the customer comparison honour the whole path.
    const landedScope = hierarchyPredicate(hierarchyPath, "lc");
    // V_DUTY_EXPOSURE is held by customer x category only, so product and channel
    // cannot narrow it. They are dropped here, and the payload says so.
    const dutyScope = hierarchyPredicate(
      pickLevels(hierarchyPath, ["CATEGORY_NAME", "CUSTOMER_NAME"]),
      "e",
    );

    // Option lists for the four hierarchy dropdowns. Read from the same base
    // view the bridge uses, so a level can never offer a value the bridge has
    // no rows for; each level cascades on the levels above it.
    const hierarchyOptionsPromise = loadHierarchyOptions(
      "APP.V_REVENUE_BRIDGE_BASE",
      hierarchyPath,
    );

    const totalPromise = query<RevenueBridgeRow>(
      bridgeSql("Total", scope.sql),
      scope.binds,
    );
    const groupsPromise = query<RevenueBridgeRow>(
      bridgeSql(groupLevel, scope.sql),
      scope.binds,
    );
    const priceTierShiftPromise = query<PriceTierShiftRow>(
      priceTierShiftSql(scope.sql),
      scope.binds,
    );
    // One row per category x customer cell in scope. The customer comparison and the
    // build-up are both read from it — they are the same averages over the same
    // series — and fetching every category in scope lets the build-up cell be
    // chosen below without a second round trip.
    const landedCellsPromise = query<LandedCostCellRow>(
      `SELECT lc.CATEGORY_NAME,
              lc.CUSTOMER_ID,
              lc.CUSTOMER_NAME,
              AVG(lc.UNIT_PRICE_EUR) AS EXW_EUR_CASE,
              AVG(lc.FREIGHT_EUR_PER_CASE) AS FREIGHT_EUR_CASE,
              AVG(lc.TARIFF_EUR_CASE) AS TARIFF_EUR_CASE,
              AVG(lc.EXCISE_EUR_CASE) AS EXCISE_EUR_CASE,
              AVG(lc.AD_VALOREM_EUR_CASE) AS AD_VALOREM_EUR_CASE,
              AVG(lc.TRADE_MARGIN_EUR_CASE) AS TRADE_MARGIN_EUR_CASE,
              AVG(lc.VAT_EUR_CASE) AS VAT_EUR_CASE,
              AVG(lc.SHELF_EUR_CASE) AS SHELF_EUR_CASE,
              AVG(lc.SHELF_EUR_BOTTLE) AS SHELF_EUR_BOTTLE,
              AVG(lc.TAX_SHARE_OF_SHELF) AS TAX_SHARE_OF_SHELF,
              AVG(lc.EXW_SHARE_OF_SHELF) AS EXW_SHARE_OF_SHELF
       FROM VECTRON_DEMAND.APP.V_LANDED_COST lc
       WHERE ${landedScope.sql}
       GROUP BY lc.CATEGORY_NAME, lc.CUSTOMER_ID, lc.CUSTOMER_NAME
       ORDER BY TAX_SHARE_OF_SHELF DESC, lc.CUSTOMER_NAME`,
      landedScope.binds,
    );
    const dutyPassThroughPromise = query<DutyPassThroughRow>(
      `SELECT CUSTOMER_ID,
              CUSTOMER_NAME,
              AVG(UNIT_PRICE_EUR) AS AVG_EXW_EUR_CASE,
              AVG(SHELF_EUR_CASE) AS AVG_SHELF_EUR_CASE,
              AVG(TAX_SHARE_OF_SHELF) AS TAX_SHARE_OF_SHELF,
              AVG(EXW_SHARE_OF_SHELF) AS EXW_SHARE_OF_SHELF
       FROM VECTRON_DEMAND.APP.V_LANDED_COST
       WHERE CATEGORY_NAME = 'Brake systems'
         AND CUSTOMER_NAME IN ('BMW Group', 'Independent aftermarket')
       GROUP BY CUSTOMER_ID, CUSTOMER_NAME
       ORDER BY CUSTOMER_NAME`,
    );
    // Every category the duty scope allows, narrowed to the build-up's category
    // below for the same reason as the landed cells.
    const dutyExposurePromise = query<DutyExposureRow>(
      `SELECT e.CATEGORY_NAME,
              e.CUSTOMER_ID,
              e.CUSTOMER_NAME,
              SUM(e.PLAN_UNITS) AS PLAN_UNITS,
              SUM(e.PLAN_EXW_EUR) AS PLAN_EXW_EUR,
              SUM(e.PLAN_SHELF_EUR) AS PLAN_SHELF_EUR,
              IFF(
                SUM(e.PLAN_UNITS) = 0,
                NULL,
                SUM(e.PLAN_UNITS * e.AVG_TARIFF_PCT) / NULLIFZERO(SUM(e.PLAN_UNITS))
              ) AS AVG_TARIFF_PCT,
              IFF(
                SUM(e.PLAN_UNITS) = 0,
                NULL,
                SUM(e.PLAN_UNITS * e.AVG_TAX_SHARE) / NULLIFZERO(SUM(e.PLAN_UNITS))
              ) AS AVG_TAX_SHARE
       FROM VECTRON_DEMAND.APP.V_DUTY_EXPOSURE e
       WHERE ${dutyScope.sql}
       GROUP BY e.CATEGORY_NAME, e.CUSTOMER_ID, e.CUSTOMER_NAME
       ORDER BY PLAN_SHELF_EUR DESC, e.CUSTOMER_NAME`,
      dutyScope.binds,
    );

    const [
      context,
      hierarchyOptions,
      totalRows,
      groupRows,
      priceTierShiftRows,
      landedCellRows,
      dutyPassThroughRows,
      dutyExposureRows,
    ] = await Promise.all([
      contextPromise,
      hierarchyOptionsPromise,
      totalPromise,
      groupsPromise,
      priceTierShiftPromise,
      landedCellsPromise,
      dutyPassThroughPromise,
      dutyExposurePromise,
    ]);

    // An empty scope is a legitimate user action, not a failure: selecting a
    // product and a customer it does not sell in returns nothing. Every part of the
    // payload comes back empty instead — throwing would 500 the page on a valid
    // selection.
    const total = totalRows[0] ? mapBridgeRow(totalRows[0]) : null;

    // THE BUILD-UP CELL
    // -----------------
    // The scope picks the cell where it pins a level. Where it does not, the
    // category falls back to Brake systems if the scope contains it, otherwise
    // the first category in scope alphabetically, and the customer to Ford
    // (EU & Mexico) if it carries that category, otherwise the first customer —
    // the same fallbacks the tab's own selects used. A pinned customer leaves
    // exactly one row in `cells`, so the customer rule covers that case too.
    const landedCategories = Array.from(
      new Set(landedCellRows.map((row) => row.CATEGORY_NAME)),
    ).sort();
    const landedCategory =
      hierarchyPath.CATEGORY_NAME ??
      (landedCategories.includes(DEFAULT_LANDED_CATEGORY)
        ? DEFAULT_LANDED_CATEGORY
        : landedCategories[0]) ??
      null;
    const cells = landedCellRows.filter((row) => row.CATEGORY_NAME === landedCategory);
    const selectedCell =
      cells.find((row) => row.CUSTOMER_NAME === DEFAULT_LANDED_CUSTOMER) ?? cells[0] ?? null;

    const passThroughByCustomer = new Map(
      dutyPassThroughRows.map((row) => [
        row.CUSTOMER_NAME,
        {
          customerId: row.CUSTOMER_ID,
          customerName: row.CUSTOMER_NAME,
          avgExwEurCase: toNumber(row.AVG_EXW_EUR_CASE),
          avgShelfEurCase: toNumber(row.AVG_SHELF_EUR_CASE),
          taxShareOfShelf: toNumber(row.TAX_SHARE_OF_SHELF),
          exwShareOfShelf: toNumber(row.EXW_SHARE_OF_SHELF),
        },
      ]),
    );

    const exposureRows = dutyExposureRows
      .filter((row) => row.CATEGORY_NAME === landedCategory)
      .map((row) => ({
        customerId: row.CUSTOMER_ID,
        customerName: row.CUSTOMER_NAME,
        planUnits: toNumber(row.PLAN_UNITS),
        planExwEur: toNumber(row.PLAN_EXW_EUR),
        planShelfEur: toNumber(row.PLAN_SHELF_EUR),
        avgTariffPct: row.AVG_TARIFF_PCT,
        avgTaxShare: row.AVG_TAX_SHARE,
      }));

    // Levels the planner selected that duty exposure cannot honour. Named in the
    // payload so the page can say so, rather than let the figures read as though
    // they had been narrowed.
    const dutyIgnoredLevels = [
      hierarchyPath.PRODUCT_LINE ? `product family ${hierarchyPath.PRODUCT_LINE}` : null,
      hierarchyPath.PRICE_TIER ? `price tier ${hierarchyPath.PRICE_TIER}` : null,
      hierarchyPath.PRODUCT_NAME ? `product ${hierarchyPath.PRODUCT_NAME}` : null,
      hierarchyPath.CHANNEL_GROUP ? `channel group ${hierarchyPath.CHANNEL_GROUP}` : null,
      hierarchyPath.CHANNEL_NAME ? `channel ${hierarchyPath.CHANNEL_NAME}` : null,
    ].filter((value): value is string => value !== null);

    const landedCost = selectedCell
      ? {
          filters: {
            categoryName: selectedCell.CATEGORY_NAME,
            customerId: selectedCell.CUSTOMER_ID,
            customerName: selectedCell.CUSTOMER_NAME,
            // True when the scope fixed that half of the cell — selected outright,
            // or the only one left in scope — rather than the default applying.
            categoryFromScope:
              Boolean(hierarchyPath.CATEGORY_NAME) || landedCategories.length === 1,
            customerFromScope: Boolean(hierarchyPath.CUSTOMER_NAME) || cells.length === 1,
          },
          buildUp: {
            customerId: selectedCell.CUSTOMER_ID,
            customerName: selectedCell.CUSTOMER_NAME,
            categoryName: selectedCell.CATEGORY_NAME,
            shelfEurCase: toNumber(selectedCell.SHELF_EUR_CASE),
            shelfEurBottle: toNumber(selectedCell.SHELF_EUR_BOTTLE),
            taxShareOfShelf: toNumber(selectedCell.TAX_SHARE_OF_SHELF),
            exwShareOfShelf: toNumber(selectedCell.EXW_SHARE_OF_SHELF),
            components: [
              { key: "exw", label: "EXW", value: toNumber(selectedCell.EXW_EUR_CASE) },
              { key: "freight", label: "Logistics", value: toNumber(selectedCell.FREIGHT_EUR_CASE) },
              { key: "tariff", label: "Cross-border tariff", value: toNumber(selectedCell.TARIFF_EUR_CASE) },
              { key: "excise", label: "Material surcharge", value: toNumber(selectedCell.EXCISE_EUR_CASE) },
              { key: "adValorem", label: "Customs brokerage", value: toNumber(selectedCell.AD_VALOREM_EUR_CASE) },
              { key: "tradeMargin", label: "Distributor margin", value: toNumber(selectedCell.TRADE_MARGIN_EUR_CASE) },
              { key: "vat", label: "VAT", value: toNumber(selectedCell.VAT_EUR_CASE) },
            ],
          },
          comparison: cells.map((row) => ({
            customerId: row.CUSTOMER_ID,
            customerName: row.CUSTOMER_NAME,
            avgExwEurCase: toNumber(row.EXW_EUR_CASE),
            avgShelfEurCase: toNumber(row.SHELF_EUR_CASE),
            shelfEurBottle: toNumber(row.SHELF_EUR_BOTTLE),
            taxShareOfShelf: toNumber(row.TAX_SHARE_OF_SHELF),
            exwShareOfShelf: toNumber(row.EXW_SHARE_OF_SHELF),
          })),
          passThroughInsight: {
            categoryName: "Brake systems",
            aftermarket: passThroughByCustomer.get("Independent aftermarket") ?? null,
            oem: passThroughByCustomer.get("BMW Group") ?? null,
          },
          exposure: {
            scopeNote: dutyIgnoredLevels.length
              ? `Duty exposure is held by customer × category, so ${dutyIgnoredLevels.join(" and ")} ${
                  dutyIgnoredLevels.length > 1 ? "do" : "does"
                } not apply to it.`
              : null,
            summary: {
              planUnits: exposureRows.reduce((sum, row) => sum + row.planUnits, 0),
              planExwEur: exposureRows.reduce((sum, row) => sum + row.planExwEur, 0),
              planShelfEur: exposureRows.reduce((sum, row) => sum + row.planShelfEur, 0),
              avgTariffPct: weightedAverage(exposureRows, "avgTariffPct", "planUnits"),
              avgTaxShare: weightedAverage(exposureRows, "avgTaxShare", "planUnits"),
            },
            rows: exposureRows,
          },
        }
      : null;

    return NextResponse.json({
      context,
      filters: {
        groupLevel,
        path: hierarchyPath,
        scopeLabel: hierarchyLabel(hierarchyPath),
        isEmptyScope: total === null,
      },
      options: {
        groupLevels: GROUP_LEVELS.filter((value) => value !== "Total"),
        hierarchy: hierarchyOptions,
      },
      total,
      groups: groupRows.map(mapBridgeRow),
      priceTierShift: priceTierShiftRows.map(mapPriceTierShiftRow),
      landedCost,
    });
  } catch (err) {
    console.error("value route failed:", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "Failed to load volume to value" },
      { status: 500 },
    );
  }
}
