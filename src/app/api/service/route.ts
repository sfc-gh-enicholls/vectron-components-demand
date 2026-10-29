import { NextRequest, NextResponse } from "next/server";
import { getContext } from "@/lib/data";
import { query } from "@/lib/snowflake";

export const dynamic = "force-dynamic";

/**
 * Service parts: which series are intermittent (Syntetos-Boylan), and how
 * Croston / SBA compare with VECTRON_STAT and the naive benchmark on MASE,
 * bias and upper-bound coverage. Reads APP.V_DEMAND_CLASS and
 * APP.V_SERVICE_ACCURACY / V_SERVICE_SCORED (snowflake/07c-service.sql).
 */

type ClassRow = { DEMAND_CLASS: string; CHANNEL_ID: string; N: number };
type AccRow = {
  MODEL_NAME: string; SERIES_ID: string; CHANNEL_ID: string; CUSTOMER_NAME: string;
  PRODUCT_NAME: string; DEMAND_CLASS: string; MASE: number | null; BIAS: number | null;
  UPPER_COVERAGE: number; ACTUAL_UNITS: number; ABS_ERROR: number;
};
type ScatterRow = { SERIES_ID: string; ADI: number; CV2: number; DEMAND_CLASS: string; CHANNEL_ID: string };
type WeekRow = { TARGET_WEEK_ID: string; MODEL_NAME: string; FORECAST_UNITS: number; ACTUAL_UNITS: number };

const MODELS = ["SBA", "CROSTON", "VECTRON_STAT", "NAIVE_SEASONAL"] as const;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export async function GET(request: NextRequest) {
  try {
    const [ctx, classes, acc, scatter] = await Promise.all([
      getContext(),
      query<ClassRow>(`SELECT DEMAND_CLASS, CHANNEL_ID, COUNT(*) AS N FROM APP.V_DEMAND_CLASS GROUP BY 1, 2`),
      query<AccRow>(`SELECT * FROM APP.V_SERVICE_ACCURACY`),
      query<ScatterRow>(
        `SELECT SERIES_ID, ADI, CV2, DEMAND_CLASS, CHANNEL_ID FROM APP.V_DEMAND_CLASS
         WHERE CHANNEL_ID <> 'CH-OE' AND ADI IS NOT NULL`,
      ),
    ]);

    const seriesIds = Array.from(new Set(acc.map((a) => a.SERIES_ID)));
    const requested = request.nextUrl.searchParams.get("series");
    // Default to the series where SBA gains most over the stat model.
    const gain = (sid: string) => {
      const s = acc.find((a) => a.SERIES_ID === sid && a.MODEL_NAME === "SBA");
      const t = acc.find((a) => a.SERIES_ID === sid && a.MODEL_NAME === "VECTRON_STAT");
      return (t?.MASE ?? 0) - (s?.MASE ?? 0);
    };
    const series = requested && seriesIds.includes(requested)
      ? requested
      : [...seriesIds].sort((a, b) => gain(b) - gain(a))[0] ?? null;

    // Lag-1 forecasts across the backtest for the selected series: what each
    // model said one week ahead, against what was ordered.
    const weeks = series
      ? await query<WeekRow>(
          `SELECT TARGET_WEEK_ID, MODEL_NAME, FORECAST_UNITS, ACTUAL_UNITS
           FROM APP.V_SERVICE_SCORED
           WHERE SERIES_ID = ? AND LAG_WEEKS = 1 AND MODEL_NAME IN ('SBA', 'VECTRON_STAT')
           ORDER BY 1`,
          [series],
        )
      : [];

    const byModel = MODELS.map((m) => {
      const rows = acc.filter((a) => a.MODEL_NAME === m);
      const actual = rows.reduce((s, r) => s + r.ACTUAL_UNITS, 0);
      const err = rows.reduce((s, r) => s + (r.BIAS ?? 0) * r.ACTUAL_UNITS, 0);
      return {
        model: m,
        series: rows.length,
        medianMase: median(rows.map((r) => r.MASE).filter((x): x is number => x != null)),
        // Volume-weighted bias: total over-forecast as a share of total actual.
        bias: actual ? err / actual : null,
        coverage: rows.length ? rows.reduce((s, r) => s + r.UPPER_COVERAGE, 0) / rows.length : null,
      };
    });
    const stat = new Map(acc.filter((a) => a.MODEL_NAME === "VECTRON_STAT").map((a) => [a.SERIES_ID, a]));
    const sba = acc.filter((a) => a.MODEL_NAME === "SBA");
    const wins = sba.filter((a) => (a.MASE ?? Infinity) < (stat.get(a.SERIES_ID)?.MASE ?? Infinity)).length;

    const weekMap = new Map<string, Record<string, number | string>>();
    for (const w of weeks) {
      const row = weekMap.get(w.TARGET_WEEK_ID) ?? { week: w.TARGET_WEEK_ID, actual: w.ACTUAL_UNITS };
      row[w.MODEL_NAME === "SBA" ? "sba" : "stat"] = w.FORECAST_UNITS;
      weekMap.set(w.TARGET_WEEK_ID, row);
    }

    return NextResponse.json({
      context: ctx,
      series,
      classes: classes.map((c) => ({ demandClass: c.DEMAND_CLASS, channel: c.CHANNEL_ID, n: c.N })),
      models: byModel,
      wins: { sba: wins, of: sba.length },
      scatter: scatter.map((s) => ({ seriesId: s.SERIES_ID, adi: s.ADI, cv2: s.CV2, demandClass: s.DEMAND_CLASS })),
      table: sba
        .map((a) => ({
          seriesId: a.SERIES_ID,
          label: `${a.PRODUCT_NAME} · ${a.CUSTOMER_NAME}`,
          channel: a.CHANNEL_ID,
          demandClass: a.DEMAND_CLASS,
          sbaMase: a.MASE,
          statMase: stat.get(a.SERIES_ID)?.MASE ?? null,
          sbaBias: a.BIAS,
          statBias: stat.get(a.SERIES_ID)?.BIAS ?? null,
        }))
        .sort((x, y) => ((y.statMase ?? 0) - (y.sbaMase ?? 0)) - ((x.statMase ?? 0) - (x.sbaMase ?? 0))),
      weeks: Array.from(weekMap.values()),
    });
  } catch (error) {
    console.error("service route failed:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
