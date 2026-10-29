import { NextRequest, NextResponse } from "next/server";
import { getContext } from "@/lib/data";
import { loadHierarchyOptions } from "@/lib/hierarchy-options";
import { hierarchyPredicate, parseHierarchyPath } from "@/lib/hierarchy-path";
import { query } from "@/lib/snowflake";

export const dynamic = "force-dynamic";

/**
 * OEM call-offs: how good each OEM's EDI schedule is by zone and horizon,
 * whether de-biasing it beats taking it at face value, how nervous it is, and
 * what a monthly read does to a moving plant shutdown.
 *
 * Every number is computed from APP views over CORE.FACT_EDI_RELEASE, which is
 * SYNTHETIC; the page says so.
 */

type HorizonRow = {
  HORIZON_WEEKS: number;
  ZONE: string;
  ACTUAL: number;
  OEM_ABS: number;
  OEM_ERR: number;
  CORR_ABS: number;
};

type ModelRow = { HORIZON_WEEKS: number; ACTUAL: number; MODEL_ABS: number };

type CustomerRow = {
  CUSTOMER_ID: string;
  CUSTOMER_NAME: string;
  ACTUAL: number;
  OEM_ABS: number;
  OEM_ERR: number;
  CORR_ABS: number;
};

type VolatilityRow = { CUSTOMER_ID: string; ZONE: string; MOVED: number; BASE: number };

type WaterfallRow = {
  RELEASE_WEEK_ID: string;
  HORIZON_WEEKS: number;
  ZONE: string;
  RELEASE_UNITS: number;
  ACTUAL_UNITS: number | null;
};

type MonthRow = { YEAR: number; MONTH: number; UNITS: number; PRIOR_YEAR_UNITS: number | null };
type AlignedRow = { YEAR: number; OFFSET_WEEKS: number; WEEK_ID: string; UNITS: number; SHUTDOWN_WEEK_ID: string };
type OemRow = { CUSTOMER_ID: string; CUSTOMER_NAME: string };

