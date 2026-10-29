"use client";

import Link from "next/link";
import * as React from "react";
import {
  HierarchyFilter, pathLabel, pathToParams,
  type HierarchyPath, type HierarchyOptions,
} from "@/components/hierarchy-filter";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Minus,
  MoveRight,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Kpi } from "@/components/kpi";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CHART_COLORS, formatUnits, formatEur } from "@/lib/format";
import { cn } from "@/lib/utils";

const ALL_VALUE = "__all__";

type GroupLevel =
  | "Category"
  | "Product"
  | "Customer"
  | "Technology tier"
  | "Region"
  | "Channel";

type ValueTab = "bridge" | "landed-cost";

type BridgeRow = {
  groupLevel: string;
  groupKey: string;
  q0: number;
  r0: number;
  q1: number;
  r1: number;
  seriesCount: number;
  newSeries: number;
  discontinuedSeries: number;
  revenueChangeEur: number;
  volumeChangeUnits: number;
  volumeGrowth: number | null;
  valueGrowth: number | null;
  valueMinusVolumeGap: number | null;
  baseAvgPrice: number;
  currentAvgPrice: number;
  volumeEffectEur: number;
  priceEffectEur: number;
  mixEffectEur: number;
  effectResidualEur: number;
};

type PriceTierShiftRow = {
  priceTier: string;
  q0: number;
  r0: number;
  q1: number;
  r1: number;
  // Null where the scope has no volume in a period, e.g. a scope holding only a
  // launch: there is no base share to shift from, so none is shown.
  baseVolumeShare: number | null;
  currentVolumeShare: number | null;
  baseValueShare: number | null;
  currentValueShare: number | null;
  volumeShareShift: number | null;
  valueShareShift: number | null;
  baseAvgPrice: number | null;
  currentAvgPrice: number | null;
};

type LandedBuildUpComponent = {
  key: string;
  label: string;
  value: number;
};

type LandedBuildUp = {
  customerId: string;
  customerName: string;
  categoryName: string;
  shelfEurCase: number;
  shelfEurBottle: number;
  taxShareOfShelf: number;
  exwShareOfShelf: number;
  components: LandedBuildUpComponent[];
};

type LandedComparisonRow = {
  customerId: string;
  customerName: string;
  avgExwEurCase: number;
  avgShelfEurCase: number;
  shelfEurBottle: number;
  taxShareOfShelf: number;
  exwShareOfShelf: number;
};

type PassThroughCustomer = {
  customerId: string;
  customerName: string;
  avgExwEurCase: number;
  avgShelfEurCase: number;
  taxShareOfShelf: number;
  exwShareOfShelf: number;
} | null;

/**
 * The cell the build-up shows. Each half is either fixed by the scope (selected,
 * or the only one left in it) or the default the route falls back to.
 */
type LandedCellFilters = {
  categoryName: string;
  customerId: string;
  customerName: string;
  categoryFromScope: boolean;
  customerFromScope: boolean;
};

type DutyExposureRow = {
  customerId: string;
  customerName: string;
  planUnits: number;
  planExwEur: number;
  planShelfEur: number;
  avgTariffPct: number | null;
  avgTaxShare: number | null;
};

type ValuePageData = {
  context: {
    HISTORY_END_WEEK: string;
    CURRENT_WEEK: string;
    HORIZON_END_WEEK: string;
    PRODUCTION_MODEL: string;
    BENCHMARK_MODEL: string;
  };
  filters: {
    groupLevel: GroupLevel;
    path: HierarchyPath;
    scopeLabel: string;
    isEmptyScope?: boolean;
  };
  options: {
    groupLevels: GroupLevel[];
    hierarchy: HierarchyOptions;
  };
  total: BridgeRow | null;
  groups: BridgeRow[];
  priceTierShift: PriceTierShiftRow[];
  // Null when the scope holds no category x customer cell to build up.
  landedCost: {
    filters: LandedCellFilters;
    buildUp: LandedBuildUp;
    comparison: LandedComparisonRow[];
    passThroughInsight: {
      categoryName: string;
      aftermarket: PassThroughCustomer;
      oem: PassThroughCustomer;
    };
    exposure: {
      // Names the selected levels duty exposure cannot honour; null if none.
      scopeNote: string | null;
      summary: {
        planUnits: number;
        planExwEur: number;
        planShelfEur: number;
        avgTariffPct: number | null;
        avgTaxShare: number | null;
      };
      rows: DutyExposureRow[];
    };
  } | null;
};

type SortField =
  | "groupKey"
  | "revenueChangeEur"
  | "volumeEffectEur"
  | "priceEffectEur"
  | "mixEffectEur"
  | "volumeGrowth"
  | "valueGrowth"
  | "valueMinusVolumeGap";

type SortDirection = "asc" | "desc";

function formatSignedPct(value: number | null | undefined, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(decimals)}%`;
}

function formatPct(value: number | null | undefined, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(decimals)}%`;
}

