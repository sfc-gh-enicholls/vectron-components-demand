/**
 * Chart series palette.
 *
 * These are CSS custom-property references, not literal hex, so every chart
 * re-tints with the active theme (Snowflake dark, Snowflake light, editorial).
 * Recharts passes stroke/fill straight through to SVG attributes, where var()
 * resolves normally — so `stroke={CHART_COLORS[0]}` continues to work unchanged.
 *
 * Do not reintroduce hex here: a literal would silently keep Snowflake blue in
 * the editorial theme, which is exactly the bug this replaces.
 */
export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

/**
 * Status badge classes, built from the semantic status tokens rather than from
 * Tailwind's fixed palette.
 *
 * This map is the highest-leverage file in the app for theming: every status
 * badge on every route reads from it, so hardcoding emerald/amber/red here
 * previously forced those hues into all three themes regardless of palette.
 */
const BADGE_POSITIVE = "bg-positive-subtle text-positive";
const BADGE_WARNING  = "bg-warning-subtle text-warning";
const BADGE_NEGATIVE = "bg-negative-subtle text-negative";
const BADGE_NEUTRAL  = "bg-neutral-subtle text-neutral";
const BADGE_ACCENT   = "bg-accent-subtle text-accent";

export const STATUS_CLASSES: Record<string, string> = {
  draft:      BADGE_ACCENT,
  in_review:  BADGE_WARNING,
  promoted:   BADGE_POSITIVE,
  discarded:  BADGE_NEUTRAL,
  // Approval requests and planning cycles (13-approvals.sql, 12-cycles.sql)
  submitted:         BADGE_WARNING,
  approved:          BADGE_POSITIVE,
  rejected:          BADGE_NEGATIVE,
  changes_requested: BADGE_WARNING,
  withdrawn:         BADGE_NEUTRAL,
  open:              BADGE_ACCENT,
  signed_off:        BADGE_POSITIVE,
  Open:       BADGE_ACCENT,
  Locked:     BADGE_POSITIVE,
  InReview:   BADGE_WARNING,
  Overdue:    BADGE_NEGATIVE,
  Complete:   BADGE_POSITIVE,
  Blocked:    BADGE_NEGATIVE,
  PASS:       BADGE_POSITIVE,
  WARN:       BADGE_WARNING,
  WATCH:      BADGE_WARNING,
  FAIL:       BADGE_NEGATIVE,
  UNKNOWN:    BADGE_NEUTRAL,
  EXCELLENT:  BADGE_POSITIVE,
  GOOD:       BADGE_POSITIVE,
  FAIR:       BADGE_WARNING,
  POOR:       BADGE_NEGATIVE,
  // Product lifecycle, from DIM_PRODUCT.LIFECYCLE_STATUS
  Mature:     BADGE_NEUTRAL,
  Growth:     BADGE_POSITIVE,
  Launch:     BADGE_ACCENT,
  Decline:    BADGE_WARNING,
  Delisted:   BADGE_NEGATIVE,
};

/**
 * Category identity colours, mapped onto the chart series tokens.
 *
 * Categories need to stay visually distinguishable from each other, which the
 * six-step chart ramp provides, while still re-tinting per theme. Keys match
 * DIM_CATEGORY.CATEGORY_NAME exactly.
 *
 * Five categories against six ramp steps: one hue each, no repeats. Colour is
 * still never the only encoding on a chart here.
 */
export const CATEGORY_COLORS: Record<string, string> = {
  "Brake systems":        "var(--chart-1)",
  "Chassis & suspension": "var(--chart-2)",
  Steering:               "var(--chart-3)",
  "ICE powertrain":       "var(--chart-4)",
  "E-drive":              "var(--chart-5)",
};

/** Signal and exception severity, ordered most to least urgent. */
export const SEVERITY_CLASSES: Record<string, string> = {
  Critical: BADGE_NEGATIVE,
  High:     BADGE_WARNING,
  Medium:   BADGE_ACCENT,
  Low:      BADGE_NEUTRAL,
};

export const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low"] as const;

/** ABC/XYZ segment badges. A and X are the ones that deserve attention. */
export const SEGMENT_CLASSES: Record<string, string> = {
  A: BADGE_ACCENT, B: BADGE_NEUTRAL, C: BADGE_NEUTRAL,
  X: BADGE_POSITIVE, Y: BADGE_NEUTRAL, Z: BADGE_WARNING,
};

/**
 * Volume in pieces, the unit OEM call-offs and EDI releases are stated in.
 */
export function formatUnits(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M pcs`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(0)}k pcs`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k pcs`;
  return `${Math.round(value).toLocaleString("en-GB")} pcs`;
}

/** Net sales value in euros, Vectron's reporting currency. */
export function formatEur(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}\u20AC${(abs / 1_000_000_000).toFixed(2)}bn`;
  if (abs >= 1_000_000) return `${sign}\u20AC${(abs / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${sign}\u20AC${(abs / 1_000).toFixed(0)}k`;
  return `${sign}\u20AC${abs.toFixed(0)}`;
}

/** Signed percentage, for deltas where direction carries the meaning. */
export function formatSignedPercent(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(dp)}%`;
}

/**
 * ISO week label. "2026-W07" reads as "W07 · 2026", which is how planners
 * say it, and keeps the week number as the salient part.
 */
export function formatWeek(weekId: string | null | undefined): string {
  if (!weekId) return "—";
  const [year, week] = weekId.split("-");
  return week ? `${week} \u00B7 ${year}` : weekId;
}

/** Short week label for dense chart axes. */
export function formatWeekShort(weekId: string | null | undefined): string {
  if (!weekId) return "";
  const [, week] = weekId.split("-");
  return week ?? weekId;
}

// Formatters
export function formatRevenue(value: number, currency = "USD"): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

export function formatMAPE(value: number): string {
  // value is a decimal e.g. 0.153 → "15.3%"
  return `${(value * 100).toFixed(1)}%`;
}

export function formatMonthLabel(dateStr: string): string {
  // Append time to avoid UTC parsing shift in UTC- timezones
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
  });
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatValue(
  units: number,
  valueMode: "units" | "revenue",
  asp: number,
): string {
  if (valueMode === "revenue") {
    return formatRevenue(units * asp);
  }
  return formatUnits(units);
}

// RAG (Red/Amber/Green) utility for gap vs. target.
// Token-driven so the bands follow the active theme's semantic palette.
export function ragClass(gapPct: number): string {
  if (gapPct >= -0.05) return "text-positive";
  if (gapPct >= -0.15) return "text-warning";
  return "text-negative";
}
