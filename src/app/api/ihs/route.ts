import { NextRequest, NextResponse } from "next/server";
import { getContext } from "@/lib/data";
import { query } from "@/lib/snowflake";

export const dynamic = "force-dynamic";

/**
 * Outside-in demand: what light-vehicle production (IHS-style, SYNTHETIC)
 * implies for Vectron's OE series, against Vectron's own plan.
 *
 * Reads APP.V_IHS_* views only; those read APP.V_LV_PRODUCTION, the single
 * swap point for a licensed S&P Global Mobility share.
 */

type Opt = { ID: string; NAME: string };
type MonthRow = { PROD_MONTH: string; IS_ACTUAL: boolean; ACTUAL: number | null; PLAN: number | null; IHS: number; IHS_OLDEST: number | null };
type YearRow = { PROD_YEAR: number; UNITS: number; BEV_UNITS: number; REVENUE: number; BEV_REVENUE: number };
type VintageRow = { VINTAGE_MONTH: string; UNITS: number; BEV_UNITS: number; REVENUE: number };
type GapRow = { ID: string; NAME: string; PLAN: number; IHS: number; PLAN_EUR: number; IHS_EUR: number };
type FitRow = { ABS_ERR: number; ACTUAL: number; MONTHS: number };
type WindowRow = { FIRST_MONTH: string; LAST_MONTH: string };

