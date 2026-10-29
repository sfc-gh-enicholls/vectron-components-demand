"use client";

import * as React from "react";
import Link from "next/link";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  TrendingUp, TrendingDown, Minus, AlertTriangle, RadioTower, ArrowRight,
} from "lucide-react";
import { PageBanner } from "@/components/page-banner";
import { Kpi, KpiRow } from "@/components/kpi";
import { PageSkeleton } from "@/components/page-skeleton";
import { BulletChart } from "@/components/bullet-chart";
import { Sparkline } from "@/components/sparkline";
import { WhyThis } from "@/components/why-this";
import {
  HierarchyFilter, pathLabel, pathToParams,
  type HierarchyOptions, type HierarchyPath,
} from "@/components/hierarchy-filter";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatUnits, formatEur, formatPercent, formatSignedPercent, formatWeekShort,
  SEVERITY_CLASSES, SEVERITY_ORDER, SEGMENT_CLASSES, CHART_COLORS,
} from "@/lib/format";
import { cn } from "@/lib/utils";

interface TrendPoint {
  WEEK_ID: string;
  POS_UNITS: number | null;
  PLAN_UNITS: number | null;
  LOWER_95: number | null;
  UPPER_95: number | null;
}

interface CockpitData {
  context: {
    HISTORY_END_WEEK: string; CURRENT_WEEK: string;
    HORIZON_END_WEEK: string; PRODUCTION_MODEL: string;
  };
  scope: { path: HierarchyPath; label: string };
  options: { hierarchy: HierarchyOptions };
  kpi: {
    planUnits: number; planValueEur: number; seriesCount: number;
    baselineUnits: number; overrideUnits: number;
    lastYearUnits: number; lastYearValueEur: number;
    wape: number | null; bias: number | null; coverage: number | null;
  };
  /** Null when the scope has no backtest history. */
  fva: {
    naiveWape: number | null; statWape: number | null; consensusWape: number | null;
    modelFva: number | null; plannerFva: number | null;
  } | null;
  signals: Array<{ severity: string; count: number; valueAtRisk: number }>;
  exceptions: Array<{
    SERIES_ID: string; SERIES_LABEL: string; PRODUCT_NAME: string;
    CUSTOMER_NAME: string; CHANNEL_NAME: string; CATEGORY_NAME: string;
    SEGMENT_ABC: string;
    GAP_UNITS: number; GAP_VALUE_EUR: number; GAP_PCT: number;
    PLAN_UNITS_8WK: number; STAT_UNITS_8WK: number;
    REASON_LABEL: string | null; PLANNER: string | null;
  }>;
  trend: TrendPoint[];
  integrity: Array<{ CHECK_NAME: string; VIOLATIONS: number }>;
}

/** Direction is paired with a shape, never carried by colour alone. */
function Direction({ value }: { value: number | null }) {
  if (value === null || Math.abs(value) < 0.001) {
    return <Minus size={13} className="text-neutral" aria-hidden="true" />;
  }
  return value > 0 ? (
    <TrendingUp size={13} className="text-positive" aria-hidden="true" />
  ) : (
    <TrendingDown size={13} className="text-negative" aria-hidden="true" />
  );
}

function signClass(value: number | null): string {
  if (value === null || value === 0) return "text-neutral";
  return value > 0 ? "text-positive" : "text-negative";
}

/**
 * WAPE and coverage arrive as fractions, but formatPercent expects a value
 * already in percent: passed 0.165 directly it prints "0.2%", not "16.5%".
 */
function formatRate(value: number | null, decimals = 1): string {
  return value === null ? "—" : formatPercent(value * 100, decimals);
}

function LoadError({ title, message }: { title: string; message: string }) {
  return (
    <Card className="border-negative/40 bg-negative-subtle p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
        <div className="text-sm">
          <p className="font-medium text-negative">{title}</p>
          <p className="mt-1 text-text-tertiary">{message}</p>
          <p className="mt-2 text-text-tertiary">
            Check that VECTRON_DEMAND is reachable and the APP views exist.
          </p>
        </div>
      </div>
    </Card>
  );
}

/**
 * Stands in for the body while a new scope loads. The banner and the scope
 * filter stay mounted, so this mirrors only what sits below them.
 */
function CockpitSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-2.5 w-36" />
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-64 w-full" />
        </Card>
        <Card className="p-4">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-2.5 w-2/3" />
        </Card>
      </div>
      <Card className="p-4">
        <Skeleton className="h-3 w-48" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </Card>
      <span className="sr-only">Loading</span>
    </div>
  );
}

