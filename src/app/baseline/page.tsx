"use client";

import * as React from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, AlertTriangle, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Kpi, KpiRow } from "@/components/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import {
  HierarchyFilter,
  pathLabel,
  pathToParams,
  type HierarchyOptions,
  type HierarchyPath,
} from "@/components/hierarchy-filter";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
import { Sparkline } from "@/components/sparkline";
import {
  CHART_COLORS,
  formatUnits,
  formatEur,
  formatPercent,
  formatSignedPercent,
  formatWeekShort,
} from "@/lib/format";
import { cn } from "@/lib/utils";

interface BaselineData {
  context: {
    HISTORY_END_WEEK: string;
    CURRENT_WEEK: string;
    HORIZON_END_WEEK: string;
  };
  options: {
    hierarchy: HierarchyOptions;
  };
  kpis: {
    baselineUnits: number;
    wape: number | null;
    coverage: number | null;
    unreliableSeries: number;
  };
  seriesInScope: number;
  seriesOptions: Array<{
    seriesId: string;
    label: string;
    productName: string;
    customerName: string;
    channelName: string;
    segment: string;
    baseAnnualValueEur: number;
  }>;
  trendBySeries: Record<string, Array<{
    WEEK_ID: string;
    POS_UNITS: number | null;
    STAT_UNITS: number | null;
    LOWER_95: number | null;
    UPPER_95: number | null;
  }>>;
  segmentation: Array<{
    segmentAbc: string;
    segmentXyz: string;
    seriesCount: number;
    valueEur: number;
  }>;
  health: Array<{
    seriesId: string;
    label: string;
    productName: string;
    customerName: string;
    segment: string;
    wape: number | null;
    bias: number | null;
    coverage: number | null;
  }>;
  sparklineBySeries: Record<string, Array<number | null>>;
  integrity: Array<{ CHECK_NAME: string; VIOLATIONS: number }>;
}

type SeriesOption = BaselineData["seriesOptions"][number];

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

function cellStyle(value: number, maxValue: number): React.CSSProperties {
  if (value <= 0 || maxValue <= 0) return { backgroundColor: "var(--bg-elevated)" };
  const share = value / maxValue;
  return {
    background: `color-mix(in srgb, var(--accent) ${(12 + share * 30).toFixed(0)}%, var(--bg-elevated))`,
  };
}

/**
 * A picker option named by the levels the scope leaves open, so under
 * Cognac / Martell VS the list reads "China · On-Trade", the next step down the
 * drill, rather than repeating the product on every line.
 */
function seriesOptionLabel(option: SeriesOption, path: HierarchyPath): string {
  const open = [
    path.PRODUCT_NAME ? null : option.productName,
    path.CUSTOMER_NAME ? null : option.customerName,
    path.CHANNEL_NAME ? null : option.channelName,
  ].filter((part): part is string => Boolean(part));
  // Nothing fixed below category, or every level fixed: the full label reads best.
  return open.length === 0 || open.length === 3 ? option.label : open.join(" · ");
}

function pickerNote(shown: number, inScope: number): string {
  if (inScope > shown) return `Top ${shown} of ${inScope.toLocaleString("en-GB")} in scope, by annual value`;
  if (inScope === 1) return "The only series in scope";
  return `All ${inScope.toLocaleString("en-GB")} series in scope, by annual value`;
}

/**
 * Holds the page's shape while a new scope loads, so the previous scope's
 * figures never sit under the new scope's label.
 */
function ScopeSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-24" />
            <Skeleton className="mt-1.5 h-2.5 w-16" />
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <Card className="p-4">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-3 h-72 w-full" />
        </Card>
        <Card className="p-4">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="mt-4 h-48 w-full" />
        </Card>
      </div>
      <Card className="space-y-2 p-4">
        <Skeleton className="h-3 w-32" />
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </Card>
      <span className="sr-only">Loading</span>
    </div>
  );
}

