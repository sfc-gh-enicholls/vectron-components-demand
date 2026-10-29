"use client";

import * as React from "react";
import {
  AlertTriangle,
  Minus,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BulletChart } from "@/components/bullet-chart";
import {
  HierarchyFilter,
  pathLabel,
  pathToParams,
  type HierarchyOptions,
  type HierarchyPath,
} from "@/components/hierarchy-filter";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
import { Kpi, KpiRow } from "@/components/kpi";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CHART_COLORS,
  formatUnits,
  formatEur,
  formatPercent,
  formatSignedPercent,
  formatWeek,
  SEVERITY_CLASSES,
} from "@/lib/format";
import { cn } from "@/lib/utils";

// The KPIs and the override scorecard are recomputed for the selected scope
// from the forecast and POS facts (src/lib/scoped-accuracy.ts), not read from
// the portfolio-wide summary views.
const ACCURACY_SOURCE = "ML.FACT_FORECAST vs actuals";

interface AccuracyPageData {
  context: {
    HISTORY_END_WEEK: string;
    CURRENT_WEEK: string;
    HORIZON_END_WEEK: string;
    PRODUCTION_MODEL: string;
    BENCHMARK_MODEL: string;
  };
  integrity: Array<{ CHECK_NAME: string; VIOLATIONS: number }>;
  options: {
    hierarchy: HierarchyOptions;
  };
  summary: {
    naiveWape: number | null;
    statWape: number | null;
    consensusWape: number | null;
    modelFva: number | null;
    plannerFva: number | null;
  };
  accuracyByLag: Array<{
    modelName: string;
    lagWeeks: number;
    observations: number;
    actualUnits: number;
    wape: number | null;
    bias: number | null;
    intervalCoverage: number | null;
  }>;
  overrideScorecard: {
    overrideCount: number;
    improved: number;
    worsened: number;
    winRate: number | null;
    netUnitsSaved: number | null;
  };
  worstOverrides: Array<{
    madeWeekId: string;
    targetWeekId: string;
    seriesId: string;
    seriesLabel: string;
    productName: string;
    customerName: string;
    reasonCode: string | null;
    reasonLabel: string | null;
    statUnits: number;
    overrideUnits: number;
    actualUnits: number;
    damageUnits: number;
  }>;
  agentScorecard: {
    summary: {
      proposalsScored: number;
      improvedCount: number;
      winRate: number | null;
      errBefore: number;
      errAfter: number;
      actualUnits: number;
      wapeBefore: number | null;
      wapeAfter: number | null;
      unitsSaved: number;
      valueSavedEur: number;
    };
    byType: Array<{
      key: string;
      proposalsScored: number;
      improvedCount: number;
      winRate: number | null;
      wapeBefore: number | null;
      wapeAfter: number | null;
      unitsSaved: number;
      valueSavedEur: number;
    }>;
    byConfidenceBand: Array<{
      key: string;
      proposalsScored: number;
      improvedCount: number;
      winRate: number | null;
      wapeBefore: number | null;
      wapeAfter: number | null;
      unitsSaved: number;
      valueSavedEur: number;
    }>;
    disabledRules: Array<{
      rule: string;
      status: string;
      reason: string;
    }>;
    note: string;
  };
}

function Direction({ value }: { value: number | null }) {
  if (value === null || Math.abs(value) < 0.0001) {
    return <Minus size={13} className="text-neutral" aria-hidden="true" />;
  }
  return value > 0 ? (
    <TrendingUp size={13} className="text-positive" aria-hidden="true" />
  ) : (
    <TrendingDown size={13} className="text-negative" aria-hidden="true" />
  );
}

/** Tone for a signed figure; muted when the scope leaves no value to show. */
function signedClass(value: number | null): string {
  if (value === null) return "text-text-tertiary";
  return value >= 0 ? "text-positive" : "text-negative";
}

function formatRate(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return formatPercent(value * 100, decimals);
}

function formatPp(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return formatSignedPercent(value, decimals).replace("%", "pp");
}

function calibrationText(points: Array<{ intervalCoverage: number | null }>): string {
  const values = points
    .map((point) => point.intervalCoverage)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (!values.length) {
    return "Calibration is unavailable because interval coverage did not come back for VECTRON_STAT. Check that ML.FACT_FORECAST carries LOWER_95 and UPPER_95 for this scope.";
  }

  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const last = values[values.length - 1];

  if (average >= 0.93 && average <= 0.97 && last >= 0.9) {
    return "The bands are well calibrated overall: they land close to the 95% target, drifting slightly low at the longer horizons.";
  }

  if (average < 0.93) {
    return "The bands are under-calibrated: too many actuals land outside the 95% interval, especially as the horizon extends.";
  }

  return "The bands are over-calibrated: the 95% interval is wider than it needs to be for most horizons.";
}