export default function CockpitPage() {
  const [path, setPath] = React.useState<HierarchyPath>({});
  const [data, setData] = React.useState<CockpitData | null>(null);
  // The query `data` was loaded for. While it differs from the current one the
  // figures belong to another scope, so the body shows a skeleton instead.
  const [loadedQuery, setLoadedQuery] = React.useState<string | null>(null);
  const [error, setError] = React.useState<{ query: string; message: string } | null>(null);

  const queryString = new URLSearchParams(pathToParams(path)).toString();

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(queryString ? `/api/cockpit?${queryString}` : "/api/cockpit");
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError({ query: queryString, message: json.error ?? "Failed to load" });
          return;
        }
        setData(json);
        setLoadedQuery(queryString);
        setError(null);
      } catch (e) {
        if (!cancelled) setError({ query: queryString, message: (e as Error).message });
      }
    })();
    return () => { cancelled = true; };
  }, [queryString]);

  const failed = error !== null && error.query === queryString ? error.message : null;

  if (!data) {
    if (failed) {
      return (
        <div className="p-6">
          <LoadError title="Could not load the cockpit" message={failed} />
        </div>
      );
    }
    return <div className="p-6"><PageSkeleton kpis={4} chart rows={6} /></div>;
  }

  const pending = !failed && loadedQuery !== queryString;
  const scopeLabel = pathLabel(path);
  const { context, integrity } = data;
  const failing = integrity.filter((c) => c.VIOLATIONS > 0);

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Demand planning"
        headline="Cockpit"
        subtitle={`Weekly plan for the next 8 weeks. Actuals complete to ${context.HISTORY_END_WEEK}; current week is ${context.CURRENT_WEEK}.`}
        icon={<RadioTower size={18} aria-hidden="true" />}
      />

      {failing.length > 0 && (
        <Card className="border-negative/40 bg-negative-subtle p-3">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={15} className="mt-0.5 text-negative" aria-hidden="true" />
            <div>
              <span className="font-medium text-negative">Data integrity failure.</span>{" "}
              <span className="text-text-tertiary">
                {failing.map((c) => `${c.CHECK_NAME} (${c.VIOLATIONS})`).join(", ")}.
                Figures on this page may be unreliable. These checks run across the
                whole portfolio and are not affected by the scope.
              </span>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div>
          <p className="text-xs text-text-tertiary">Portfolio scope</p>
          <HierarchyFilter
            path={path}
            options={data.options.hierarchy}
            onChange={setPath}
            className="mt-1"
          />
        </div>
      </Card>

      {failed ? (
        <LoadError title={`Could not load ${scopeLabel}`} message={failed} />
      ) : pending ? (
        <CockpitSkeleton />
      ) : (
        <CockpitBody data={data} scopeLabel={scopeLabel} />
      )}
    </div>
  );
}