const ratio = (num: number, den: number) => (den ? num / den : null);

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const [customers, categories, ctx] = await Promise.all([
      query<Opt>(`SELECT DISTINCT CUSTOMER_ID AS ID, CUSTOMER_NAME AS NAME FROM APP.V_IHS_GAP ORDER BY 2`),
      query<Opt>(`SELECT DISTINCT CATEGORY_ID AS ID, CATEGORY_NAME AS NAME FROM APP.V_IHS_GAP ORDER BY 2`),
      getContext(),
    ]);
    const customer = customers.some((c) => c.ID === params.get("customer")) ? params.get("customer")! : "";
    const category = categories.some((c) => c.ID === params.get("category")) ? params.get("category")! : "";
    const where: string[] = [];
    const binds: string[] = [];
    if (customer) { where.push("CUSTOMER_ID = ?"); binds.push(customer); }
    if (category) { where.push("CATEGORY_ID = ?"); binds.push(category); }
    const scope = where.length ? where.join(" AND ") : "1=1";

    // The comparison window: forward months where Vectron has a plan for the
    // whole month. The first and last plan months straddle the history
    // edge and the horizon end, so both are dropped.
    const [win] = await query<WindowRow>(
      `SELECT MIN(PROD_MONTH) AS FIRST_MONTH, MAX(PROD_MONTH) AS LAST_MONTH
       FROM (SELECT PROD_MONTH FROM APP.V_IHS_GAP
             WHERE NOT IS_ACTUAL AND PLAN_UNITS IS NOT NULL
             GROUP BY 1
             QUALIFY ROW_NUMBER() OVER (ORDER BY PROD_MONTH DESC) > 1
                AND ROW_NUMBER() OVER (ORDER BY PROD_MONTH) > 1)`,
    );

    const [monthly, years, vintages, byCustomer, byCategory, fit] = await Promise.all([
      query<MonthRow>(
        `WITH latest AS (
           SELECT PROD_MONTH, IS_ACTUAL, SUM(ACTUAL_UNITS) AS ACTUAL, SUM(PLAN_UNITS) AS PLAN,
                  SUM(IMPLIED_UNITS) AS IHS
           FROM APP.V_IHS_GAP WHERE ${scope} GROUP BY 1, 2
         ), oldest AS (
           SELECT PROD_MONTH, SUM(IMPLIED_UNITS) AS IHS_OLDEST
           FROM APP.V_IHS_IMPLIED_DEMAND
           WHERE VINTAGE_MONTH = (SELECT MIN(VINTAGE_MONTH) FROM APP.V_LV_PRODUCTION)
             AND NOT IS_ACTUAL AND ${scope}
           GROUP BY 1
         )
         SELECT l.PROD_MONTH, l.IS_ACTUAL, l.ACTUAL, l.PLAN, l.IHS, o.IHS_OLDEST
         FROM latest l LEFT JOIN oldest o USING (PROD_MONTH)
         WHERE l.PROD_MONTH BETWEEN '2024-01' AND '2028-12'
         ORDER BY 1`,
        binds.concat(binds),
      ),
      query<YearRow>(
        `SELECT PROD_YEAR, SUM(IMPLIED_UNITS) AS UNITS, SUM(IMPLIED_BEV_UNITS) AS BEV_UNITS,
                SUM(IMPLIED_REVENUE_EUR) AS REVENUE, SUM(IMPLIED_BEV_REVENUE_EUR) AS BEV_REVENUE
         FROM APP.V_IHS_VINTAGE_WALK
         WHERE VINTAGE_MONTH = (SELECT VINTAGE_MONTH FROM APP.V_LV_LATEST_VINTAGE) AND ${scope}
         GROUP BY 1 ORDER BY 1`,
        binds,
      ),
      query<VintageRow>(
        `SELECT VINTAGE_MONTH, SUM(IMPLIED_UNITS) AS UNITS, SUM(IMPLIED_BEV_UNITS) AS BEV_UNITS,
                SUM(IMPLIED_REVENUE_EUR) AS REVENUE
         FROM APP.V_IHS_VINTAGE_WALK
         WHERE PROD_YEAR = 2027 AND ${scope}
         GROUP BY 1 ORDER BY 1`,
        binds,
      ),
      query<GapRow>(
        `SELECT CUSTOMER_ID AS ID, CUSTOMER_NAME AS NAME,
                SUM(PLAN_UNITS) AS PLAN, SUM(IMPLIED_UNITS) AS IHS,
                SUM(PLAN_UNITS * UNIT_PRICE_EUR) AS PLAN_EUR, SUM(IMPLIED_UNITS * UNIT_PRICE_EUR) AS IHS_EUR
         FROM APP.V_IHS_GAP
         WHERE PROD_MONTH BETWEEN ? AND ? AND ${scope}
         GROUP BY 1, 2`,
        [win.FIRST_MONTH, win.LAST_MONTH, ...binds],
      ),
      query<GapRow>(
        `SELECT CATEGORY_ID AS ID, CATEGORY_NAME AS NAME,
                SUM(PLAN_UNITS) AS PLAN, SUM(IMPLIED_UNITS) AS IHS,
                SUM(PLAN_UNITS * UNIT_PRICE_EUR) AS PLAN_EUR, SUM(IMPLIED_UNITS * UNIT_PRICE_EUR) AS IHS_EUR
         FROM APP.V_IHS_GAP
         WHERE PROD_MONTH BETWEEN ? AND ? AND ${scope}
         GROUP BY 1, 2`,
        [win.FIRST_MONTH, win.LAST_MONTH, ...binds],
      ),
      // How well IHS-implied demand tracks realised pull, month by month,
      // at series grain. Calibration fixes the 12-month total, not the months.
      query<FitRow>(
        `SELECT SUM(ABS(IMPLIED_UNITS - ACTUAL_UNITS)) AS ABS_ERR, SUM(ACTUAL_UNITS) AS ACTUAL,
                COUNT(DISTINCT PROD_MONTH) AS MONTHS
         FROM APP.V_IHS_GAP
         WHERE IS_ACTUAL AND ACTUAL_UNITS IS NOT NULL AND PROD_MONTH >= '2024-01' AND ${scope}`,
        binds,
      ),
    ]);

    const gapOut = (rows: GapRow[]) =>
      rows
        .map((r) => ({
          id: r.ID,
          name: r.NAME,
          plan: r.PLAN,
          ihs: r.IHS,
          gapPct: ratio(r.PLAN - r.IHS, r.IHS),
          gapEur: r.PLAN_EUR - r.IHS_EUR,
        }))
        .sort((a, b) => (b.gapPct ?? 0) - (a.gapPct ?? 0));

    const totPlan = byCustomer.reduce((s, r) => s + r.PLAN, 0);
    const totIhs = byCustomer.reduce((s, r) => s + r.IHS, 0);
    const totGapEur = byCustomer.reduce((s, r) => s + r.PLAN_EUR - r.IHS_EUR, 0);
    const firstV = vintages[0];
    const lastV = vintages[vintages.length - 1];

    return NextResponse.json({
      context: ctx,
      filters: { customer, category },
      options: {
        customers: customers.map((c) => ({ value: c.ID, label: c.NAME })),
        categories: categories.map((c) => ({ value: c.ID, label: c.NAME })),
      },
      window: { first: win.FIRST_MONTH, last: win.LAST_MONTH },
      vintage: { first: firstV?.VINTAGE_MONTH ?? null, last: lastV?.VINTAGE_MONTH ?? null },
      kpis: {
        gapPct: ratio(totPlan - totIhs, totIhs),
        gapEur: totGapEur,
        historyWape: fit[0] ? ratio(fit[0].ABS_ERR, fit[0].ACTUAL) : null,
        bevRevision: firstV && lastV ? ratio(lastV.BEV_UNITS - firstV.BEV_UNITS, firstV.BEV_UNITS) : null,
        totalRevision: firstV && lastV ? ratio(lastV.UNITS - firstV.UNITS, firstV.UNITS) : null,
      },
      // The month that straddles the end of history carries part actual,
      // part plan; Vectron's view of that month is the two together.
      monthly: monthly.map((m) => ({
        month: m.PROD_MONTH,
        isActual: m.IS_ACTUAL,
        actual: m.IS_ACTUAL ? m.ACTUAL : null,
        plan: m.IS_ACTUAL || m.PLAN == null || m.PROD_MONTH > win.LAST_MONTH ? null : m.PLAN + (m.ACTUAL ?? 0),
        ihs: m.IHS,
        ihsOldest: m.IHS_OLDEST,
      })),
      years: years.map((y) => ({
        year: y.PROD_YEAR,
        bev: y.BEV_UNITS,
        ice: y.UNITS - y.BEV_UNITS,
        revenue: y.REVENUE,
        bevRevenue: y.BEV_REVENUE,
      })),
      vintages: vintages.map((v) => ({
        vintage: v.VINTAGE_MONTH,
        units: v.UNITS,
        bev: v.BEV_UNITS,
        revenue: v.REVENUE,
      })),
      byCustomer: gapOut(byCustomer),
      byCategory: gapOut(byCategory),
    });
  } catch (error) {
    console.error("ihs route failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