const ratio = (num: number, den: number) => (den ? num / den : null);

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const path = parseHierarchyPath(params);
    const scope = hierarchyPredicate(path, "c");
    const ctx = await getContext();

    const [options, horizons, model, customers, volatility, releaseWeeks, oems] = await Promise.all([
      loadHierarchyOptions("APP.V_CALLOFF_WATERFALL", path),
      query<HorizonRow>(
        `SELECT HORIZON_WEEKS, ZONE,
                SUM(ACTUAL_UNITS) AS ACTUAL,
                SUM(ABS(ERROR_UNITS)) AS OEM_ABS,
                SUM(ERROR_UNITS) AS OEM_ERR,
                SUM(ABS(CORRECTED_UNITS - ACTUAL_UNITS)) AS CORR_ABS
         FROM APP.V_CALLOFF_CORRECTED c
         WHERE ${scope.sql}
         GROUP BY 1, 2 ORDER BY 1`,
        scope.binds,
      ),
      query<ModelRow>(
        `SELECT c.HORIZON_WEEKS, SUM(c.ACTUAL_UNITS) AS ACTUAL,
                SUM(ABS(f.FORECAST_UNITS - c.ACTUAL_UNITS)) AS MODEL_ABS
         FROM APP.V_CALLOFF_SCORED c
         JOIN ML.FACT_FORECAST f
           ON f.SERIES_ID = c.SERIES_ID AND f.MADE_WEEK_ID = c.RELEASE_WEEK_ID
          AND f.TARGET_WEEK_ID = c.TARGET_WEEK_ID AND f.MODEL_NAME = 'VECTRON_STAT'
         WHERE c.HORIZON_WEEKS BETWEEN 1 AND 8 AND ${scope.sql}
         GROUP BY 1 ORDER BY 1`,
        scope.binds,
      ),
      query<CustomerRow>(
        `SELECT CUSTOMER_ID, CUSTOMER_NAME,
                SUM(ACTUAL_UNITS) AS ACTUAL,
                SUM(ABS(ERROR_UNITS)) AS OEM_ABS,
                SUM(ERROR_UNITS) AS OEM_ERR,
                SUM(ABS(CORRECTED_UNITS - ACTUAL_UNITS)) AS CORR_ABS
         FROM APP.V_CALLOFF_CORRECTED c
         WHERE ZONE = 'TRADE' AND ${scope.sql}
         GROUP BY 1, 2`,
        scope.binds,
      ),
      query<VolatilityRow>(
        `WITH seq AS (
           SELECT c.CUSTOMER_ID, c.ZONE, c.RELEASE_UNITS,
                  LAG(c.RELEASE_UNITS) OVER (PARTITION BY c.SERIES_ID, c.TARGET_WEEK_ID
                                             ORDER BY c.RELEASE_WEEK_ID) AS PRIOR_UNITS
           FROM APP.V_CALLOFF_WATERFALL c
           WHERE ${scope.sql}
         )
         SELECT CUSTOMER_ID, ZONE,
                SUM(ABS(RELEASE_UNITS - PRIOR_UNITS)) AS MOVED,
                SUM(PRIOR_UNITS) AS BASE
         FROM seq WHERE PRIOR_UNITS IS NOT NULL
         GROUP BY 1, 2`,
        scope.binds,
      ),
      query<{ TARGET_WEEK_ID: string }>(
        `SELECT TARGET_WEEK_ID
         FROM APP.V_CALLOFF_SCORED
         GROUP BY 1
         HAVING COUNT(DISTINCT HORIZON_WEEKS) = 13
         ORDER BY 1 DESC LIMIT 26`,
      ),
      query<OemRow>(
        `SELECT DISTINCT CUSTOMER_ID, CUSTOMER_NAME FROM APP.V_MONTHLY_YOY ORDER BY CUSTOMER_NAME`,
      ),
    ]);

    // Waterfall: the call for one target week, release by release.
    const targetWeeks = releaseWeeks.map((r) => r.TARGET_WEEK_ID);
    const requested = params.get("target");
    const target = requested && targetWeeks.includes(requested) ? requested : targetWeeks[0] ?? null;
    const waterfall = target
      ? await query<WaterfallRow>(
          `SELECT RELEASE_WEEK_ID, HORIZON_WEEKS, ZONE,
                  SUM(RELEASE_UNITS) AS RELEASE_UNITS, SUM(ACTUAL_UNITS) AS ACTUAL_UNITS
           FROM APP.V_CALLOFF_WATERFALL c
           WHERE TARGET_WEEK_ID = ? AND ${scope.sql}
           GROUP BY 1, 2, 3 ORDER BY HORIZON_WEEKS DESC`,
          [target, ...scope.binds],
        )
      : [];

    // Monthly mirage, for one OEM (its plant calendar, not a portfolio blend).
    const oemIds = oems.map((o) => o.CUSTOMER_ID);
    const oemParam = params.get("oem");
    const oem = oemParam && oemIds.includes(oemParam) ? oemParam : (oemIds.includes("OEM-BMW") ? "OEM-BMW" : oemIds[0]);
    const [months, aligned] = await Promise.all([
      query<MonthRow>(
        `SELECT YEAR, MONTH, UNITS, PRIOR_YEAR_UNITS
         FROM APP.V_MONTHLY_YOY
         WHERE CUSTOMER_ID = ? AND MONTH BETWEEN 6 AND 9 AND YEAR BETWEEN 2023 AND 2026
         ORDER BY YEAR, MONTH`,
        [oem],
      ),
      query<AlignedRow>(
        `SELECT YEAR, OFFSET_WEEKS, WEEK_ID, UNITS, SHUTDOWN_WEEK_ID
         FROM APP.V_SHUTDOWN_ALIGNED
         WHERE CUSTOMER_ID = ? AND YEAR BETWEEN 2023 AND 2026
         ORDER BY YEAR, OFFSET_WEEKS`,
        [oem],
      ),
    ]);

    const modelBy = new Map(model.map((m) => [m.HORIZON_WEEKS, m]));
    const horizonOut = horizons.map((h) => {
      const m = modelBy.get(h.HORIZON_WEEKS);
      return {
        horizon: h.HORIZON_WEEKS,
        zone: h.ZONE,
        oemWape: ratio(h.OEM_ABS, h.ACTUAL),
        oemBias: ratio(h.OEM_ERR, h.ACTUAL),
        correctedWape: ratio(h.CORR_ABS, h.ACTUAL),
        modelWape: m ? ratio(m.MODEL_ABS, m.ACTUAL) : null,
      };
    });

    const zoneSum = (zone: string) => {
      const rows = horizons.filter((h) => h.ZONE === zone);
      const a = rows.reduce((s, r) => s + r.ACTUAL, 0);
      return {
        wape: ratio(rows.reduce((s, r) => s + r.OEM_ABS, 0), a),
        bias: ratio(rows.reduce((s, r) => s + r.OEM_ERR, 0), a),
        corrected: ratio(rows.reduce((s, r) => s + r.CORR_ABS, 0), a),
      };
    };
    const tradeVol = volatility.filter((v) => v.ZONE === "TRADE");
    const volBy = new Map<string, { moved: number; base: number }>();
    for (const v of tradeVol) volBy.set(v.CUSTOMER_ID, { moved: v.MOVED, base: v.BASE });

    const yearsInMonths = Array.from(new Set(months.map((m) => m.YEAR))).sort();
    // The comparison pair: `year` against the year before it. Defaults to
    // 2025 v 2024, the pair in this dataset where the Bavarian shutdown start
    // moved from 29 July to 4 August (measured, see the WI notes).
    const sdStart = new Map<number, string>();
    for (const a of aligned) if (!sdStart.has(a.YEAR)) sdStart.set(a.YEAR, a.SHUTDOWN_WEEK_ID);
    const yearParam = Number(params.get("year"));
    const valid = (y: number) => yearsInMonths.includes(y) && yearsInMonths.includes(y - 1);
    const year = valid(yearParam) ? yearParam : (valid(2025) ? 2025 : yearsInMonths[yearsInMonths.length - 1]);
    const pair = [year - 1, year];
    const monthly = [6, 7, 8, 9].map((month) => {
      const row: Record<string, number | null> = { month };
      for (const y of pair) {
        const m = months.find((r) => r.YEAR === y && r.MONTH === month);
        row[`y${y}`] = m ? m.UNITS : null;
      }
      const cur = row[`y${year}`];
      const prev = row[`y${year - 1}`];
      row.yoy = cur != null && prev ? cur / prev - 1 : null;
      return row;
    });
    const offsets = Array.from(new Set(aligned.map((a) => a.OFFSET_WEEKS))).sort((a, b) => a - b);
    const alignedOut = offsets.map((offset) => {
      const row: Record<string, number | string | null> = { offset };
      for (const y of pair) {
        const a = aligned.find((r) => r.YEAR === y && r.OFFSET_WEEKS === offset);
        row[`y${y}`] = a ? a.UNITS : null;
        row[`w${y}`] = a ? a.WEEK_ID : null;
      }
      return row;
    });
    const shutdownWeeks = Object.fromEntries(pair.map((y) => [y, sdStart.get(y) ?? null]));

    return NextResponse.json({
      context: ctx,
      filters: { path, target, oem },
      options: {
        hierarchy: options,
        targetWeeks,
        oems: oems.map((o) => ({ value: o.CUSTOMER_ID, label: o.CUSTOMER_NAME })),
      },
      kpis: {
        firm: zoneSum("FIRM"),
        trade: zoneSum("TRADE"),
        forecast: zoneSum("FORECAST"),
        tradeNervousness: ratio(
          tradeVol.reduce((s, v) => s + v.MOVED, 0),
          tradeVol.reduce((s, v) => s + v.BASE, 0),
        ),
      },
      horizons: horizonOut,
      customers: customers
        .map((c) => ({
          customerId: c.CUSTOMER_ID,
          customerName: c.CUSTOMER_NAME,
          oemWape: ratio(c.OEM_ABS, c.ACTUAL),
          oemBias: ratio(c.OEM_ERR, c.ACTUAL),
          correctedWape: ratio(c.CORR_ABS, c.ACTUAL),
          nervousness: volBy.has(c.CUSTOMER_ID)
            ? ratio(volBy.get(c.CUSTOMER_ID)!.moved, volBy.get(c.CUSTOMER_ID)!.base)
            : null,
        }))
        .sort((a, b) => (b.oemWape ?? 0) - (a.oemWape ?? 0)),
      waterfall: waterfall.map((w) => ({
        releaseWeek: w.RELEASE_WEEK_ID,
        horizon: w.HORIZON_WEEKS,
        zone: w.ZONE,
        releaseUnits: w.RELEASE_UNITS,
        actualUnits: w.ACTUAL_UNITS,
      })),
      mirage: { years: yearsInMonths, year, pair, monthly, aligned: alignedOut, shutdownWeeks },
    });
  } catch (error) {
    console.error("calloffs route failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