/** Everything below the scope filter, for one loaded scope. */
function CockpitBody({ data, scopeLabel }: { data: CockpitData; scopeLabel: string }) {
  const { kpi, fva, signals, exceptions, trend, context } = data;

  // A valid path can still be impossible: a product plus a customer it is not sold in.
  if (kpi.seriesCount === 0 && trend.length === 0 && signals.length === 0) {
    return (
      <Card className="p-4">
        <div className="py-8 text-center">
          <p className="text-sm text-text-tertiary">Nothing is planned in {scopeLabel}.</p>
          <p className="mt-1 text-xs text-text-tertiary">
            No planning series matches every level of this scope, usually a product
            in a customer or channel it is not sold in. Widen the scope above.
          </p>
        </div>
      </Card>
    );
  }

  // Null, not zero, when the scope sold nothing in those weeks last year: a
  // launch has no like-for-like baseline, and "+0.0%" would claim one.
  const volumeDelta = kpi.lastYearUnits > 0
    ? kpi.planUnits / kpi.lastYearUnits - 1 : null;
  const actualSpark = trend.filter((t) => t.POS_UNITS !== null).map((t) => t.POS_UNITS);
  const totalSignals = signals.reduce((s, r) => s + r.count, 0);

  // The band is rendered as an Area from LOWER_95 to UPPER_95. Recharts needs
  // the lower edge drawn transparently first, then the span on top.
  const chartData = trend.map((t) => ({
    ...t,
    BAND_BASE: t.LOWER_95,
    BAND_SPAN: t.LOWER_95 !== null && t.UPPER_95 !== null
      ? t.UPPER_95 - t.LOWER_95 : null,
  }));
  const firstForwardWeek = trend.find((t) => t.PLAN_UNITS !== null)?.WEEK_ID;

  const accuracyRationale = fva && fva.naiveWape !== null && fva.modelFva !== null
    ? `Volume-weighted absolute percentage error of ${context.PRODUCTION_MODEL} at a 4-week horizon. The seasonal-naive benchmark scores ${formatRate(fva.naiveWape)}, so the model is ${fva.modelFva >= 0 ? "adding" : "losing"} ${formatRate(Math.abs(fva.modelFva))} of accuracy. Scope: ${scopeLabel}.`
    : `Volume-weighted absolute percentage error at a 4-week horizon. Scope: ${scopeLabel}.`;

  return (
    <>
      {/* ---------------- KPI row ---------------- */}
      <KpiRow>
        <Kpi
          label="8-week plan volume"
          value={formatUnits(kpi.planUnits)}
          why={{
            subject: "8-week plan volume",
            source: "APP.V_PLAN_FORWARD, committed plan",
            rationale: `Sum of the committed weekly plan across every active series for the next eight weeks, in pieces. Scope: ${scopeLabel}.`,
            formatValue: formatUnits,
            drivers: [
              { label: "Statistical baseline", contribution: kpi.baselineUnits },
              { label: "Planner overrides", contribution: kpi.overrideUnits },
            ],
            noDriversLabel: "No overrides in this horizon",
          }}
          detail={volumeDelta === null ? (
            "No sales in the same weeks last year"
          ) : (
            <>
              <Direction value={volumeDelta} />
              <span className={signClass(volumeDelta)}>{formatSignedPercent(volumeDelta)}</span>
              <span>vs same weeks last year</span>
            </>
          )}
        />

        <Kpi
          label="8-week plan value"
          value={formatEur(kpi.planValueEur)}
          detail={`${kpi.seriesCount.toLocaleString("en-GB")} planning series`}
        />

        <Kpi
          label="WAPE at 4 weeks"
          value={formatRate(kpi.wape)}
          why={{
            subject: "Forecast accuracy at 4 weeks",
            source: "Rolling-origin backtest, scoped",
            rationale: accuracyRationale,
            formatValue: (v) => formatRate(v),
            noDriversLabel: "Computed from backtest residuals, not decomposed by driver",
          }}
          detail={kpi.wape === null
            ? "No backtest history in this scope"
            : `Bias ${formatSignedPercent(kpi.bias)} · band covers ${formatRate(kpi.coverage, 0)}`}
        />

        <Kpi
          label="Signals to review"
          value={totalSignals.toLocaleString("en-GB")}
          detail={totalSignals === 0 ? "Nothing flagged in this scope" : (
            <span className="flex flex-wrap gap-1">
              {SEVERITY_ORDER.map((sev) => {
                const row = signals.find((s) => s.severity === sev);
                if (!row) return null;
                return (
                  <span
                    key={sev}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[11px] tabular-nums",
                      SEVERITY_CLASSES[sev],
                    )}
                  >
                    {row.count} {sev.toLowerCase()}
                  </span>
                );
              })}
            </span>
          )}
        />
      </KpiRow>

      {/* ---------------- Trend + bullets ---------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex items-baseline justify-between">
            <div>
              <h2 className="card-title">
                OE pull and forward plan
              </h2>
              <p className="text-xs text-text-tertiary">
                26 weeks of actuals, then the committed plan with its 95% interval
                {" · "}{scopeLabel}
              </p>
            </div>
            <Sparkline
              data={actualSpark}
              width={80}
              height={22}
              stroke={CHART_COLORS[0]}
              label="Recent pull trend"
            />
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                {/* Horizontal grid lines only, hairline weight. */}
                <CartesianGrid
                  vertical={false}
                  stroke="var(--chart-grid)"
                  strokeWidth={0.5}
                />
                <XAxis
                  dataKey="WEEK_ID"
                  tickFormatter={formatWeekShort}
                  tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                  interval={3}
                  stroke="var(--chart-grid)"
                />
                <YAxis
                  tickFormatter={(v) => formatUnits(v).replace(" pcs", "")}
                  tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                  stroke="var(--chart-grid)"
                  width={48}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(value, name) => {
                    if (value === null || value === undefined) return ["—", name];
                    return [formatUnits(Number(value)), name];
                  }}
                />
                {firstForwardWeek && (
                  <ReferenceLine
                    x={firstForwardWeek}
                    stroke="var(--chart-grid)"
                    strokeDasharray="3 3"
                    label={{
                      value: "plan starts",
                      position: "insideTopRight",
                      fontSize: 10,
                      fill: "var(--text-tertiary)",
                    }}
                  />
                )}
                <Area
                  dataKey="BAND_BASE" stackId="band" stroke="none"
                  fill="transparent" name="  " isAnimationActive={false}
                  legendType="none"
                />
                <Area
                  dataKey="BAND_SPAN" stackId="band" stroke="none"
                  fill="var(--chart-band)" name="95% interval"
                  isAnimationActive={false}
                />
                <Line
                  dataKey="POS_UNITS" name="Actual pull"
                  stroke={CHART_COLORS[0]} strokeWidth={1.75} dot={false}
                  connectNulls={false} isAnimationActive={false}
                />
                <Line
                  dataKey="PLAN_UNITS" name="Committed plan"
                  stroke={CHART_COLORS[1]} strokeWidth={1.75}
                  strokeDasharray="4 3" dot={false}
                  connectNulls={false} isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="space-y-4 p-4">
          <div>
            <h2 className="card-title">Plan versus last year</h2>
            <p className="text-xs text-text-tertiary">
              Same eight calendar weeks, a year earlier
            </p>
          </div>
          {kpi.lastYearUnits > 0 ? (
            <>
              <BulletChart
                actual={kpi.planUnits}
                target={kpi.lastYearUnits}
                tolerance={0.05}
                label="Volume (pcs)"
                valueLabel={formatUnits(kpi.planUnits)}
              />
              <BulletChart
                actual={kpi.planValueEur}
                target={kpi.lastYearValueEur}
                tolerance={0.05}
                label="Net sales value"
                valueLabel={formatEur(kpi.planValueEur)}
              />
            </>
          ) : (
            <p className="text-xs text-text-tertiary">
              Nothing in this scope sold in those weeks last year, so there is no
              like-for-like target to compare the plan against.
            </p>
          )}
          {fva && (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-xs font-medium">Forecast value add</p>
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-tertiary">Model over benchmark</span>
                <span className="flex items-center gap-1 tabular-nums">
                  <Direction value={fva.modelFva} />
                  <span className={signClass(fva.modelFva)}>
                    {formatSignedPercent(fva.modelFva)}
                  </span>
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-tertiary">Planner over model</span>
                <span className="flex items-center gap-1 tabular-nums">
                  <Direction value={fva.plannerFva} />
                  <span className={signClass(fva.plannerFva)}>
                    {formatSignedPercent(fva.plannerFva)}
                  </span>
                </span>
              </div>
              <Link
                href="/accuracy"
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                See accuracy detail <ArrowRight size={12} aria-hidden="true" />
              </Link>
            </div>
          )}
        </Card>
      </div>

      {/* ---------------- Exceptions ---------------- */}
      <Card className="p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <h2 className="card-title">
              Largest plan-versus-model gaps
            </h2>
            <p className="text-xs text-text-tertiary">
              Where a human has moved the number most, by value over eight weeks
              {" · "}{scopeLabel}
            </p>
          </div>
          <Link
            href="/review"
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            Open demand review <ArrowRight size={12} aria-hidden="true" />
          </Link>
        </div>

        {exceptions.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-text-tertiary">
              No series in this scope differs from the model by more than 5%.
            </p>
            <p className="mt-1 text-xs text-text-tertiary">
              The committed plan is tracking the statistical baseline.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-tertiary">
                  <th className="py-2 text-left font-medium">Series</th>
                  <th className="py-2 text-left font-medium">Segment</th>
                  <th className="num py-2 font-medium">Plan</th>
                  <th className="num py-2 font-medium">Model</th>
                  <th className="num py-2 font-medium">Gap</th>
                  <th className="num py-2 font-medium">Value</th>
                  <th className="py-2 text-left font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((e) => (
                  <tr key={e.SERIES_ID} className="border-b border-border/50">
                    <td className="py-2">
                      <span className="font-medium">{e.PRODUCT_NAME}</span>
                      {/* Channel too: one product and customer can appear once per channel. */}
                      <span className="text-text-tertiary">
                        {" · "}{e.CUSTOMER_NAME}{" · "}{e.CHANNEL_NAME}
                      </span>
                    </td>
                    <td className="py-2">
                      <span className={cn(
                        "rounded px-1.5 py-0.5 text-[11px]",
                        SEGMENT_CLASSES[e.SEGMENT_ABC],
                      )}>
                        {e.SEGMENT_ABC}
                      </span>
                    </td>
                    <td className="num py-2 tabular-nums">
                      {formatUnits(e.PLAN_UNITS_8WK)}
                    </td>
                    <td className="num py-2 tabular-nums text-text-tertiary">
                      {formatUnits(e.STAT_UNITS_8WK)}
                    </td>
                    <td className="num py-2 tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <Direction value={e.GAP_PCT} />
                        {formatSignedPercent(e.GAP_PCT)}
                      </span>
                    </td>
                    <td className="num py-2 tabular-nums">
                      {formatEur(e.GAP_VALUE_EUR)}
                    </td>
                    <td className="py-2 text-xs text-text-tertiary">
                      {e.REASON_LABEL ?? "No reason recorded"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