export default function AccuracyPage() {
  const [data, setData] = React.useState<AccuracyPageData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  // Hierarchy scope. Purely user-driven: it is never set from a response, so it
  // cannot start the fetch loop that a response-derived dependency would.
  const [path, setPath] = React.useState<HierarchyPath>({});

  // Flag the reload in the same render as the new scope, so the previous
  // scope's figures are never shown under the new scope's label.
  const changePath = React.useCallback((next: HierarchyPath) => {
    setLoading(true);
    setPath(next);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams(pathToParams(path));
        const response = await fetch(`/api/accuracy?${params.toString()}`);
        const json = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(json.error ?? "Failed to load");
          return;
        }
        setData(json);
      } catch (requestError) {
        if (!cancelled) {
          setError((requestError as Error).message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return (
      <div className="p-6">
        <Card
          className="border bg-negative-subtle p-4"
          style={{ borderColor: "color-mix(in srgb, var(--negative) 40%, transparent)" }}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium text-negative">Could not load accuracy and FVA</p>
              <p className="mt-1 text-text-tertiary">The API returned an error: {error}</p>
              <p className="mt-2 text-text-tertiary">
                Check that VECTRON_DEMAND is reachable, that ML.FACT_FORECAST and CORE.FACT_POS_WEEKLY can be read, and that the dev server can still query Snowflake.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (loading || !data) {
    return <PageSkeleton kpis={5} chart rows={8} className="p-5 lg:p-6 space-y-5 max-w-[1600px] mx-auto" />;
  }

  const scopeLabel = pathLabel(path);
  const failing = data.integrity.filter((row) => row.VIOLATIONS > 0);
  const lagMap = new Map<number, Record<string, number | null>>();

  for (const row of data.accuracyByLag) {
    const entry = lagMap.get(row.lagWeeks) ?? { lagWeeks: row.lagWeeks };
    entry[row.modelName] = row.wape;
    lagMap.set(row.lagWeeks, entry);
  }

  const wapeChartData = Array.from(lagMap.values()).sort(
    (left, right) => Number(left.lagWeeks) - Number(right.lagWeeks),
  );

  const statRows = data.accuracyByLag
    .filter((row) => row.modelName === "VECTRON_STAT")
    .sort((left, right) => left.lagWeeks - right.lagWeeks);

  const coverageAverage = statRows.length
    ? statRows.reduce((sum, row) => sum + (row.intervalCoverage ?? 0), 0) / statRows.length
    : null;
  const agentSummary = data.agentScorecard.summary;

  const banner = (
    <PageBanner
      eyebrow="Demand planning"
      headline="Accuracy & FVA"
      subtitle={`Actuals are complete to ${data.context.HISTORY_END_WEEK}. This page shows whether ${data.context.PRODUCTION_MODEL} beats the naive benchmark and whether human overrides actually improve the answer.`}
      icon={<Target size={18} aria-hidden="true" />}
      metadata={
        <span>
          Scope: <span className="font-medium text-banner-fg">{scopeLabel}</span>
        </span>
      }
    />
  );

  const scopeCard = (
    <Card className="p-4">
      <h2 className="card-title">Scope</h2>
      <p className="mt-1 text-xs text-text-tertiary">
        Every figure below is recomputed for this part of the portfolio. WAPE stays a ratio of summed errors, so a large series weighs more than a small one, exactly as in the portfolio total.
      </p>
      <HierarchyFilter
        className="mt-3"
        path={path}
        options={data.options.hierarchy}
        onChange={changePath}
      />
    </Card>
  );

  // An empty scope is a legitimate selection, not an error: a product and a
  // customer it does not sell in has nothing to score. Say so and keep the
  // filter in reach, rather than drawing empty charts that read as a finding.
  if (
    data.accuracyByLag.length === 0
    && data.overrideScorecard.overrideCount === 0
    && agentSummary.proposalsScored === 0
  ) {
    return (
      <div className="space-y-5 p-5 lg:p-6">
        {banner}
        {scopeCard}
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 text-text-tertiary" aria-hidden="true" />
            <div>
              <h2 className="card-title">No scored forecasts in {scopeLabel}</h2>
              <p className="mt-1 text-sm text-text-tertiary">
                Each level is valid on its own, but no series matches all of them, so there is no accuracy, override or agent result to show. Widen a level to continue.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-5 lg:p-6">
      {banner}

      {failing.length > 0 && (
        <Card
          className="border bg-negative-subtle p-3"
          style={{ borderColor: "color-mix(in srgb, var(--negative) 40%, transparent)" }}
        >
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={15} className="mt-0.5 text-negative" aria-hidden="true" />
            <div>
              <span className="font-medium text-negative">Data integrity failure.</span>{" "}
              <span className="text-text-tertiary">
                {failing.map((row) => `${row.CHECK_NAME} (${row.VIOLATIONS})`).join(", ")}. These checks run portfolio-wide, whatever the scope. Accuracy figures may be unreliable until those checks clear.
              </span>
            </div>
          </div>
        </Card>
      )}

      {scopeCard}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi
          label="Naive WAPE"
          value={formatRate(data.summary.naiveWape)}
          why={{
            subject: "Naive WAPE",
            source: ACCURACY_SOURCE,
            rationale: "Seasonal-naive WAPE is the dumb benchmark. If the statistical model cannot beat this, the process is not earning its complexity.",
            noDriversLabel: "This benchmark is a single ratio for the scope, not a driver tree",
          }}
          detail="Lower is better"
        />

        <Kpi
          label="Statistical WAPE"
          value={formatRate(data.summary.statWape)}
          why={{
            subject: "Statistical WAPE",
            source: ACCURACY_SOURCE,
            rationale: "VECTRON_STAT WAPE is the model's backtest error. It should materially improve on the seasonal-naive benchmark if the model deserves to be in production.",
            noDriversLabel: "This KPI is one ratio of summed errors for the scope",
          }}
          detail="VECTRON_STAT backtest"
        />

        <Kpi
          label="Consensus WAPE"
          value={formatRate(data.summary.consensusWape)}
          why={{
            subject: "Consensus WAPE",
            source: ACCURACY_SOURCE,
            rationale: "Consensus WAPE is the final human-touched answer. If it is not below the statistical WAPE, planner overrides are not adding value.",
            noDriversLabel: "Consensus accuracy is a summary metric rather than a driver breakdown",
          }}
          detail="Final forecast"
        />

        <Kpi
          label="Model FVA"
          valueClassName="flex items-center gap-2"
          value={
            <>
              <Direction value={data.summary.modelFva} />
              <span className={signedClass(data.summary.modelFva)}>
                {formatPp(data.summary.modelFva)}
              </span>
            </>
          }
          why={{
            subject: "Model FVA",
            source: ACCURACY_SOURCE,
            rationale: "Model FVA is naive WAPE minus statistical WAPE. Positive means the model beats the dumb benchmark; negative means the model should not be trusted.",
            noDriversLabel: "FVA is a gap between two summary metrics, not an additive driver stack",
          }}
          detail="Naive minus statistical WAPE"
        />

        <Kpi
          label="Planner FVA"
          valueClassName="flex items-center gap-2"
          value={
            <>
              <Direction value={data.summary.plannerFva} />
              <span className={signedClass(data.summary.plannerFva)}>
                {formatPp(data.summary.plannerFva)}
              </span>
            </>
          }
          why={{
            subject: "Planner FVA",
            source: ACCURACY_SOURCE,
            rationale: "Planner FVA is statistical WAPE minus consensus WAPE. Negative means humans are destroying accuracy, which is exactly what this page is meant to surface honestly.",
            noDriversLabel: "Planner FVA is the net result of many overrides, not a driver decomposition",
          }}
          detail="Statistical minus consensus WAPE"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">WAPE by horizon</h2>
            <p className="text-xs text-text-tertiary">
              Error across the first eight weekly horizons for the benchmark, statistical model, and final consensus
            </p>
          </div>
          {wapeChartData.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-text-tertiary">No lag-level accuracy rows for {scopeLabel}.</p>
              <p className="mt-1 text-xs text-text-tertiary">
                No NAIVE_SEASONAL, VECTRON_STAT or CONSENSUS forecast at lags 1 to 8 meets an actual in this scope.
              </p>
            </div>
          ) : (
            <>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={wapeChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                    <XAxis
                      dataKey="lagWeeks"
                      tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                      stroke="var(--chart-grid)"
                    />
                    <YAxis
                      tickFormatter={(value) => formatRate(Number(value), 0)}
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
                      formatter={(value, name) => [formatRate(Number(value)), name]}
                      labelFormatter={(value) => `Lag ${value}`}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line dataKey="NAIVE_SEASONAL" name="NAIVE_SEASONAL" stroke={CHART_COLORS[0]} strokeWidth={1.75} dot={false} isAnimationActive={false} />
                    <Line dataKey="VECTRON_STAT" name="VECTRON_STAT" stroke="var(--sfx-series)" strokeWidth={3} dot={false} isAnimationActive={false} />
                    <Line dataKey="CONSENSUS" name="CONSENSUS" stroke={CHART_COLORS[2]} strokeWidth={1.75} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-3 text-xs text-text-tertiary">
                Error stays fairly flat across the horizon because weekly seasonality and the event calendar are known in advance; that flatness is expected, not a bug.
              </p>
            </>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">Bias by horizon</h2>
            <p className="text-xs text-text-tertiary">
              Signed bias for VECTRON_STAT. Persistent one-sided bias is more damaging than random error because it compounds into stock positions.
            </p>
          </div>
          {statRows.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-text-tertiary">No VECTRON_STAT bias rows for {scopeLabel}.</p>
              <p className="mt-1 text-xs text-text-tertiary">
                No VECTRON_STAT forecast at lags 1 to 8 meets an actual in this scope.
              </p>
            </div>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statRows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                  <XAxis
                    dataKey="lagWeeks"
                    tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                    stroke="var(--chart-grid)"
                  />
                  <YAxis
                    tickFormatter={(value) => formatSignedPercent(Number(value), 0)}
                    tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                    stroke="var(--chart-grid)"
                    width={56}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    formatter={(value) => [formatSignedPercent(Number(value)), "Bias"]}
                    labelFormatter={(value) => `Lag ${value}`}
                  />
                  <ReferenceLine y={0} stroke="var(--chart-grid)" />
                  <Bar dataKey="bias" fill={CHART_COLORS[1]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">Interval calibration</h2>
            <p className="text-xs text-text-tertiary">
              VECTRON_STAT interval coverage versus the 95% target. A calibrated band should sit close to 95% across the horizon.
            </p>
          </div>
          {statRows.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-text-tertiary">No interval coverage rows for {scopeLabel}.</p>
              <p className="mt-1 text-xs text-text-tertiary">
                Coverage needs VECTRON_STAT forecasts with actuals in this scope.
              </p>
            </div>
          ) : (
            <>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={statRows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                    <XAxis
                      dataKey="lagWeeks"
                      tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                      stroke="var(--chart-grid)"
                    />
                    <YAxis
                      domain={[0.85, 1]}
                      tickFormatter={(value) => formatRate(Number(value), 0)}
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
                      formatter={(value) => [formatRate(Number(value), 1), "Coverage"]}
                      labelFormatter={(value) => `Lag ${value}`}
                    />
                    <ReferenceLine y={0.95} stroke="var(--chart-grid)" strokeDasharray="3 3" label={{ value: "95% target", position: "insideTopRight", fontSize: 10, fill: "var(--text-tertiary)" }} />
                    <Line dataKey="intervalCoverage" name="Coverage" stroke={CHART_COLORS[1]} strokeWidth={1.75} dot={{ r: 2 }} isAnimationActive={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-3 text-xs text-text-tertiary">{calibrationText(statRows)}</p>
            </>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">Override scorecard</h2>
            <p className="text-xs text-text-tertiary">
              How often overrides help, and how much net volume they save after the misses are counted.
            </p>
          </div>

          {data.overrideScorecard.overrideCount === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-text-tertiary">No planner overrides in {scopeLabel}.</p>
              <p className="mt-1 text-xs text-text-tertiary">
                Consensus never differs from VECTRON_STAT on a week with actuals in this scope, so there is nothing to score.
              </p>
            </div>
          ) : (
            <>
              <Kpi
                bare
                className="rounded-lg bg-accent-subtle p-3"
                label="Win rate"
                value={formatRate(data.overrideScorecard.winRate, 0)}
                valueClassName="text-accent"
                why={{
                  subject: "Override win rate",
                  source: ACCURACY_SOURCE,
                  rationale: "Win rate is the share of overrides that improved absolute error versus VECTRON_STAT. A high win rate with small net FVA usually means planners are usually right but occasionally very wrong.",
                  noDriversLabel: "The scorecard is a summary over this scope's overrides rather than a driver breakdown",
                }}
                detail={`${data.overrideScorecard.improved.toLocaleString("en-GB")} improved vs ${data.overrideScorecard.worsened.toLocaleString("en-GB")} worsened`}
              />

              <div className="mt-4 space-y-3">
                <BulletChart
                  actual={data.overrideScorecard.winRate ?? 0}
                  target={0.7}
                  tolerance={0.05}
                  max={1}
                  label="Win rate"
                  valueLabel={formatRate(data.overrideScorecard.winRate, 0)}
                  lowerIsWorse={true}
                />
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg border border-border p-3" style={{ backgroundColor: "var(--bg-elevated)" }}>
                    <p className="text-xs text-text-tertiary">Overrides</p>
                    <p className="mt-1 font-semibold tabular-nums">{data.overrideScorecard.overrideCount.toLocaleString("en-GB")}</p>
                  </div>
                  <div className="rounded-lg border border-border p-3" style={{ backgroundColor: "var(--bg-elevated)" }}>
                    <p className="text-xs text-text-tertiary">Net units saved</p>
                    <p className={cn(
                      "mt-1 font-semibold tabular-nums",
                      signedClass(data.overrideScorecard.netUnitsSaved),
                    )}>
                      {formatUnits(data.overrideScorecard.netUnitsSaved)}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-text-tertiary">
                  A high win rate with a small net FVA means planners are usually right but occasionally very wrong. That is the normal pattern, and it is why large overrides deserve review more than all overrides do.
                </p>
              </div>
            </>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="card-title">Agent scorecard</h2>
            <p className="text-xs text-text-tertiary">
              {data.agentScorecard.note} Current scope: {scopeLabel}.
            </p>
          </div>
          <Badge className="border-0 bg-warning-subtle text-warning">Seeded back-run history</Badge>
        </div>

        {agentSummary.proposalsScored === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-text-tertiary">No scored agent proposals in {scopeLabel}.</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Back-run proposals touch only part of the portfolio, and only accepted ones whose weeks have actuals are scored. Widen the scope to see the agent&apos;s record.
            </p>
          </div>
        ) : (
          <>
            <KpiRow>
              <Kpi
                bare
                className="rounded-lg border border-border bg-bg-elevated p-3"
                label="Win rate"
                value={agentSummary.winRate === null ? "—" : formatRate(agentSummary.winRate, 0)}
                detail={`${agentSummary.improvedCount.toLocaleString("en-GB")} improved of ${agentSummary.proposalsScored.toLocaleString("en-GB")} scored`}
              />
              <Kpi
                bare
                className="rounded-lg border border-border bg-bg-elevated p-3"
                label="WAPE before vs after"
                value={agentSummary.wapeBefore !== null ? formatRate(agentSummary.wapeBefore) : "—"}
                detail={`to ${agentSummary.wapeAfter !== null ? formatRate(agentSummary.wapeAfter) : "—"}`}
              />
              <Kpi
                bare
                className="rounded-lg border border-border bg-bg-elevated p-3"
                label="Net units saved"
                value={formatUnits(agentSummary.unitsSaved)}
                valueClassName={agentSummary.unitsSaved >= 0 ? "text-positive" : "text-negative"}
                detail="Absolute error before minus after"
              />
              <Kpi
                bare
                className="rounded-lg border border-border bg-bg-elevated p-3"
                label="Net value saved"
                value={formatEur(agentSummary.valueSavedEur)}
                valueClassName={agentSummary.valueSavedEur >= 0 ? "text-positive" : "text-negative"}
                detail="Commercial equivalent of units saved"
              />
            </KpiRow>

            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-medium">By proposal type</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-text-tertiary">
                        <th className="py-1.5 text-left font-medium">Type</th>
                        <th className="num py-1.5 font-medium">Scored</th>
                        <th className="num py-1.5 font-medium">Win rate</th>
                        <th className="num py-1.5 font-medium">WAPE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.agentScorecard.byType.map((row) => (
                        <tr key={row.key} className="border-b border-border/50">
                          <td className="py-1.5">{row.key.replace(/_/g, " ")}</td>
                          <td className="num py-1.5 tabular-nums">{row.proposalsScored.toLocaleString("en-GB")}</td>
                          <td className="num py-1.5 tabular-nums">{row.winRate === null ? "—" : formatRate(row.winRate, 0)}</td>
                          <td className="num py-1.5 tabular-nums text-text-tertiary">
                            {row.wapeBefore !== null ? formatRate(row.wapeBefore) : "—"} to {row.wapeAfter !== null ? formatRate(row.wapeAfter) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-medium">By confidence band</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-text-tertiary">
                        <th className="py-1.5 text-left font-medium">Band</th>
                        <th className="num py-1.5 font-medium">Scored</th>
                        <th className="num py-1.5 font-medium">Win rate</th>
                        <th className="num py-1.5 font-medium">WAPE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.agentScorecard.byConfidenceBand.map((row) => (
                        <tr key={row.key} className="border-b border-border/50">
                          <td className="py-1.5">
                            <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[11px]", row.key === "Low" ? SEVERITY_CLASSES.Low : row.key === "Mid" ? "bg-warning-subtle text-warning" : "bg-positive-subtle text-positive")}>
                              {row.key}
                            </span>
                          </td>
                          <td className="num py-1.5 tabular-nums">{row.proposalsScored.toLocaleString("en-GB")}</td>
                          <td className="num py-1.5 tabular-nums">{row.winRate === null ? "—" : formatRate(row.winRate, 0)}</td>
                          <td className="num py-1.5 tabular-nums text-text-tertiary">
                            {row.wapeBefore !== null ? formatRate(row.wapeBefore) : "—"} to {row.wapeAfter !== null ? formatRate(row.wapeAfter) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}

        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
          <div className="mb-2 flex items-start gap-2 text-xs text-text-tertiary">
            <AlertTriangle size={14} className="mt-0.5 text-warning" aria-hidden="true" />
            <p>
              Some rule families were explicitly rejected or left dormant by this evaluation. That is a strength of the engine, not an omission: held-out history vetoed rules that sounded plausible but made the plan worse. These decisions apply engine-wide, whatever the scope.
            </p>
          </div>
          <ul className="space-y-2 text-sm">
            {data.agentScorecard.disabledRules.map((rule) => (
              <li key={rule.rule} className="rounded-md border border-border bg-card px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{rule.rule.replace(/_/g, " ")}</span>
                  <Badge className={cn("border-0", rule.status === "rejected" ? "bg-negative-subtle text-negative" : "bg-neutral-subtle text-neutral")}>
                    {rule.status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-text-tertiary">{rule.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <div>
            <h2 className="card-title">Worst overrides</h2>
            <p className="text-xs text-text-tertiary">
              Overrides where consensus made absolute error worse than VECTRON_STAT, ordered by the extra units of error created. The worst 20 at most, within {scopeLabel}.
            </p>
          </div>
          {coverageAverage !== null && (
            <span className="text-xs text-text-tertiary">Average interval coverage: {formatRate(coverageAverage, 0)}</span>
          )}
        </div>

        {data.worstOverrides.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-text-tertiary">No harmful overrides in {scopeLabel}.</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Either the consensus never worsened error in this scope&apos;s backtest, or the joins to ML.FACT_FORECAST, CORE.FACT_POS_WEEKLY, and CORE.FACT_DEMAND_PLAN returned no overlap.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-tertiary">
                  <th className="py-2 text-left font-medium">Origin</th>
                  <th className="py-2 text-left font-medium">Target week</th>
                  <th className="py-2 text-left font-medium">Series</th>
                  <th className="py-2 text-left font-medium">Reason</th>
                  <th className="num py-2 font-medium">Stat</th>
                  <th className="num py-2 font-medium">Override</th>
                  <th className="num py-2 font-medium">Actual</th>
                  <th className="num py-2 font-medium">Damage</th>
                </tr>
              </thead>
              <tbody>
                {data.worstOverrides.map((row) => (
                  <tr key={`${row.seriesId}-${row.madeWeekId}-${row.targetWeekId}`} className="border-b border-border/50 align-top">
                    <td className="py-2 text-text-tertiary">{formatWeek(row.madeWeekId)}</td>
                    <td className="py-2 text-text-tertiary">{formatWeek(row.targetWeekId)}</td>
                    <td className="py-2">
                      <div className="font-medium">{row.seriesLabel}</div>
                      <div className="text-xs text-text-tertiary">{row.productName} · {row.customerName}</div>
                    </td>
                    <td className="py-2 text-xs text-text-tertiary">
                      {row.reasonLabel ?? row.reasonCode ?? "No reason recorded"}
                    </td>
                    <td className="num py-2 tabular-nums">{formatUnits(row.statUnits)}</td>
                    <td className="num py-2 tabular-nums">{formatUnits(row.overrideUnits)}</td>
                    <td className="num py-2 tabular-nums">{formatUnits(row.actualUnits)}</td>
                    <td className="num py-2 tabular-nums text-negative">+{formatUnits(row.damageUnits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