function formatPp(value: number | null | undefined, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(decimals)}pp`;
}

function formatPricePerCase(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `€${value.toFixed(2)}/pc`;
}

function formatPricePerBottle(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `€${value.toFixed(2)}/pc`;
}

function toSelectValue(value: string | null | undefined) {
  return value ?? ALL_VALUE;
}

function fromSelectValue<T extends string>(value: string | null) {
  return value === null || value === ALL_VALUE ? null : (value as T);
}

function Direction({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || Math.abs(value) < 0.0001) {
    return <Minus size={13} className="text-neutral" aria-hidden="true" />;
  }
  return value > 0 ? (
    <TrendingUp size={13} className="text-positive" aria-hidden="true" />
  ) : (
    <TrendingDown size={13} className="text-negative" aria-hidden="true" />
  );
}

function SortIcon({ direction }: { direction: SortDirection | null }) {
  if (direction === "asc") return <ArrowUp size={12} aria-hidden="true" />;
  if (direction === "desc") return <ArrowDown size={12} aria-hidden="true" />;
  return <Minus size={12} aria-hidden="true" />;
}

function bridgeDeltaClass(value: number) {
  if (Math.abs(value) < 0.0001) return "bg-neutral-subtle text-neutral";
  return value > 0 ? "bg-positive-subtle text-positive" : "bg-negative-subtle text-negative";
}

function getSortValue(row: BridgeRow, field: SortField) {
  switch (field) {
    case "groupKey":
      return row.groupKey.toLowerCase();
    case "revenueChangeEur":
      return row.revenueChangeEur;
    case "volumeEffectEur":
      return row.volumeEffectEur;
    case "priceEffectEur":
      return row.priceEffectEur;
    case "mixEffectEur":
      return row.mixEffectEur;
    case "volumeGrowth":
      return row.volumeGrowth ?? Number.NEGATIVE_INFINITY;
    case "valueGrowth":
      return row.valueGrowth ?? Number.NEGATIVE_INFINITY;
    case "valueMinusVolumeGap":
      return row.valueMinusVolumeGap ?? Number.NEGATIVE_INFINITY;
  }
}

function buildWaterfallData(total: BridgeRow) {
  const steps = [
    { key: "Base revenue", start: 0, value: total.r0, type: "total" as const, end: total.r0 },
    {
      key: "Volume",
      start: total.r0,
      value: total.volumeEffectEur,
      type: "delta" as const,
      end: total.r0 + total.volumeEffectEur,
    },
    {
      key: "Price",
      start: total.r0 + total.volumeEffectEur,
      value: total.priceEffectEur,
      type: "delta" as const,
      end: total.r0 + total.volumeEffectEur + total.priceEffectEur,
    },
    {
      key: "Mix",
      start: total.r0 + total.volumeEffectEur + total.priceEffectEur,
      value: total.mixEffectEur,
      type: "delta" as const,
      end: total.r0 + total.revenueChangeEur,
    },
    {
      key: "Current revenue",
      start: 0,
      value: total.r1,
      type: "total" as const,
      end: total.r1,
    },
  ];

  return steps.map((step) => {
    if (step.type === "total") {
      return {
        label: step.key,
        spacer: 0,
        positive: step.value >= 0 ? step.value : 0,
        negative: step.value < 0 ? step.value : 0,
        end: step.end,
        value: step.value,
        type: step.type,
      };
    }

    return {
      label: step.key,
      spacer: Math.min(step.start, step.end),
      positive: step.value > 0 ? Math.abs(step.value) : 0,
      negative: step.value < 0 ? step.value : 0,
      end: step.end,
      value: step.value,
      type: step.type,
    };
  });
}

/**
 * The readout, written from the numbers so it holds for any scope. A fixed
 * sentence about the whole portfolio is wrong the moment the scope narrows.
 */
function bridgeNarrative(total: BridgeRow) {
  const verb = (value: number) => (value < 0 ? "took out" : "added");
  return `Volume ${verb(total.volumeEffectEur)} ${formatEur(Math.abs(total.volumeEffectEur))}, price ${verb(total.priceEffectEur)} ${formatEur(Math.abs(total.priceEffectEur))} and mix ${verb(total.mixEffectEur)} ${formatEur(Math.abs(total.mixEffectEur))}, leaving revenue ${total.revenueChangeEur < 0 ? "down" : "up"} ${formatEur(Math.abs(total.revenueChangeEur))} on the rolling year.`;
}

/** False when the scope has no volume in one of the two years to share out. */
function hasComparableTierShift(rows: PriceTierShiftRow[]) {
  return rows.some((row) => row.volumeShareShift !== null && row.valueShareShift !== null);
}

function priceTierNarrative(rows: PriceTierShiftRow[]) {
  if (!hasComparableTierShift(rows)) {
    return "This scope has no volume in one of the two years, so there is no tier share to shift from.";
  }

  const upgrading = rows
    .filter((row) =>
      row.valueShareShift !== null
      && row.volumeShareShift !== null
      && row.valueShareShift > row.volumeShareShift,
    )
    .map((row) => row.priceTier);

  if (!upgrading.length) {
    return "Value share is not outrunning volume share in any tier, so there is no clear content-upgrade signal in this cut.";
  }

  return `Value share moved faster than volume share in ${upgrading.join(", ")}, which is the content-upgrade signal finance will look for in the bridge.`;
}

/**
 * Which half of the build-up cell the scope chose, which fell back to the
 * default, and how to choose another. The build-up is a single category x
 * customer, so a scope that leaves either open still has to show one.
 */
function landedCellNote(filters: LandedCellFilters) {
  if (filters.categoryFromScope && filters.customerFromScope) {
    return "The scope fixes this cell.";
  }
  const customer = filters.customerName === "Ford (EU & Mexico)"
    ? "Ford (EU & Mexico)"
    : `${filters.customerName}, because Ford (EU & Mexico) is not in scope`;
  if (!filters.categoryFromScope && !filters.customerFromScope) {
    return `The scope does not pick a category or a customer, so the build-up opens on ${filters.categoryName} in ${customer}. Pick a category or a customer in the scope above to choose a different cell.`;
  }
  if (!filters.categoryFromScope) {
    return `The scope does not pick a category, so the build-up defaults to ${filters.categoryName}. Pick a category in the scope above to choose a different cell.`;
  }
  return `The scope does not pick a customer, so the build-up defaults to ${customer}. Pick a customer in the scope above to choose a different cell.`;
}

function buildCompositionChartRow(buildUp: LandedBuildUp | null) {
  if (!buildUp) return [];

  const row: Record<string, number | string> = {
    label: `${buildUp.customerName} · ${buildUp.categoryName}`,
  };

  for (const component of buildUp.components) {
    row[component.key] = component.value;
  }

  return [row];
}

function buildCompositionLegend(buildUp: LandedBuildUp | null) {
  if (!buildUp) return [];
  return buildUp.components.map((component, index) => ({
    ...component,
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));
}

function barLabel(value: string | number | boolean | null | undefined) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 20) return "";
  return `€${numericValue.toFixed(0)}`;
}

export default function ValuePage() {
  const [data, setData] = React.useState<ValuePageData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [groupLevel, setGroupLevel] = React.useState<GroupLevel>("Category");
  // Hierarchy scope for BOTH tabs. Purely user-driven: it is never set from a
  // response, so it cannot start the fetch loop that a response-derived
  // dependency would.
  const [path, setPath] = React.useState<HierarchyPath>({});
  // Controlled because the page swaps to a skeleton while it reloads, which
  // remounts the tabs. Left to defaultValue, narrowing the scope from the
  // landed-cost tab would drop the planner back on the bridge every time.
  const [tab, setTab] = React.useState<ValueTab>("bridge");
  const [sortField, setSortField] = React.useState<SortField>("revenueChangeEur");
  const [sortDirection, setSortDirection] = React.useState<SortDirection>("desc");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("groupLevel", groupLevel);
      for (const [key, value] of Object.entries(pathToParams(path))) {
        params.set(key, value);
      }
      const response = await fetch(`/api/value?${params.toString()}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to load volume to value");
      setData(json as ValuePageData);
    } catch (requestError) {
      setData(null);
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [groupLevel, path]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const handleSort = React.useCallback((field: SortField) => {
    setSortField((current) => {
      if (current === field) {
        setSortDirection((direction) => (direction === "desc" ? "asc" : "desc"));
        return current;
      }
      setSortDirection(field === "groupKey" ? "asc" : "desc");
      return field;
    });
  }, []);

  if (error) {
    return (
      <div className="p-6">
        <Card className="bg-negative-subtle p-4">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div>
              <p className="font-medium text-negative">Could not load volume to value.</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="p-6">
        <PageSkeleton kpis={5} chart rows={8} />
      </div>
    );
  }

  const total = data.total;
  const landed = data.landedCost;
  const waterfallData = total ? buildWaterfallData(total) : [];
  const sortedGroups = [...data.groups].sort((left, right) => {
    const leftValue = getSortValue(left, sortField);
    const rightValue = getSortValue(right, sortField);
    if (typeof leftValue === "string" && typeof rightValue === "string") {
      return sortDirection === "asc"
        ? leftValue.localeCompare(rightValue)
        : rightValue.localeCompare(leftValue);
    }
    const leftNumber = Number(leftValue);
    const rightNumber = Number(rightValue);
    return sortDirection === "asc" ? leftNumber - rightNumber : rightNumber - leftNumber;
  });

  const largestResidual = Math.max(
    Math.abs(total?.effectResidualEur ?? 0),
    ...sortedGroups.map((row) => Math.abs(row.effectResidualEur)),
  );

  const buildUp = landed?.buildUp ?? null;
  const compositionData = buildCompositionChartRow(buildUp);
  const compositionLegend = buildCompositionLegend(buildUp);
  const comparisonRows = landed?.comparison ?? [];
  const aftermarketInsight = landed?.passThroughInsight.aftermarket ?? null;
  const oemInsight = landed?.passThroughInsight.oem ?? null;
  // Product and channel narrow the build-up and the comparison, which average
  // the series in scope, so the cell's description names them.
  const landedNarrowedBy = [path.PRODUCT_NAME, path.CHANNEL_NAME]
    .filter((value): value is string => Boolean(value))
    .join(", ");

  // An empty scope is a legitimate selection, not an error: a product and a customer
  // it does not sell in genuinely has no rows. Each tab says so and points back
  // to the scope, rather than rendering zeroes that look like a real finding.
  const bridgeContent = !total ? (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 text-text-tertiary" aria-hidden="true" />
        <div>
          <h2 className="card-title">
            No series match {data.filters.scopeLabel}
          </h2>
          <p className="mt-1 text-sm text-text-tertiary">
            That combination exists in the dropdowns but has no shipments in
            either comparison period. Widen a level in the scope above to continue.
          </p>
        </div>
      </div>
    </Card>
  ) : (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,260px)_1fr] md:items-end">
          <label className="text-xs">
            <span className="text-text-tertiary">Break out by</span>
            <Select
              value={toSelectValue(groupLevel)}
              onValueChange={(value) => {
                const next = fromSelectValue<GroupLevel>(value);
                if (next) setGroupLevel(next);
              }}
            >
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {data.options.groupLevels.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <div className="text-xs text-text-tertiary">
            Price effect is zero on new and discontinued series because there is no like-for-like base price. Those lines still contribute through volume and mix, so non-comparability is surfaced rather than hidden.
          </div>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi
          label="Value minus volume gap"
          value={formatPp(total.valueMinusVolumeGap)}
          valueClassName="text-accent"
          detail={
            <>
              <Direction value={total.valueMinusVolumeGap} />
              <span>Revenue held {formatPp(total.valueMinusVolumeGap)} ahead of volume.</span>
            </>
          }
        />

        <Kpi
          label="Revenue change"
          value={formatEur(total.revenueChangeEur)}
          detail={`Base ${formatEur(total.r0)} to current ${formatEur(total.r1)}`}
        />

        <Kpi
          label="Volume growth"
          value={formatSignedPct(total.volumeGrowth)}
          detail={
            <>
              <Direction value={total.volumeGrowth} />
              <span>{formatUnits(total.volumeChangeUnits)} versus the base year.</span>
            </>
          }
        />

        <Kpi
          label="Value growth"
          value={formatSignedPct(total.valueGrowth)}
          detail={
            <>
              <Direction value={total.valueGrowth} />
              <span>Revenue performance over the same rolling year.</span>
            </>
          }
        />

        <Kpi
          label="Average price per piece"
          value={formatPricePerCase(total.currentAvgPrice)}
          detail={`Base ${formatPricePerCase(total.baseAvgPrice)} to current ${formatPricePerCase(total.currentAvgPrice)}`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)]">
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h2 className="card-title">Revenue bridge</h2>
              <p className="text-xs text-text-tertiary">
                Base revenue walks through volume, price and mix into current revenue. Bars above zero are gains, bars below zero are drags, and the dashed line marks the running total.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-text-tertiary">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="inline-block size-3 rounded-[2px] bg-positive-subtle" />
                Positive contribution
              </span>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="inline-block h-3 w-3 rotate-45 bg-negative-subtle" />
                Negative contribution
              </span>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="h-0 w-5 border-t border-dashed border-chart-5" />
                Running revenue
              </span>
            </div>
          </div>

          <div className="h-[360px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={waterfallData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                  stroke="var(--chart-grid)"
                  interval={0}
                />
                <YAxis
                  tickFormatter={(value) => formatEur(Number(value)).replace("€", "")}
                  tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                  stroke="var(--chart-grid)"
                  width={64}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(_value, _name, item) => {
                    const payload = item.payload as {
                      label: string;
                      value: number;
                      end: number;
                      type: "total" | "delta";
                    };
                    return [
                      payload.type === "total"
                        ? `${formatEur(payload.value)} total`
                        : `${formatEur(payload.value)} contribution`,
                      `${payload.label}`,
                    ];
                  }}
                />
                <ReferenceLine y={0} stroke="var(--chart-grid)" strokeWidth={0.5} />
                <Bar dataKey="spacer" stackId="bridge" fill="transparent" isAnimationActive={false} />
                <Bar
                  dataKey="positive"
                  stackId="bridge"
                  name="Positive"
                  fill="var(--chart-3)"
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="negative"
                  stackId="bridge"
                  name="Negative"
                  fill="var(--chart-4)"
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="end"
                  name="Running revenue"
                  stroke="var(--chart-5)"
                  strokeDasharray="6 4"
                  strokeWidth={1.6}
                  dot={{ r: 2 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-3">
              <h2 className="card-title">Bridge readout</h2>
              <p className="text-xs text-text-tertiary">{bridgeNarrative(total)}</p>
            </div>

            <div className="space-y-2">
              {[
                { label: "Volume effect", value: total.volumeEffectEur },
                { label: "Price effect", value: total.priceEffectEur },
                { label: "Mix effect", value: total.mixEffectEur },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <span className="text-text-tertiary">{item.label}</span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-1.5 py-0.5 tabular-nums",
                      bridgeDeltaClass(item.value),
                    )}
                  >
                    <Direction value={item.value} />
                    <span>{formatEur(item.value)}</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4">
            <div className="mb-3">
              <h2 className="card-title">Like-for-like caveat</h2>
              <p className="text-xs text-text-tertiary">
                New or discontinued series have no base price to compare against, so they drop out of the price effect by construction.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-border px-3 py-2">
                <p className="text-xs text-text-tertiary">New series</p>
                <p className="mt-1 font-display text-xl font-semibold tabular-nums">{total.newSeries}</p>
              </div>
              <div className="rounded-lg border border-border px-3 py-2">
                <p className="text-xs text-text-tertiary">Discontinued series</p>
                <p className="mt-1 font-display text-xl font-semibold tabular-nums">
                  {total.discontinuedSeries}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-text-tertiary">
              Out of {total.seriesCount} series in scope, {total.newSeries + total.discontinuedSeries} are not cleanly like-for-like on price.
            </p>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h2 className="card-title">Bridge table</h2>
              <p className="text-xs text-text-tertiary">
                {groupLevel} rows are sorted by the selected metric. The largest absolute additivity residual in this payload is {formatEur(largestResidual)}.
              </p>
            </div>
            <Badge className="bg-neutral-subtle text-neutral">{groupLevel} view</Badge>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="text-xs text-text-tertiary">
                <TableHead>
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("groupKey")}>
                    <span>{groupLevel}</span>
                    <SortIcon direction={sortField === "groupKey" ? sortDirection : null} />
                  </button>
                </TableHead>
                <TableHead className="num">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("revenueChangeEur")}>
                    <span>Revenue change</span>
                    <SortIcon direction={sortField === "revenueChangeEur" ? sortDirection : null} />
                  </button>
                </TableHead>
                <TableHead className="num">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("volumeEffectEur")}>
                    <span>Volume</span>
                    <SortIcon direction={sortField === "volumeEffectEur" ? sortDirection : null} />
                  </button>
                </TableHead>
                <TableHead className="num">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("priceEffectEur")}>
                    <span>Price</span>
                    <SortIcon direction={sortField === "priceEffectEur" ? sortDirection : null} />
                  </button>
                </TableHead>
                <TableHead className="num">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("mixEffectEur")}>
                    <span>Mix</span>
                    <SortIcon direction={sortField === "mixEffectEur" ? sortDirection : null} />
                  </button>
                </TableHead>
                <TableHead className="num">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("volumeGrowth")}>
                    <span>Volume growth</span>
                    <SortIcon direction={sortField === "volumeGrowth" ? sortDirection : null} />
                  </button>
                </TableHead>
                <TableHead className="num">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => handleSort("valueGrowth")}>
                    <span>Value growth</span>
                    <SortIcon direction={sortField === "valueGrowth" ? sortDirection : null} />
                  </button>
                </TableHead>
                <TableHead className="num">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1"
                    onClick={() => handleSort("valueMinusVolumeGap")}
                  >
                    <span>Gap</span>
                    <SortIcon direction={sortField === "valueMinusVolumeGap" ? sortDirection : null} />
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedGroups.map((row) => (
                <TableRow key={row.groupKey}>
                  <TableCell>
                    <div className="font-medium">{row.groupKey}</div>
                    <div className="text-xs text-text-tertiary">
                      {row.newSeries + row.discontinuedSeries > 0
                        ? `${row.newSeries} new / ${row.discontinuedSeries} discontinued`
                        : `${row.seriesCount} like-for-like series`}
                    </div>
                  </TableCell>
                  <TableCell className="num tabular-nums">{formatEur(row.revenueChangeEur)}</TableCell>
                  <TableCell className="num tabular-nums">{formatEur(row.volumeEffectEur)}</TableCell>
                  <TableCell className="num tabular-nums">{formatEur(row.priceEffectEur)}</TableCell>
                  <TableCell className="num tabular-nums">{formatEur(row.mixEffectEur)}</TableCell>
                  <TableCell className="num tabular-nums">{formatSignedPct(row.volumeGrowth)}</TableCell>
                  <TableCell className="num tabular-nums">{formatSignedPct(row.valueGrowth)}</TableCell>
                  <TableCell className="num tabular-nums">{formatPp(row.valueMinusVolumeGap)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">Technology tier shift</h2>
            <p className="text-xs text-text-tertiary">
              {priceTierNarrative(data.priceTierShift)} Shares are taken within the scope ({data.filters.scopeLabel}).
            </p>
          </div>

          {/* No chart without a share to shift from: empty bars would read as no shift. */}
          {hasComparableTierShift(data.priceTierShift) ? (
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data.priceTierShift} layout="vertical" margin={{ top: 8, right: 12, left: 16, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                  <XAxis
                    type="number"
                    tickFormatter={(value) => `${(Number(value) * 100).toFixed(1)}pp`}
                    tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                    stroke="var(--chart-grid)"
                  />
                  <YAxis
                    type="category"
                    dataKey="priceTier"
                    tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                    stroke="var(--chart-grid)"
                    width={96}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    formatter={(value, name) => [formatPp(Number(value)), name]}
                  />
                  <ReferenceLine x={0} stroke="var(--chart-grid)" strokeWidth={0.5} />
                  <Bar
                    dataKey="volumeShareShift"
                    name="Volume share shift"
                    fill="var(--chart-2)"
                    radius={[0, 3, 3, 0]}
                    isAnimationActive={false}
                  />
                  <Line
                    type="linear"
                    dataKey="valueShareShift"
                    name="Value share shift"
                    stroke="var(--chart-4)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow className="text-xs text-text-tertiary">
                <TableHead>Tier</TableHead>
                <TableHead className="num">Volume share shift</TableHead>
                <TableHead className="num">Value share shift</TableHead>
                <TableHead className="num">Base avg price</TableHead>
                <TableHead className="num">Current avg price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.priceTierShift.map((row) => (
                <TableRow key={row.priceTier}>
                  <TableCell>{row.priceTier}</TableCell>
                  <TableCell className="num tabular-nums">{formatPp(row.volumeShareShift)}</TableCell>
                  <TableCell className="num tabular-nums">{formatPp(row.valueShareShift)}</TableCell>
                  <TableCell className="num tabular-nums">{formatPricePerCase(row.baseAvgPrice)}</TableCell>
                  <TableCell className="num tabular-nums">{formatPricePerCase(row.currentAvgPrice)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card className="bg-neutral-subtle p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.5fr)]">
          <div>
            <h2 className="card-title">How the decomposition works</h2>
            <p className="mt-2 text-sm text-text-tertiary">
              Volume is the change in total quantity valued at the base average price. Price is like-for-like pricing on current volumes. Mix is this period&apos;s volumes valued at base prices versus the same total volume valued at the base average price. The three components sum to the revenue change exactly, subject only to rounding in presentation.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-3 text-xs text-text-tertiary">
            <p className="font-medium text-foreground">Payload check</p>
            <p className="mt-1">Largest bridge residual: {formatEur(largestResidual)}</p>
            <p className="mt-1">Total rows in view: {sortedGroups.length}</p>
            <p className="mt-1">Selected grain: {groupLevel}</p>
          </div>
        </div>
      </Card>
    </div>
  );

  const landedCostContent = !landed ? (
    <Card className="p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 text-text-tertiary" aria-hidden="true" />
        <div>
          <h2 className="card-title">
            No landed-cost series match {data.filters.scopeLabel}
          </h2>
          <p className="mt-1 text-sm text-text-tertiary">
            There is no category &times; customer cell in this scope to build a delivered cost
            price for. Widen a level in the scope above to continue.
          </p>
        </div>
      </div>
    </Card>
  ) : (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
          <div>
            <p className="text-xs text-text-tertiary">Build-up cell, from the scope above</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge
                className={landed.filters.categoryFromScope
                  ? "bg-accent-subtle text-accent"
                  : "bg-neutral-subtle text-neutral"}
              >
                Category: {landed.filters.categoryName}
                {landed.filters.categoryFromScope ? "" : " (default)"}
              </Badge>
              <Badge
                className={landed.filters.customerFromScope
                  ? "bg-accent-subtle text-accent"
                  : "bg-neutral-subtle text-neutral"}
              >
                Customer: {landed.filters.customerName}
                {landed.filters.customerFromScope ? "" : " (default)"}
              </Badge>
            </div>
            <p className="mt-2 text-xs text-text-tertiary">{landedCellNote(landed.filters)}</p>
          </div>

          <div className="text-xs text-text-tertiary">
            Delivered cost is built from duty-paid cost upward. OEM rows carry no distributor margin or VAT by design: OEMs buy direct and recover VAT.
          </div>
        </div>
      </Card>

      <Card className="border border-border bg-accent-subtle p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:items-center">
          <div>
            <p className="text-xs font-medium uppercase text-accent">Pass-through insight</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Fixed example &mdash; not affected by scope. It always compares brake systems for BMW Group and the independent aftermarket, to show the mechanism.
            </p>
            <h2 className="mt-2 font-display text-xl font-semibold text-foreground">
              The same tariff rate hits delivered cost harder where ex-works is most of it.
            </h2>
            <p className="mt-2 text-sm text-foreground">
              Margin and VAT multiply on top of duty-paid cost, so a tariff on Vectron's price is felt in proportion to how much of the delivered cost is still ex-works. For {landed.passThroughInsight.categoryName}, a garage buying through a distributor pays {formatPct(aftermarketInsight?.taxShareOfShelf)} on top of ex-works ({formatPct(aftermarketInsight?.exwShareOfShelf)} is Vectron's price), while BMW Group pays only {formatPct(oemInsight?.taxShareOfShelf)} on top ({formatPct(oemInsight?.exwShareOfShelf)} ex-works). The OEM, buying direct, takes the full force of a tariff; the aftermarket dilutes it.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Kpi
              bare
              className="rounded-lg border border-border bg-card px-3 py-3"
              label="Independent aftermarket"
              value={<>{formatPct(aftermarketInsight?.taxShareOfShelf)} on top</>}
              valueClassName="text-foreground"
              detail={`${formatPct(aftermarketInsight?.exwShareOfShelf)} ex-works share of delivered cost`}
            />
            <Kpi
              bare
              className="rounded-lg border border-border bg-card px-3 py-3"
              label="BMW Group"
              value={<>{formatPct(oemInsight?.taxShareOfShelf)} on top</>}
              valueClassName="text-foreground"
              detail={`${formatPct(oemInsight?.exwShareOfShelf)} ex-works share of delivered cost`}
            />
          </div>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h2 className="card-title">Delivered cost build-up</h2>
              <p className="text-xs text-text-tertiary">
                {buildUp
                  ? `${buildUp.customerName} ${buildUp.categoryName}${landedNarrowedBy ? ` (${landedNarrowedBy} only)` : ""} from ex-works to delivered, in euro per piece.`
                  : "No build-up data is available for this selection."}
              </p>
            </div>
            {buildUp ? (
              <Badge className="bg-neutral-subtle text-neutral">{formatPricePerBottle(buildUp.shelfEurBottle)}</Badge>
            ) : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(220px,0.9fr)]">
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={compositionData}
                  layout="vertical"
                  margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                >
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                  <XAxis
                    type="number"
                    tickFormatter={(value) => formatEur(Number(value)).replace("€", "")}
                    tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                    stroke="var(--chart-grid)"
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                    stroke="var(--chart-grid)"
                    width={140}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    formatter={(value, name) => [formatPricePerCase(Number(value)), name]}
                  />
                  {compositionLegend.map((component) => (
                    <Bar
                      key={component.key}
                      dataKey={component.key}
                      stackId="landed"
                      name={component.label}
                      fill={component.color}
                      isAnimationActive={false}
                    >
                      <LabelList
                        dataKey={component.key}
                        position="inside"
                        fill="var(--foreground)"
                        formatter={barLabel}
                      />
                    </Bar>
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-2">
              {compositionLegend.map((component) => (
                <div key={component.key} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block size-3 rounded-[2px]"
                      style={{ background: component.color }}
                    />
                    <span>{component.label}</span>
                  </span>
                  <span className="tabular-nums text-text-tertiary">{formatPricePerCase(component.value)}</span>
                </div>
              ))}
              {buildUp ? (
                <div className="rounded-lg border border-border bg-neutral-subtle px-3 py-2 text-sm">
                  <p className="font-medium text-foreground">Delivered total</p>
                  <p className="mt-1 tabular-nums text-text-tertiary">{formatPricePerCase(buildUp.shelfEurCase)}</p>
                </div>
              ) : null}
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">Forward tariff exposure</h2>
            <p className="text-xs text-text-tertiary">
              Showing {landed.filters.categoryName} {path.CUSTOMER_NAME ? `in ${path.CUSTOMER_NAME}` : "across all customers"}. Exposure is plan-weighted from <span className="font-medium text-foreground">V_DUTY_EXPOSURE</span>, not history-weighted, because duty risk is a forward planning question.
            </p>
            {landed.exposure.scopeNote ? (
              <p className="mt-1 text-xs text-text-tertiary">{landed.exposure.scopeNote}</p>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Kpi
              bare
              className="rounded-lg border border-border px-3 py-3"
              label="Plan units"
              value={formatUnits(landed.exposure.summary.planUnits)}
              valueClassName="text-foreground"
            />
            <Kpi
              bare
              className="rounded-lg border border-border px-3 py-3"
              label="Plan EXW value"
              value={formatEur(landed.exposure.summary.planExwEur)}
              valueClassName="text-foreground"
            />
            <Kpi
              bare
              className="rounded-lg border border-border px-3 py-3"
              label="Plan delivered value"
              value={formatEur(landed.exposure.summary.planShelfEur)}
              valueClassName="text-foreground"
            />
            <div className="rounded-lg border border-border px-3 py-3">
              <p className="text-xs text-text-tertiary">Weighted averages</p>
              <p className="mt-1 text-sm tabular-nums text-foreground">
                Tariff {formatPct(landed.exposure.summary.avgTariffPct)}
              </p>
              <p className="mt-1 text-sm tabular-nums text-text-tertiary">
                Tax share {formatPct(landed.exposure.summary.avgTaxShare)}
              </p>
            </div>
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="card-title">Customer comparison</h2>
            <p className="text-xs text-text-tertiary">
              {path.CUSTOMER_NAME
                ? `The scope pins ${path.CUSTOMER_NAME}, so it is the only customer compared. Clear the customer level to compare across customers.`
                : "Customers are sorted by share above ex-works, descending so the cost structures furthest above ex-works sit first."}
            </p>
          </div>
          <Badge className="bg-neutral-subtle text-neutral">{landed.filters.categoryName}</Badge>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="text-xs text-text-tertiary">
              <TableHead>Customer</TableHead>
              <TableHead className="num">Avg EXW / case</TableHead>
              <TableHead className="num">Avg delivered / piece</TableHead>
              <TableHead className="num">Delivered / piece</TableHead>
              <TableHead className="num">Tax share</TableHead>
              <TableHead className="num">EXW share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {comparisonRows.map((row) => (
              <TableRow key={row.customerId}>
                <TableCell>{row.customerName}</TableCell>
                <TableCell className="num tabular-nums">{formatPricePerCase(row.avgExwEurCase)}</TableCell>
                <TableCell className="num tabular-nums">{formatPricePerCase(row.avgShelfEurCase)}</TableCell>
                <TableCell className="num tabular-nums">{formatPricePerBottle(row.shelfEurBottle)}</TableCell>
                <TableCell className="num tabular-nums">{formatPct(row.taxShareOfShelf)}</TableCell>
                <TableCell className="num tabular-nums">{formatPct(row.exwShareOfShelf)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="card-title">Plan-weighted exposure by customer</h2>
            <p className="text-xs text-text-tertiary">
              These rows weight tariff and tax shares by planned units, so large forward volume carries the signal.
              {landed.exposure.scopeNote ? ` ${landed.exposure.scopeNote}` : null}
            </p>
          </div>
          <Link href="/scenarios" className="text-sm font-medium text-accent underline-offset-4 hover:underline">
            Tariff scenarios live on /scenarios
          </Link>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="text-xs text-text-tertiary">
              <TableHead>Customer</TableHead>
              <TableHead className="num">Plan units</TableHead>
              <TableHead className="num">Plan EXW</TableHead>
              <TableHead className="num">Plan delivered</TableHead>
              <TableHead className="num">Avg tariff</TableHead>
              <TableHead className="num">Avg tax share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {landed.exposure.rows.map((row) => (
              <TableRow key={row.customerId}>
                <TableCell>{row.customerName}</TableCell>
                <TableCell className="num tabular-nums">{formatUnits(row.planUnits)}</TableCell>
                <TableCell className="num tabular-nums">{formatEur(row.planExwEur)}</TableCell>
                <TableCell className="num tabular-nums">{formatEur(row.planShelfEur)}</TableCell>
                <TableCell className="num tabular-nums">{formatPct(row.avgTariffPct)}</TableCell>
                <TableCell className="num tabular-nums">{formatPct(row.avgTaxShare)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Finance bridge"
        headline="Volume to value"
        subtitle="Why revenue and volume move apart: OEM price-downs, a shrinking material surcharge and a shift into mechatronic and e-drive content, decomposed exactly. Plus what a part costs the customer once delivered, and where a cross-border tariff would bite. Rates are illustrative."
        icon={<MoveRight size={18} aria-hidden="true" />}
        metadata={
          <span className="text-[13px]">
            Scope: <span className="font-medium">{pathLabel(path)}</span>
          </span>
        }
      />

      <Card className="p-4">
        <h2 className="card-title">Portfolio scope</h2>
        <p className="mt-1 text-xs text-text-tertiary">
          One scope drives both tabs. The bridge is recalculated for it &mdash;
          including the base average price the volume and mix effects are
          measured against &mdash; and so are the tier shares. The landed-cost tab
          takes its category &times; customer cell from it.
        </p>
        <HierarchyFilter
          className="mt-3"
          path={path}
          options={data.options.hierarchy}
          onChange={setPath}
        />
      </Card>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ValueTab)}>
        <TabsList variant="line" className="flex w-full flex-wrap justify-start gap-2 rounded-none bg-transparent p-0">
          <TabsTrigger value="bridge" className="rounded-md px-2 py-1 text-sm">
            Volume to value bridge
          </TabsTrigger>
          <TabsTrigger value="landed-cost" className="rounded-md px-2 py-1 text-sm">
            Delivered cost &amp; tariffs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="bridge" className="mt-4">
          {bridgeContent}
        </TabsContent>

        <TabsContent value="landed-cost" className="mt-4">
          {landedCostContent}
        </TabsContent>
      </Tabs>
    </div>
  );
}