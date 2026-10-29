/**
 * Domain types and shared query helpers.
 *
 * Every query here that reads ML.FACT_FORECAST filters on MODEL_NAME. That
 * column is part of the table's primary key, so omitting it does not error —
 * it silently multiplies rows and produces a plausible wrong number.
 */
import { query } from "@/lib/snowflake";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------
export interface PlanningContext {
  HISTORY_END_WEEK: string;
  CURRENT_WEEK: string;
  HORIZON_END_WEEK: string;
  PRODUCTION_MODEL: string;
  BENCHMARK_MODEL: string;
}

export interface SeriesRow {
  SERIES_ID: string;
  SERIES_LABEL: string;
  PRODUCT_NAME: string;
  PRODUCT_LINE: string;
  CUSTOMER_NAME: string;
  CHANNEL_NAME: string;
  CATEGORY_NAME: string;
  PRICE_TIER: string;
  SEGMENT_ABC: string;
  SEGMENT_XYZ: string;
  SEGMENT: string;
  LIFECYCLE_STATUS: string;
  BASE_ANNUAL_UNITS: number;
  BASE_ANNUAL_VALUE_EUR: number;
  UNIT_PRICE_EUR: number;
}

export interface DriverContribution {
  DRIVER: string;
  DRIVER_LABEL: string;
  DRIVER_ORDER: number;
  CONTRIB_UNITS: number;
  IS_MODELLED_INPUT: boolean;
}

export interface SensingSignal {
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

export interface AccuracyByLag {
  MODEL_NAME: string;
  LAG_WEEKS: number;
  N_OBS: number;
  WAPE: number;
  BIAS: number;
  INTERVAL_COVERAGE: number;
}

export interface FvaSummary {
  NAIVE_WAPE: number;
  STAT_WAPE: number;
  CONSENSUS_WAPE: number;
  MODEL_FVA: number;
  PLANNER_FVA: number;
}

export interface IntegrityCheck {
  CHECK_NAME: string;
  VIOLATIONS: number;
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

/**
 * The planning anchor. Everything time-relative derives from this rather than
 * from the server clock, so the app stays coherent against a fixed dataset.
 */
export async function getContext(): Promise<PlanningContext> {
  const rows = await query<PlanningContext>(
    `SELECT HISTORY_END_WEEK, CURRENT_WEEK, HORIZON_END_WEEK,
            PRODUCTION_MODEL, BENCHMARK_MODEL
     FROM APP.V_CONTEXT`,
  );
  if (!rows.length) throw new Error("APP.V_CONTEXT returned no rows");
  return rows[0];
}

/** Data-integrity assertions, surfaced rather than trusted. */
export async function getIntegrity(): Promise<IntegrityCheck[]> {
  return query<IntegrityCheck>(
    `SELECT CHECK_NAME, VIOLATIONS FROM APP.V_DATA_INTEGRITY`,
  );
}

/**
 * Week list between two week ids, in calendar order. Used to build dense
 * chart axes so a week with no data renders as a gap rather than being
 * silently dropped and distorting the line.
 */
export async function getWeeks(from: string, to: string) {
  return query<{ WEEK_ID: string; WEEK_START_DATE: string; ISO_WEEK: number }>(
    `SELECT WEEK_ID, WEEK_START_DATE, ISO_WEEK
     FROM CORE.DIM_WEEK
     WHERE WEEK_ID BETWEEN ? AND ?
     ORDER BY WEEK_START_DATE`,
    [from, to],
  );
}

/**
 * Filter clause builder for the product/customer/channel/category selectors that
 * every route shares. Returns a fragment plus binds so callers cannot
 * accidentally interpolate user input into SQL.
 */
export interface SeriesFilter {
  category?: string | null;
  customer?: string | null;
  channel?: string | null;
  product?: string | null;
  segment?: string | null;
}

export function buildSeriesFilter(
  f: SeriesFilter,
  alias = "s",
): { clause: string; binds: string[] } {
  const parts: string[] = [];
  const binds: string[] = [];
  if (f.category) { parts.push(`${alias}.CATEGORY_NAME = ?`); binds.push(f.category); }
  if (f.customer)   { parts.push(`${alias}.CUSTOMER_NAME = ?`);   binds.push(f.customer); }
  if (f.channel)  { parts.push(`${alias}.CHANNEL_NAME = ?`);  binds.push(f.channel); }
  if (f.product)    { parts.push(`${alias}.PRODUCT_LINE = ?`);  binds.push(f.product); }
  if (f.segment)  { parts.push(`${alias}.SEGMENT_ABC = ?`);   binds.push(f.segment); }
  return { clause: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds };
}

export function readFilter(searchParams: URLSearchParams): SeriesFilter {
  return {
    category: searchParams.get("category"),
    customer: searchParams.get("customer"),
    channel: searchParams.get("channel"),
    product: searchParams.get("product"),
    segment: searchParams.get("segment"),
  };
}

/** Selector options, so the UI never offers a filter that returns nothing. */
export async function getFilterOptions() {
  const [categories, customers, channels, products] = await Promise.all([
    query<{ V: string }>(`SELECT DISTINCT CATEGORY_NAME AS V FROM APP.V_SERIES ORDER BY 1`),
    query<{ V: string }>(`SELECT DISTINCT CUSTOMER_NAME AS V FROM APP.V_SERIES ORDER BY 1`),
    query<{ V: string }>(`SELECT DISTINCT CHANNEL_NAME AS V FROM APP.V_SERIES ORDER BY 1`),
    query<{ V: string }>(`SELECT DISTINCT PRODUCT_LINE AS V FROM APP.V_SERIES ORDER BY 1`),
  ]);
  return {
    categories: categories.map((r) => r.V),
    customers: customers.map((r) => r.V),
    channels: channels.map((r) => r.V),
    products: products.map((r) => r.V),
  };
}
