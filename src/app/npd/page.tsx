"use client";

import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Boxes,
  Minus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Sparkline } from "@/components/sparkline";
import { WhyThis } from "@/components/why-this";
import { Kpi } from "@/components/kpi";
import {
  CHART_COLORS,
  STATUS_CLASSES,
  formatUnits,
  formatPercent,
  formatSignedPercent,
  formatWeek,
} from "@/lib/format";
import { cn } from "@/lib/utils";

interface LaunchCard {
  productId: string;
  productName: string;
  categoryName: string | null;
  launchWeekId: string;
  lifecycleStatus: string;
  weeksSinceLaunch: number;
  cumulativeUnits: number;
  analogues: Array<{
    analogueProductId: string;
    analogueProductName: string;
    similarityScore: number;
    cannibalisationPct: number;
    rationale: string | null;
    analogueLaunchWeekId: string | null;
    analogueLifecycleStatus: string | null;
  }>;
}

interface CurveComparison {
  analogueProductId: string;
  analogueProductName: string;
  similarityScore: number;
  cannibalisationPct: number;
  rationale: string | null;
  referenceType: "launch" | "earliest_observed";
  referenceStartWeekId: string | null;
  baseAverage13: number;
  baseWindowWeeks: number;
  points: Array<{
    weeksSinceLaunch: number;
    launchUnits: number;
    launchIndex: number | null;
    analogueUnits: number | null;
    analogueIndex: number | null;
    analogueWeekId: string | null;
  }>;
}

interface CannibalisationRow {
  analogueProductId: string;
  analogueProductName: string;
  similarityScore: number;
  cannibalisationPct: number;
  grossLaunchUnits: number;
  cannibalisedUnits: number;
  incrementalUnits: number;
  rationale: string | null;
}

interface NpdData {
  context: {
    HISTORY_END_WEEK: string;
    CURRENT_WEEK: string;
    HORIZON_END_WEEK: string;
  };
  filters: { path: HierarchyPath };
  options: { hierarchy: HierarchyOptions };
  launches: LaunchCard[];
  selectedProductId: string | null;
  selectedProductName: string | null;
  selectedLaunch: LaunchCard | null;
  selectedByDefault: boolean;
  curveComparisons: CurveComparison[];
  cannibalisation: CannibalisationRow[];
  rationaleRows: Array<{
    newProductId: string;
    newProductName: string;
    analogueProductId: string;
    analogueProductName: string;
    similarityScore: number;
    cannibalisationPct: number;
    rationale: string | null;
  }>;
  phaseOut: Array<{
    productId: string;
    productName: string;
    lifecycleStatus: string;
    delistWeekId: string | null;
    sparkline: number[];
    latestWeekUnits: number;
    recent13Units: number;
    prior13Units: number;
    recentDelta: number | null;
  }>;
  integrity: Array<{ CHECK_NAME: string; VIOLATIONS: number }>;
}

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

function RunoutDirection({ value }: { value: number | null }) {
  if (value === null || Math.abs(value) < 0.001) {
    return <Minus size={13} className="text-neutral" aria-hidden="true" />;
  }
  return value > 0 ? (
    <TrendingUp size={13} className="text-warning" aria-hidden="true" />
  ) : (
    <TrendingDown size={13} className="text-positive" aria-hidden="true" />
  );
}