export default function BaselinePage() {
  const [data, setData] = React.useState<BaselineData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [path, setPath] = React.useState<HierarchyPath>({});
  const [selectedSeriesId, setSelectedSeriesId] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(pathToParams(path))) {
          params.set(key, value);
        }
        const res = await fetch(`/api/baseline?${params.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? "Failed to load");
          return;
        }
        const next = json as BaselineData;
        setData(next);
        // Keep the planner's series while it is still in scope, else fall back to
        // the scope's largest. Read through the updater so the selection never
        // becomes a dependency of this fetch.
        setSelectedSeriesId((current) => (
          next.seriesOptions.some((option) => option.seriesId === current)
            ? current
            : (next.seriesOptions[0]?.seriesId ?? "")
        ));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error && !data) {
    return (
      <div className="p-6">
        <Card className="border-negative/40 bg-negative-subtle p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium text-negative">Could not load the baseline view</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
              <p className="mt-2 text-text-tertiary">
                Check that VECTRON_DEMAND is reachable and that forecast data exists for VECTRON_STAT.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!data) return <div className="p-6"><PageSkeleton kpis={4} chart rows={8} /></div>;

  const scope = pathLabel(path);
  const ready = !loading && !error;
  const failing = data.integrity.filter((row) => row.VIOLATIONS > 0);
  const selectedSeries = data.seriesOptions.find((row) => row.seriesId === selectedSeriesId) ?? data.seriesOptions[0] ?? null;
  const seriesTrend = selectedSeries ? data.trendBySeries[selectedSeries.seriesId] ?? [] : [];
  const chartData = seriesTrend.map((row) => ({
    ...row,
    BAND_BASE: row.LOWER_95,
    BAND_SPAN: row.LOWER_95 !== null && row.UPPER_95 !== null ? row.UPPER_95 - row.LOWER_95 : null,
  }));
  const firstForwardWeek = chartData.find((row) => row.STAT_UNITS !== null)?.WEEK_ID;
  const maxMatrixValue = Math.max(...data.segmentation.map((row) => row.valueEur), 0);
  const matrix = new Map(data.segmentation.map((row) => [`${row.segmentAbc}-${row.segmentXyz}`, row]));

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Demand planning"
        headline="Baseline"
        subtitle={`Statistical forecast health. Actuals are complete to ${data.context.HISTORY_END_WEEK}; forward horizon runs to ${data.context.HORIZON_END_WEEK}.`}
        icon={<Activity size={18} aria-hidden="true" />}
      />

      <Card className="p-4">
        <p className="text-xs text-text-tertiary">Portfolio scope</p>
        <HierarchyFilter
          path={path}
          options={data.options.hierarchy}
          onChange={setPath}
          className="mt-1"
        />
      </Card>

      {failing.length > 0 && (
        <Card className="border-negative/40 bg-negative-subtle p-3">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={15} className="mt-0.5 text-negative" aria-hidden="true" />
            <div>
              <span className="font-medium text-negative">Data integrity failure.</span>{" "}
              <span className="text-text-tertiary">
                {failing.map((row) => `${row.CHECK_NAME} (${row.VIOLATIONS})`).join(", ")}. These checks run portfolio-wide, whatever the scope. Use the figures here cautiously until those checks clear.
              </span>
            </div>
          </div>
        </Card>
      )}

      {loading && <ScopeSkeleton />}

      {!loading && error && (
        <Card className="border-negative/40 bg-negative-subtle p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium text-negative">Could not load the baseline for {scope}</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
            </div>
          </div>
        </Card>
      )}

      {ready && data.seriesInScope === 0 && (
        <Card className="p-4">
          <div className="py-8 text-center">
            <p className="text-sm text-text-tertiary">No series match {scope}.</p>
            <p className="mt-1 text-xs text-text-tertiary">
              That combination does not exist in the series master, so there is no baseline to show. Set one of the levels back to All to widen the scope.
            </p>
          </div>
        </Card>
      )}

      {ready && data.seriesInScope > 0 && (
        <>
          <KpiRow>
            <Kpi
              label="Forward baseline"
              value={formatUnits(data.kpis.baselineUnits)}
              why={{
                subject: "Forward baseline volume",
                source: "APP.V_PLAN_FORWARD",
                rationale: `Sum of VECTRON_STAT baseline units across the forward horizon for ${scope}. This is the model's starting point before planner overrides.`,
                formatValue: formatUnits,
                noDriversLabel: "No driver breakdown is stored for this aggregate",
              }}
              detail="VECTRON_STAT over the horizon"
            />

            <Kpi
              label="WAPE at lag 4"
              value={data.kpis.wape !== null ? formatPercent(data.kpis.wape * 100) : "—"}
              why={{
                subject: "WAPE at lag 4",
                source: "APP.V_ACCURACY_BY_LAG, scoped",
                rationale: `Volume-weighted absolute percentage error at a four-week horizon for ${scope}, recomputed from the backtest with the view's definition. It answers whether the statistical baseline is accurate enough to trust without manual rescue.`,
                formatValue: (value) => formatPercent(value * 100),
                noDriversLabel: "Backtest accuracy is not decomposed into drivers",
              }}
              detail="Lower is better"
            />

            <Kpi
              label="Interval coverage"
              value={data.kpis.coverage !== null ? formatPercent(data.kpis.coverage * 100, 0) : "—"}
              why={{
                subject: "Interval coverage",
                source: "APP.V_ACCURACY_BY_LAG, scoped",
                rationale: `Share of lag-4 actuals for ${scope} that landed inside the model's 95% interval. If coverage is weak, the band is too optimistic.`,
                formatValue: (value) => formatPercent(value * 100, 0),
                noDriversLabel: "Coverage is computed from realised observations against stored intervals",
              }}
              detail="Expected near 95%"
            />

            <Kpi
              label="Series to review"
              value={data.kpis.unreliableSeries.toLocaleString("en-GB")}
              why={{
                subject: "Unreliable series count",
                source: "ML.FACT_FORECAST + CORE.FACT_POS_WEEKLY",
                rationale: `Series in ${scope} with lag-4 WAPE above 30%. Those are the lines where the model is failing badly enough to deserve planner attention.`,
                formatValue: (value) => Math.round(value).toLocaleString("en-GB"),
                noDriversLabel: "This KPI is a threshold count rather than an additive metric",
              }}
              detail="Lag-4 WAPE above 30%"
            />
          </KpiRow>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="card-title">Selected series baseline</h2>
                  <p className="text-xs text-text-tertiary">52 weeks of POS actuals, then the forward forecast and 95% interval</p>
                </div>
                {selectedSeries && (
                  <div className="flex flex-col items-end gap-1">
                    <label className="flex items-center gap-2 text-xs text-text-tertiary">
                      <span>Series</span>
                      <select
                        value={selectedSeries.seriesId}
                        onChange={(event) => setSelectedSeriesId(event.target.value)}
                        className="min-w-[280px] rounded-md border border-border px-2 py-1 text-foreground"
                        style={{ backgroundColor: "var(--bg-elevated)" }}
                      >
                        {data.seriesOptions.map((option) => (
                          <option key={option.seriesId} value={option.seriesId}>{seriesOptionLabel(option, path)}</option>
                        ))}
                      </select>
                    </label>
                    <p className="text-[11px] text-text-tertiary">{pickerNote(data.seriesOptions.length, data.seriesInScope)}</p>
                  </div>
                )}
              </div>

              {!selectedSeries || chartData.length === 0 ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-text-tertiary">No series is available to chart.</p>
                  <p className="mt-1 text-xs text-text-tertiary">The selector uses the top-value series in scope. If it is empty, check series master data and the forward plan view.</p>
                </div>
              ) : (
                <>
                  <div className="mb-3 flex items-center justify-between gap-3 text-xs">
                    <div>
                      <span className="font-medium text-foreground">{selectedSeries.productName}</span>
                      <span className="text-text-tertiary">{" · "}{selectedSeries.customerName}{" · "}{selectedSeries.channelName}</span>
                    </div>
                    <span className="rounded px-1.5 py-0.5 text-accent bg-accent-subtle">{selectedSeries.segment}</span>
                  </div>
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                        <XAxis
                          dataKey="WEEK_ID"
                          tickFormatter={formatWeekShort}
                          tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                          interval={3}
                          stroke="var(--chart-grid)"
                        />
                        <YAxis
                          tickFormatter={(value) => formatUnits(Number(value)).replace(" pcs", "")}
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
                            label={{ value: "forecast starts", position: "insideTopRight", fontSize: 10, fill: "var(--text-tertiary)" }}
                          />
                        )}
                        <Area dataKey="BAND_BASE" stackId="band" stroke="none" fill="transparent" name="  " isAnimationActive={false} legendType="none" />
                        <Area dataKey="BAND_SPAN" stackId="band" stroke="none" fill="var(--chart-band)" name="95% interval" isAnimationActive={false} />
                        <Line dataKey="POS_UNITS" name="POS actual" stroke={CHART_COLORS[0]} strokeWidth={1.75} dot={false} connectNulls={false} isAnimationActive={false} />
                        <Line dataKey="STAT_UNITS" name="VECTRON_STAT" stroke="var(--sfx-series)" strokeWidth={3} dot={false} connectNulls={false} isAnimationActive={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </Card>

            <Card className="p-4">
              <div>
                <h2 className="card-title">ABC/XYZ segmentation</h2>
                <p className="text-xs text-text-tertiary">A means high value; X means stable demand. That is where forecast quality matters most because the line is both material and plannable.</p>
                <p className="mt-1 text-xs text-text-tertiary">Counts the series in {scope}. Classes are set across the whole portfolio, so an A series is A in every scope.</p>
              </div>
              <div className="mt-4 grid grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-2 text-xs">
                <div />
                {(["X", "Y", "Z"] as const).map((col) => (
                  <div key={col} className="text-center font-medium text-text-tertiary">{col}</div>
                ))}
                {(["A", "B", "C"] as const).map((rowKey) => (
                  <React.Fragment key={rowKey}>
                    <div className="flex items-center justify-center font-medium text-text-tertiary">{rowKey}</div>
                    {(["X", "Y", "Z"] as const).map((colKey) => {
                      const cell = matrix.get(`${rowKey}-${colKey}`);
                      return (
                        <div
                          key={`${rowKey}-${colKey}`}
                          className="rounded-md border border-border p-2 text-center"
                          style={cellStyle(cell?.valueEur ?? 0, maxMatrixValue)}
                        >
                          <div className="font-medium tabular-nums text-foreground">{(cell?.seriesCount ?? 0).toLocaleString("en-GB")}</div>
                          <div className="mt-1 text-[11px] text-text-tertiary">{formatEur(cell?.valueEur ?? 0)}</div>
                        </div>
                      );
                    })}
                  </React.Fragment>
                ))}
              </div>
            </Card>
          </div>

          <Card className="p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <div>
                <h2 className="card-title">Model health</h2>
                <p className="text-xs text-text-tertiary">Worst lag-4 WAPE first, up to 25 series in {scope}. This is the list of series where the baseline is struggling.</p>
              </div>
            </div>
            {data.health.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-text-tertiary">No per-series accuracy rows are available in this scope.</p>
                <p className="mt-1 text-xs text-text-tertiary">Check that ML.FACT_FORECAST and CORE.FACT_POS_WEEKLY overlap at lag 4 for VECTRON_STAT.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-text-tertiary">
                      <th className="py-2 text-left font-medium">Series</th>
                      <th className="py-2 text-left font-medium">Segment</th>
                      <th className="num py-2 font-medium">WAPE</th>
                      <th className="num py-2 font-medium">Bias</th>
                      <th className="num py-2 font-medium">Coverage</th>
                      <th className="py-2 text-left font-medium">Recent POS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.health.map((row) => (
                      <tr key={row.seriesId} className="border-b border-border/50">
                        <td className="py-2">
                          <span className="font-medium">{row.productName}</span>
                          <span className="text-text-tertiary">{" · "}{row.customerName}</span>
                        </td>
                        <td className="py-2">
                          <span className="rounded px-1.5 py-0.5 bg-accent-subtle text-accent">{row.segment}</span>
                        </td>
                        <td className="num py-2 tabular-nums">
                          <span className={cn("inline-flex items-center gap-1", row.wape !== null && row.wape > 30 ? "text-warning" : "text-foreground")}>
                            <Direction value={row.bias} />
                            {row.wape !== null ? formatPercent(row.wape) : "—"}
                          </span>
                        </td>
                        <td className="num py-2 tabular-nums">{row.bias !== null ? formatSignedPercent(row.bias) : "—"}</td>
                        <td className="num py-2 tabular-nums">{row.coverage !== null ? formatPercent(row.coverage, 0) : "—"}</td>
                        <td className="py-2">
                          <Sparkline
                            data={data.sparklineBySeries[row.seriesId] ?? []}
                            width={92}
                            height={24}
                            stroke={CHART_COLORS[0]}
                            label={`Recent POS for ${row.label}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