export default function NpdPage() {
  const [data, setData] = React.useState<NpdData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [path, setPath] = React.useState<HierarchyPath>({});
  const [selectedAnalogueId, setSelectedAnalogueId] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(pathToParams(path)).toString();
      const res = await fetch(params ? `/api/npd?${params}` : "/api/npd");
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed to load");
        setData(null);
        return;
      }
      setData(json);
    } catch (fetchError) {
      setError((fetchError as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [path]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A card and the product filter are one selection: picking a card moves the path to
  // that launch's own category and product, so the two can never name different launches.
  const selectLaunch = (launch: LaunchCard) => {
    setPath((current) => (
      (current.CATEGORY_NAME ?? null) === launch.categoryName && current.PRODUCT_NAME === launch.productName
        ? current
        : { CATEGORY_NAME: launch.categoryName, PRODUCT_NAME: launch.productName }
    ));
  };

  React.useEffect(() => {
    if (!data) return;
    const firstAnalogue = data.curveComparisons[0]?.analogueProductId ?? "";
    setSelectedAnalogueId((current) => {
      if (current && data.curveComparisons.some((row) => row.analogueProductId === current)) {
        return current;
      }
      return firstAnalogue;
    });
  }, [data]);

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-negative/40 bg-negative-subtle p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium text-negative">Could not load the NPD view</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
              <p className="mt-2 text-text-tertiary">
                Check that VECTRON_DEMAND is reachable, that APP.V_NPD_TRACKING contains launch rows, and that the analogue products have POS history in CORE.FACT_POS_WEEKLY.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (loading || !data) {
    return <div className="p-6"><PageSkeleton kpis={4} chart rows={6} /></div>;
  }

  const failing = data.integrity.filter((row) => row.VIOLATIONS > 0);
  const atRoot = Object.keys(pathToParams(path)).length === 0;
  const scopeLabel = pathLabel(path);
  const selectedLaunch = data.selectedLaunch;
  const selectedComparison = data.curveComparisons.find((row) => row.analogueProductId === selectedAnalogueId)
    ?? data.curveComparisons[0]
    ?? null;
  const selectedCannibalisation = data.cannibalisation.find((row) => row.analogueProductId === selectedAnalogueId)
    ?? data.cannibalisation[0]
    ?? null;
  const observedWeeks = selectedComparison?.points.length ?? 0;
  const latestComparablePoint = [...(selectedComparison?.points ?? [])]
    .reverse()
    .find((point) => point.launchIndex !== null && point.analogueIndex !== null) ?? null;
  const latestGap = latestComparablePoint && latestComparablePoint.launchIndex !== null && latestComparablePoint.analogueIndex !== null
    ? latestComparablePoint.launchIndex - latestComparablePoint.analogueIndex
    : null;

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Demand planning"
        headline="New Product Introduction"
        subtitle={`Launch tracking and run-out risk. Actuals are complete to ${data.context.HISTORY_END_WEEK}; current week is ${data.context.CURRENT_WEEK}.`}
        icon={<Boxes size={18} aria-hidden="true" />}
      />

      {failing.length > 0 && (
        <Card className="border-negative/40 bg-negative-subtle p-3">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={15} className="mt-0.5 text-negative" aria-hidden="true" />
            <div>
              <span className="font-medium text-negative">Data integrity failure.</span>{" "}
              <span className="text-text-tertiary">
                {failing.map((row) => `${row.CHECK_NAME} (${row.VIOLATIONS})`).join(", ")}. Figures on this page may be unreliable until those checks clear.
              </span>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <p className="text-xs text-text-tertiary">Portfolio scope</p>
        <HierarchyFilter
          path={path}
          options={data.options.hierarchy}
          onChange={setPath}
          enabledLevels={["CATEGORY_NAME", "PRODUCT_NAME"]}
          unsupportedNote="customer and channel do not apply, because launch tracking is measured per product across all of its customers and channels"
          className="mt-1"
        />
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="card-title">Launch portfolio</h2>
            <p className="text-xs text-text-tertiary">
              {path.CATEGORY_NAME
                ? `One card per live launch in ${path.CATEGORY_NAME}.`
                : "One card per live launch."}{" "}
              Weekly units are collapsed to one launch-week row before cumulative volume is summed, so a product with multiple analogues is not double counted.
            </p>
            {data.selectedByDefault && selectedLaunch && (
              <p className="mt-1 text-xs text-text-tertiary">
                No product is selected, so the panels below show{" "}
                <span className="font-medium text-foreground">{selectedLaunch.productName}</span>, the earliest launch in {atRoot ? "the portfolio" : scopeLabel}. Pick a card or a product to change it.
              </p>
            )}
          </div>
          {path.CATEGORY_NAME && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPath((current) => ({ PRODUCT_NAME: current.PRODUCT_NAME ?? null }))}
            >
              Show all launches
            </Button>
          )}
        </div>
        {data.launches.length === 0 ? (
          <div className="py-8 text-center">
            {atRoot ? (
              <>
                <p className="text-sm text-text-tertiary">No launches were returned from APP.V_NPD_TRACKING.</p>
                <p className="mt-1 text-xs text-text-tertiary">This page needs products with a LAUNCH_WEEK_ID and weekly units in the launch tracking view.</p>
              </>
            ) : (
              <>
                <p className="text-sm text-text-tertiary">No launches match {scopeLabel}.</p>
                <p className="mt-1 text-xs text-text-tertiary">Launch tracking covers products with a recorded launch week only. Widen the scope to see them.</p>
              </>
            )}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {data.launches.map((launch) => {
              const isShown = launch.productId === data.selectedProductId;
              const isSelected = isShown && !data.selectedByDefault;
              const isDefault = isShown && data.selectedByDefault;
              return (
                <button
                  key={launch.productId}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => selectLaunch(launch)}
                  className={cn(
                    "rounded-xl border p-4 text-left transition-colors",
                    isSelected
                      ? "border-accent bg-accent-subtle"
                      : isDefault
                        ? "border-dashed border-accent bg-[var(--bg-elevated)]"
                        : "border-border bg-[var(--bg-elevated)]",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-display text-base font-semibold">{launch.productName}</p>
                      <p className="mt-1 text-xs text-text-tertiary">
                        {launch.categoryName ? `${launch.categoryName} · ` : ""}Launch {formatWeek(launch.launchWeekId)}
                      </p>
                    </div>
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px]", STATUS_CLASSES[launch.lifecycleStatus] ?? "bg-neutral-subtle text-neutral")}>
                      {launch.lifecycleStatus}
                    </span>
                  </div>
                  {isShown && (
                    <p className="mt-2 text-[11px] font-medium text-accent">
                      {isSelected ? "Selected" : "Shown by default"}
                    </p>
                  )}
                  <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <p className="text-text-tertiary">Weeks since launch</p>
                      <p className="mt-1 font-medium tabular-nums">{launch.weeksSinceLaunch.toLocaleString("en-GB")}</p>
                    </div>
                    <WhyThis
                      subject={`${launch.productName} cumulative launch volume`}
                      source="APP.V_NPD_TRACKING"
                      rationale="Cumulative pieces to date after collapsing the launch tracking view from launch-by-analogue-by-week down to one row per launch week. That avoids double counting launches that were assigned more than one analogue."
                      formatValue={formatUnits}
                      noDriversLabel="This is a cumulative actual, not a driver decomposition"
                    >
                      <div>
                        <p className="text-text-tertiary">Cumulative units</p>
                        <p className="mt-1 font-medium tabular-nums">{formatUnits(launch.cumulativeUnits)}</p>
                      </div>
                    </WhyThis>
                  </div>
                  <div className="mt-4 space-y-2">
                    {launch.analogues.map((analogue) => (
                      <div key={analogue.analogueProductId} className="rounded-md border border-border/60 p-2 text-xs">
                        <div className="font-medium">{analogue.analogueProductName}</div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-text-tertiary">
                          <span>Similarity {formatPercent(analogue.similarityScore * 100, 0)}</span>
                          <span className="tabular-nums">Cannib. {formatPercent(analogue.cannibalisationPct * 100, 0)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="card-title">Launch curve comparison</h2>
              <p className="text-xs text-text-tertiary">
                Weekly launch units indexed against the selected analogue reference window.
              </p>
            </div>
            {data.curveComparisons.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-text-tertiary">
                <span>Analogue</span>
                <select
                  value={selectedAnalogueId}
                  onChange={(event) => setSelectedAnalogueId(event.target.value)}
                  className="min-w-[220px] rounded-md border border-border px-2 py-1 text-foreground"
                  style={{ backgroundColor: "var(--bg-elevated)" }}
                >
                  {data.curveComparisons.map((comparison) => (
                    <option key={comparison.analogueProductId} value={comparison.analogueProductId}>
                      {comparison.analogueProductName}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {!selectedLaunch ? (
            <div className="py-10 text-center">
              <p className="text-sm text-text-tertiary">No launch in {scopeLabel}, so there is no curve to compare.</p>
              <p className="mt-1 text-xs text-text-tertiary">Widen the portfolio scope to pick a launch.</p>
            </div>
          ) : !selectedComparison || selectedComparison.points.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-text-tertiary">No launch curve is available for the selected product.</p>
              <p className="mt-1 text-xs text-text-tertiary">The chart needs weekly launch units in APP.V_NPD_TRACKING and analogue history in CORE.FACT_POS_WEEKLY.</p>
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <span className="font-medium text-foreground">{selectedLaunch.productName}</span>
                  <span className="text-text-tertiary">{" vs "}{selectedComparison.analogueProductName}</span>
                  {data.selectedByDefault && <span className="text-text-tertiary"> (shown by default)</span>}
                </div>
                <div className="flex items-center gap-1.5 tabular-nums">
                  <Direction value={latestGap} />
                  <span className={cn(
                    latestGap !== null && latestGap > 0 ? "text-positive" : latestGap !== null && latestGap < 0 ? "text-negative" : "text-neutral",
                  )}>
                    {latestGap !== null ? `${latestGap >= 0 ? "+" : ""}${latestGap.toFixed(0)} index pts` : "No overlap"}
                  </span>
                  <span className="text-text-tertiary">latest comparable week</span>
                </div>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={selectedComparison.points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                    <XAxis
                      dataKey="weeksSinceLaunch"
                      tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                      stroke="var(--chart-grid)"
                    />
                    <YAxis
                      tickFormatter={(value) => `${Math.round(Number(value))}`}
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
                        return [`${Math.round(Number(value))}`, name];
                      }}
                      labelFormatter={(value) => `Week ${value}`}
                    />
                    <Line
                      dataKey="launchIndex"
                      name={`${selectedLaunch.productName} index`}
                      stroke={CHART_COLORS[0]}
                      strokeWidth={1.75}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="analogueIndex"
                      name={`${selectedComparison.analogueProductName} reference index`}
                      stroke={CHART_COLORS[1]}
                      strokeWidth={1.75}
                      strokeDasharray="4 3"
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 space-y-1 text-xs text-text-tertiary">
                <p>
                  Both lines are rebased so {selectedComparison.analogueProductName}&rsquo;s first {selectedComparison.baseWindowWeeks} observed weeks average 100. This avoids comparing raw units from a smaller launch against a larger parent product.
                </p>
                <p>
                  {selectedComparison.referenceType === "earliest_observed"
                    ? `${selectedComparison.analogueProductName} predates the dataset, so the reference uses its earliest observed period from ${formatWeek(selectedComparison.referenceStartWeekId)} rather than a true launch curve.`
                    : `${selectedComparison.analogueProductName} has a recorded launch anchor, so its reference starts at ${formatWeek(selectedComparison.referenceStartWeekId)}.`}
                </p>
                {observedWeeks < 26 && (
                  <p>
                    {selectedLaunch.productName} currently has {observedWeeks.toLocaleString("en-GB")} observed launch weeks. The shorter curve reflects the launch age, not missing data.
                  </p>
                )}
                {!atRoot && (
                  <p>
                    {selectedComparison.analogueProductName} is a reference product, so its curve uses its full history and is not narrowed by the portfolio scope.
                  </p>
                )}
              </div>
            </>
          )}
        </Card>

        <Card className="space-y-4 p-4">
          <div>
            <h2 className="card-title">Cannibalisation assumption</h2>
            <p className="text-xs text-text-tertiary">
              Gross launch volume split into assumed cannibalised volume and assumed incremental volume. The split is an analogue planning assumption, not a measured elasticity.
            </p>
          </div>
          {selectedLaunch ? (
            <Kpi
              bare
              label="Gross launch volume"
              value={formatUnits(selectedLaunch.cumulativeUnits)}
              why={{
                subject: `${selectedLaunch.productName} gross launch volume`,
                source: "APP.V_NPD_TRACKING",
                rationale: "Cumulative launch units to date from the launch tracking view after removing the analogue fan-out. This is the gross volume before any cannibalisation assumption is applied.",
                formatValue: formatUnits,
                noDriversLabel: "Gross launch volume is an actual cumulative total",
              }}
            />
          ) : null}

          {!selectedLaunch ? (
            <div className="py-6 text-center">
              <p className="text-sm text-text-tertiary">No launch in {scopeLabel}.</p>
              <p className="mt-1 text-xs text-text-tertiary">The split panel needs a launch in scope with CORE.NPD_ANALOGUE rows.</p>
            </div>
          ) : data.cannibalisation.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-text-tertiary">No analogue assumption is recorded for this launch.</p>
              <p className="mt-1 text-xs text-text-tertiary">The split panel needs CORE.NPD_ANALOGUE rows for the selected product.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {data.cannibalisation.map((row) => {
                const cannibalisedShare = row.grossLaunchUnits > 0 ? (row.cannibalisedUnits / row.grossLaunchUnits) * 100 : 0;
                const incrementalShare = row.grossLaunchUnits > 0 ? (row.incrementalUnits / row.grossLaunchUnits) * 100 : 0;
                const isSelected = row.analogueProductId === selectedCannibalisation?.analogueProductId;
                return (
                  <div key={row.analogueProductId} className={cn("rounded-lg border p-3", isSelected ? "border-accent bg-accent-subtle" : "border-border")}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{row.analogueProductName}</p>
                        <p className="mt-1 text-xs text-text-tertiary">
                          Similarity {formatPercent(row.similarityScore * 100, 0)} · Cannibalisation assumption {formatPercent(row.cannibalisationPct * 100, 0)}
                        </p>
                      </div>
                      <WhyThis
                        subject={`${row.analogueProductName} cannibalisation split for ${data.selectedProductName}`}
                        source="CORE.NPD_ANALOGUE.CANNIBALISATION_PCT + APP.V_NPD_TRACKING"
                        rationale="Estimated cannibalised and incremental volume are calculated by applying the recorded CANNIBALISATION_PCT assumption to actual launch units. This rests on a recorded assumption in CORE.NPD_ANALOGUE, not a measured elasticity, so the incremental figure inherits that assumption."
                        formatValue={formatUnits}
                        noDriversLabel="The split is a single stored assumption rather than a driver model"
                      >
                        <div className="text-right">
                          <p className="text-xs text-text-tertiary">Estimated incremental</p>
                          <p className="mt-1 font-medium tabular-nums">{formatUnits(row.incrementalUnits)}</p>
                        </div>
                      </WhyThis>
                    </div>
                    <div className="mt-3 h-3 overflow-hidden rounded-full bg-neutral-subtle" role="img" aria-label={`${row.analogueProductName} cannibalisation split`}>
                      <div className="h-full" style={{ width: `${cannibalisedShare}%`, backgroundColor: "var(--chart-2)" }} />
                      <div className="h-full" style={{ width: `${incrementalShare}%`, backgroundColor: "var(--chart-1)" }} />
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="text-text-tertiary">Estimated cannibalised</p>
                        <p className="mt-1 font-medium tabular-nums">{formatUnits(row.cannibalisedUnits)}</p>
                      </div>
                      <div>
                        <p className="text-text-tertiary">Estimated incremental</p>
                        <p className="mt-1 font-medium tabular-nums">{formatUnits(row.incrementalUnits)}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
              {selectedCannibalisation && (
                <BulletChart
                  actual={selectedCannibalisation.incrementalUnits}
                  target={selectedCannibalisation.grossLaunchUnits}
                  tolerance={selectedCannibalisation.cannibalisationPct}
                  label="Selected analogue incremental volume vs gross"
                  valueLabel={formatUnits(selectedCannibalisation.incrementalUnits)}
                />
              )}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="card-title">Analogue rationale</h2>
          <p className="text-xs text-text-tertiary">
            {atRoot ? "Every recorded analogue assumption." : `Recorded analogue assumptions for launches in ${scopeLabel}.`} Launches can legitimately have more than one analogue, so this table keeps the grain at one new-product-to-analogue row.
          </p>
        </div>
        {data.rationaleRows.length === 0 ? (
          <div className="py-8 text-center">
            {atRoot ? (
              <>
                <p className="text-sm text-text-tertiary">No analogue rationale rows were returned.</p>
                <p className="mt-1 text-xs text-text-tertiary">Check that CORE.NPD_ANALOGUE is populated and that the product dimension joins resolve.</p>
              </>
            ) : (
              <p className="text-sm text-text-tertiary">No analogue assumptions are recorded for launches in {scopeLabel}.</p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-tertiary">
                  <th className="py-2 text-left font-medium">New product</th>
                  <th className="py-2 text-left font-medium">Analogue</th>
                  <th className="num py-2 font-medium">Similarity</th>
                  <th className="num py-2 font-medium">Cannib. %</th>
                  <th className="py-2 text-left font-medium">Rationale</th>
                </tr>
              </thead>
              <tbody>
                {data.rationaleRows.map((row) => (
                  <tr key={`${row.newProductId}-${row.analogueProductId}`} className="border-b border-border/50">
                    <td className="py-2 font-medium">{row.newProductName}</td>
                    <td className="py-2">{row.analogueProductName}</td>
                    <td className="num py-2 tabular-nums">{formatPercent(row.similarityScore * 100, 0)}</td>
                    <td className="num py-2 tabular-nums">{formatPercent(row.cannibalisationPct * 100, 0)}</td>
                    <td className="py-2 text-xs text-text-tertiary">{row.rationale ?? "No rationale recorded"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="card-title">Phase-out risk</h2>
          <p className="text-xs text-text-tertiary">
            Delisted and declining products still carry run-out risk{atRoot ? "" : ` — shown for ${scopeLabel}`}. Remaining volume here means recent pull still moving through the portfolio, not on-hand stock.
          </p>
        </div>
        {data.phaseOut.length === 0 ? (
          <div className="py-8 text-center">
            {atRoot ? (
              <>
                <p className="text-sm text-text-tertiary">No delisted or declining products were returned.</p>
                <p className="mt-1 text-xs text-text-tertiary">This panel expects DELIST_WEEK_ID or LIFECYCLE_STATUS='Decline' products with recent POS history.</p>
              </>
            ) : (
              <>
                <p className="text-sm text-text-tertiary">No delisted or declining products in {scopeLabel}.</p>
                <p className="mt-1 text-xs text-text-tertiary">This panel follows the portfolio scope. Widen it to see every product carrying run-out risk.</p>
              </>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-tertiary">
                  <th className="py-2 text-left font-medium">Product</th>
                  <th className="py-2 text-left font-medium">Status</th>
                  <th className="num py-2 font-medium">Recent 13 weeks</th>
                  <th className="num py-2 font-medium">Vs prior 13</th>
                  <th className="py-2 text-left font-medium">Recent trajectory</th>
                </tr>
              </thead>
              <tbody>
                {data.phaseOut.map((row) => (
                  <tr key={row.productId} className="border-b border-border/50">
                    <td className="py-2">
                      <div className="font-medium">{row.productName}</div>
                      <div className="text-xs text-text-tertiary">
                        {row.delistWeekId ? `Delists ${formatWeek(row.delistWeekId)}` : "Declining product"}
                      </div>
                    </td>
                    <td className="py-2">
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px]", STATUS_CLASSES[row.lifecycleStatus] ?? "bg-neutral-subtle text-neutral")}>
                        {row.delistWeekId ? "Delisted" : row.lifecycleStatus}
                      </span>
                    </td>
                    <td className="num py-2 tabular-nums">{formatUnits(row.recent13Units)}</td>
                    <td className="num py-2 tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <RunoutDirection value={row.recentDelta} />
                        <span className={cn(
                          row.recentDelta !== null && row.recentDelta > 0 ? "text-warning" : row.recentDelta !== null && row.recentDelta < 0 ? "text-positive" : "text-neutral",
                        )}>
                          {row.recentDelta !== null ? formatSignedPercent(row.recentDelta) : "—"}
                        </span>
                      </span>
                    </td>
                    <td className="py-2">
                      <Sparkline
                        data={row.sparkline}
                        width={100}
                        height={24}
                        stroke={CHART_COLORS[2]}
                        label={`Recent 26-week trajectory for ${row.productName}`}
                      />
                    </td>
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