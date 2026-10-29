"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  LineChart,
  Minus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Kpi, KpiRow } from "@/components/kpi";
import { Input } from "@/components/ui/input";
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
import { Textarea } from "@/components/ui/textarea";
import {
  HierarchyFilter,
  pathLabel,
  pathToParams,
  rollupQuery,
  type HierarchyOptions,
  type HierarchyPath,
} from "@/components/hierarchy-filter";
import {
  CATEGORY_COLORS,
  formatUnits,
  formatEur,
  formatSignedPercent,
  formatWeek,
  formatWeekShort,
  SEGMENT_CLASSES,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { StreamGridPanel } from "@/components/plan-grid-panels";

const HISTORY_OPTIONS = [13, 26, 52, 78, 104] as const;
const FORECAST_OPTIONS = [8, 12, 20, 28] as const;
const SCENARIO_DASHES = ["6 4", "3 3", "10 4"] as const;
const CHART_HEIGHT = 460;

type Measure = "units" | "revenue";
type HierarchyLevel = "CATEGORY_NAME" | "PRODUCT_NAME" | "CUSTOMER_NAME" | "CHANNEL_NAME" | "SERIES_ID";

type PlanData = {
  context: {
    HISTORY_END_WEEK: string;
    CURRENT_WEEK: string;
    HORIZON_END_WEEK: string;
    PRODUCTION_MODEL: string;
    BENCHMARK_MODEL: string;
  };
  integrity: Array<{ CHECK_NAME: string; VIOLATIONS: number }>;
  filters: {
    path: HierarchyPath;
    weeksBack: number;
    weeksForward: number;
    measure: Measure;
    streams: string[];
    scenarioIds: string[];
  };
  selection: {
    /** Null, with no key, when the path skips a level and so is not a node. */
    level: HierarchyLevel | null;
    key: string | null;
    label: string;
    path: Partial<Record<HierarchyLevel, string>>;
    isRoot: boolean;
    writable: boolean;
    blockedReason: string | null;
  };
  todayWeek: string;
  weekly: Array<{
    weekId: string;
    weekStartDate: string;
    actual: number | null;
    plan: number | null;
    baseline: number | null;
    event: number | null;
    promotion: number | null;
    sales: number | null;
    marketing: number | null;
    finance: number | null;
    planner: number | null;
    agent: number | null;
    scenarios: Record<string, number | null>;
  }>;
  kpis: {
    planTotal: number;
    lastYearTotal: number;
    vsLastYear: number;
    vsLastYearPct: number | null;
    components: Array<{
      key: string;
      label: string;
      description: string | null;
      colourToken: string;
      kind?: string;
      isTarget?: boolean;
      ownerRole?: string | null;
      value: number;
      pctOfBaseline: number | null;
      active: boolean;
    }>;
  };
  options: {
    hierarchy: HierarchyOptions;
  };
  streams: Array<{
    streamId: string;
    streamLabel: string;
    description: string | null;
    sequenceNo: number;
    colourToken: string;
    isTarget: boolean;
    ownerRole: string | null;
  }>;
  scenarios: {
    available: Array<{
      scenarioId: string;
      scenarioName: string;
      status: string;
      basePlanWeek: string;
      deltaUnits: number;
      deltaValueEur: number;
      updatedAt: string | null;
      createdAt: string;
    }>;
    overlays: Array<{
      scenarioId: string;
      scenarioName: string;
      status: string;
      total: number;
      delta: number;
      deltaPct: number | null;
    }>;
  };
  accuracy: Array<{
    streamId: string;
    streamLabel: string;
    isTarget: boolean;
    rowsScored: number;
    wape: number | null;
    baselineWape: number | null;
    bias: number | null;
    beatBaselinePct: number | null;
  }>;
  reasons: Array<{
    REASON_CODE: string;
    REASON_LABEL: string;
    REASON_GROUP: string;
    REQUIRES_NOTE: boolean;
  }>;
  notes: {
    derivedComponents: string[];
  };
};

type PreviewData = {
  streamId: string;
  node: {
    level: HierarchyLevel;
    label: string;
    key: string;
    currentUnits: number;
    targetUnits: number;
    weekFrom: string;
    weekTo: string;
  };
  method: "statistical" | "current_plan";
  target: {
    mode: "absolute" | "percentage";
    value: number;
  };
  children: Array<{
    childId: string;
    childLabel: string;
    childLevel: HierarchyLevel | "WEEK_ID";
    nodeKey: string;
    currentUnits: number;
    proposedUnits: number;
    deltaUnits: number;
    deltaValueEur: number;
    shareOfChange: number | null;
    movedLeafCount: number;
    excluded: boolean;
    clamped: boolean;
  }>;
  outcome: {
    feasible: boolean;
    shortfall: number;
    targetDelta: number;
    appliedDelta: number;
    movedCount: number;
    excludedCount: number;
    clampedCount: number;
  };
};

/**
 * The node a stream input is written to, or null when there is none.
 *
 * Taken from the server's selection rather than rebuilt from the path here, so
 * the page cannot disagree with the rule the server enforces. A path that skips
 * a level comes back with no key, which makes "send a key the server rejects"
 * unrepresentable rather than merely unlikely.
 */
function writeTarget(selection: PlanData["selection"]) {
  return selection.writable && selection.level && selection.key
    ? { level: selection.level, key: selection.key }
    : null;
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

function formatMetric(value: number | null | undefined, measure: Measure) {
  return measure === "revenue" ? formatEur(value) : formatUnits(value);
}

function formatAxisValue(value: number, measure: Measure) {
  const formatted = formatMetric(value, measure);
  return measure === "revenue"
    ? formatted.replace("€", "").replace("m", "").replace("bn", "")
    : formatted.replace(" pcs", "");
}

function formatPercentFromRatio(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : formatSignedPercent(value);
}

function statusBadgeClass(status: string) {
  if (status === "draft") return "bg-accent-subtle text-accent";
  if (status === "promoted") return "bg-positive-subtle text-positive";
  if (status === "discarded") return "bg-neutral-subtle text-neutral";
  return "bg-neutral-subtle text-neutral";
}

function scenarioStroke(index: number) {
  return `var(--chart-${((index % 3) + 2) as 2 | 3 | 4})`;
}

function laneStroke(token: string) {
  if (token === "accent") return "var(--accent)";
  return `var(--${token})`;
}

function insightForAccuracy(rows: PlanData["accuracy"]) {
  const sales = rows.find((row) => row.streamId === "sales");
  const finance = rows.find((row) => row.streamId === "finance");
  const notes: string[] = [];
  if (sales && sales.wape !== null && sales.baselineWape !== null) {
    const bias = sales.bias !== null && sales.bias < 0 ? "systematically light" : "not systematically light";
    const beat = sales.wape < sales.baselineWape ? "still beats the baseline often enough to add signal" : "is not beating the baseline consistently";
    notes.push(`${sales.streamLabel} is ${bias} and ${beat}.`);
  }
  if (finance && finance.wape !== null && finance.baselineWape !== null) {
    const message = finance.wape > finance.baselineWape
      ? `${finance.streamLabel} underperforms the baseline, which is why it should be read as a target rather than a forecast.`
      : `${finance.streamLabel} is at least as accurate as the baseline, but it remains a target rather than a forecast.`;
    notes.push(message);
  }
  return notes;
}

/**
 * Integrity-sweep state, held at MODULE scope rather than in a ref.
 *
 * APP.V_DATA_INTEGRITY runs ten assertions, one scanning 1.3m driver rows, and
 * costs about 2.9s of a 5s response. It only feeds a warning banner, so paying
 * for it on every filter change, timeline adjustment and units toggle made the
 * whole view feel broken.
 *
 * A useRef will not do the job: React 19 StrictMode remounts the component in
 * development, which re-initialises refs, so both of the doubled effect runs
 * asked for the sweep and every page entry cost ~10s. Module scope survives the
 * remount and the navigation.
 *
 * The trade-off, stated plainly: integrity is fetched once per page session, so
 * a violation introduced by a rebuild mid-session is not picked up until a
 * reload. That is the right trade for a banner whose content only changes when
 * the data is regenerated.
 */
let integrityRequested = false;
let integrityCache: PlanData["integrity"] | null = null;

export default function PlanPage() {
  const [data, setData] = React.useState<PlanData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  const [path, setPath] = React.useState<HierarchyPath>({});
  const [weeksBack, setWeeksBack] = React.useState<number>(26);
  const [weeksForward, setWeeksForward] = React.useState<number>(20);
  const [measure, setMeasure] = React.useState<Measure>("units");
  const [activeLanes, setActiveLanes] = React.useState<string[]>(["event", "promotion", "sales", "marketing", "finance", "planner", "agent"]);
  const [selectedScenarioIds, setSelectedScenarioIds] = React.useState<string[]>([]);

  const [streamId, setStreamId] = React.useState<string>("sales");
  const [weekFrom, setWeekFrom] = React.useState<string>("");
  const [weekTo, setWeekTo] = React.useState<string>("");
  const [targetMode, setTargetMode] = React.useState<"absolute" | "percentage">("absolute");
  const [targetValueText, setTargetValueText] = React.useState<string>("");
  const [disaggMethod, setDisaggMethod] = React.useState<"statistical" | "current_plan">("current_plan");
  const [reasonCode, setReasonCode] = React.useState<string>("");
  const [note, setNote] = React.useState<string>("");
  const [preview, setPreview] = React.useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [commitLoading, setCommitLoading] = React.useState(false);

  const activeStreamIds = React.useMemo(
    () => activeLanes.filter((lane) => ["sales", "marketing", "finance", "planner", "agent"].includes(lane)),
    [activeLanes],
  );

  const previousIntegrity = React.useRef<PlanData["integrity"]>([]);
  // Bumped whenever an input a preview was computed from changes. A preview
  // still in flight then lands stale and is dropped, rather than arming
  // "Confirm commit" for a node or target the planner has since moved off.
  const previewToken = React.useRef(0);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(pathToParams(path))) {
        params.set(key, value);
      }
      params.set("weeksBack", String(weeksBack));
      params.set("weeksForward", String(weeksForward));
      params.set("measure", measure);
      if (activeStreamIds.length > 0) params.set("streams", activeStreamIds.join(","));
      if (selectedScenarioIds.length > 0) params.set("scenarioIds", selectedScenarioIds.join(","));
      // Ask for the expensive integrity sweep only until we have an answer; it
      // costs ~2.9s and does not change between filter selections.
      if (!integrityRequested) {
        integrityRequested = true;
        params.set("includeIntegrity", "1");
      }
      const res = await fetch(`/api/plan-view?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load consensus plan");
      const payload = json as PlanData;
      if (payload.integrity.length > 0) {
        integrityCache = payload.integrity;
        previousIntegrity.current = payload.integrity;
      } else {
        payload.integrity = integrityCache ?? previousIntegrity.current;
      }
      setData(payload);
      setStreamId((current) => payload.streams.some((stream) => stream.streamId === current) ? current : payload.streams[0]?.streamId ?? "sales");
      setReasonCode((current) => current || payload.reasons[0]?.REASON_CODE || "");
      setWeekFrom((current) => current || payload.context.CURRENT_WEEK);
      setWeekTo((current) => current || payload.weekly.filter((row) => row.plan !== null).at(-1)?.weekId || payload.context.HORIZON_END_WEEK);
      setSelectedScenarioIds((current) => {
        // Return the SAME array reference when nothing actually changed.
        //
        // This is load-bearing, not tidiness. `load` depends on
        // selectedScenarioIds, so handing back a fresh array here — which
        // .filter().slice() always does, even for identical contents — changes
        // the reference, recreates the useCallback, retriggers the effect that
        // calls it, and fetches again forever. React only skips a re-render on
        // Object.is equality, so the contents being equal is not enough.
        const next = current
          .filter((id) => payload.scenarios.available.some((s) => s.scenarioId === id))
          .slice(0, 3);
        const unchanged = next.length === current.length
          && next.every((id, i) => id === current[i]);
        return unchanged ? current : next;
      });
    } catch (err) {
      setError((err as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [path, weeksBack, weeksForward, measure, activeStreamIds, selectedScenarioIds]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    previewToken.current += 1;
    setPreview(null);
  }, [streamId, weekFrom, weekTo, targetMode, targetValueText, disaggMethod, path]);

  const reasonNeedsNote = React.useMemo(
    () => data?.reasons.find((reason) => reason.REASON_CODE === reasonCode)?.REQUIRES_NOTE ?? false,
    [data?.reasons, reasonCode],
  );

  const chartData = React.useMemo(() => {
    return (data?.weekly ?? []).map((row) => ({
      ...row,
      hiddenContribution: 0,
    }));
  }, [data?.weekly]);

  const overlayRows = React.useMemo(
    () => data?.scenarios.overlays.filter((scenario) => selectedScenarioIds.includes(scenario.scenarioId)) ?? [],
    [data?.scenarios.overlays, selectedScenarioIds],
  );

  const accuracyInsights = React.useMemo(() => insightForAccuracy(data?.accuracy ?? []), [data?.accuracy]);

  const filteredWeeks = React.useMemo(
    () => data?.weekly.filter((row) => row.plan !== null).map((row) => row.weekId) ?? [],
    [data?.weekly],
  );

  React.useEffect(() => {
    if (!data) return;
    setWeekFrom((current) => filteredWeeks.includes(current) ? current : data.context.CURRENT_WEEK);
    setWeekTo((current) => filteredWeeks.includes(current) ? current : filteredWeeks.at(-1) ?? data.context.HORIZON_END_WEEK);
  }, [data, filteredWeeks]);

  function toggleLane(lane: string) {
    setActiveLanes((current) => current.includes(lane)
      ? current.filter((item) => item !== lane)
      : [...current, lane]);
  }

  function toggleScenario(scenarioId: string) {
    setSelectedScenarioIds((current) => {
      if (current.includes(scenarioId)) return current.filter((id) => id !== scenarioId);
      if (current.length >= 3) return current;
      return [...current, scenarioId];
    });
  }

  async function handlePreview() {
    const node = data ? writeTarget(data.selection) : null;
    if (!node) return;
    const token = previewToken.current;
    setPreviewLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/plan-view${rollupQuery(path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: streamId,
          node,
          weekRange: { from: weekFrom, to: weekTo },
          target: {
            mode: targetMode,
            value: targetMode === "percentage" ? Number(targetValueText) / 100 : Number(targetValueText),
          },
          disaggMethod,
        }),
      });
      const json = await res.json();
      if (token !== previewToken.current) return;
      if (!res.ok) throw new Error(json.error ?? "Failed to preview change");
      setPreview((json.preview ?? json) as PreviewData);
    } catch (err) {
      if (token !== previewToken.current) return;
      setPreview(null);
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCommit() {
    const node = data ? writeTarget(data.selection) : null;
    if (!node || !preview) return;
    setCommitLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/plan-view${rollupQuery(path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: streamId,
          node,
          weekRange: { from: weekFrom, to: weekTo },
          target: {
            mode: targetMode,
            value: targetMode === "percentage" ? Number(targetValueText) / 100 : Number(targetValueText),
          },
          disaggMethod,
          reasonCode,
          note,
          confirm: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to commit input");
      setMessage({
        ok: true,
        text:
          json.commit?.status === "submitted"
            ? `Submitted for the demand planning lead's approval (${json.commit.stagedRows} cells). It joins the consensus once accepted; track it on the Approvals screen.`
            : "Planner reconciliation written for the live cycle.",
      });
      setPreview(null);
      await load();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setCommitLoading(false);
    }
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-negative/40 bg-negative-subtle p-4">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div>
              <p className="font-medium text-negative">Could not load the consensus plan.</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (loading || !data) {
    return <div className="p-6"><PageSkeleton kpis={4} chart rows={8} /></div>;
  }

  const failingChecks = data.integrity.filter((row) => row.VIOLATIONS > 0);
  const writeNode = writeTarget(data.selection);
  // A product with a customer or channel it does not sell in matches no series.
  const scopeIsEmpty = data.weekly.every((row) => row.actual === null && row.plan === null);
  const writeBlocked = writeNode === null
    ? data.selection.blockedReason ?? "Overrides are entered on a node of the hierarchy."
    : filteredWeeks.length === 0
      ? `Nothing in ${pathLabel(path)} has a forward plan in this horizon, so there is nothing to adjust.`
      : null;
  const formDisabled = writeBlocked !== null;
  const canPreview = !formDisabled && weekFrom && weekTo && targetValueText.trim().length > 0 && Number.isFinite(Number(targetValueText));
  const canCommit = Boolean(!formDisabled && preview && preview.outcome.feasible && reasonCode && (!reasonNeedsNote || note.trim().length > 0));
  const scopeDescription = data.selection.isRoot
    ? "Top of the hierarchy"
    : scopeIsEmpty
      ? "No series under this path"
      : writeNode
        ? `${LEVELS[writeNode.level]} node`
        : "Cross-section, not a node";

  const header = (
    <>
      <PageBanner
        eyebrow="Demand planning"
        headline="Consensus plan"
        subtitle={`Actuals are complete to ${data.context.HISTORY_END_WEEK}. The forecast horizon runs from ${data.context.CURRENT_WEEK} to ${data.context.HORIZON_END_WEEK}, and the contribution columns reconcile exactly to the committed demand plan.`}
        icon={<LineChart size={18} aria-hidden="true" />}
      />

      {message && (
        <Card className={cn("p-3", message.ok ? "bg-positive-subtle" : "bg-negative-subtle")}>
          <div className={cn("flex items-start gap-2 text-xs", message.ok ? "text-positive" : "text-negative")}>
            {message.ok ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
            <span>{message.text}</span>
          </div>
        </Card>
      )}

      {failingChecks.length > 0 && (
        <Card className="p-3">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={15} className="mt-0.5 text-warning" aria-hidden="true" />
            <div>
              <span className="font-medium text-warning">Data integrity warning.</span>{" "}
              <span className="text-text-tertiary">
                {failingChecks.map((row) => `${row.CHECK_NAME} (${row.VIOLATIONS})`).join(", ")}. These checks run across the whole portfolio, not the selected scope. Review before treating this view as decision-grade.
              </span>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.35fr_0.95fr]">
        <Card className="p-4">
          <p className="text-xs text-text-tertiary">Portfolio scope</p>
          <HierarchyFilter
            path={path}
            options={data.options.hierarchy}
            onChange={setPath}
            className="mt-1"
          />

          <div className="mt-4 grid gap-3 md:grid-cols-[auto_auto_1fr] md:items-end">
            <label className="text-xs">
              <span className="text-text-tertiary">History weeks</span>
              <Select value={String(weeksBack)} onValueChange={(value) => setWeeksBack(Number(value))}>
                <SelectTrigger className="mt-1 min-w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HISTORY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={String(option)}>{option} weeks</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="text-xs">
              <span className="text-text-tertiary">Forecast weeks</span>
              <Select value={String(weeksForward)} onValueChange={(value) => setWeeksForward(Number(value))}>
                <SelectTrigger className="mt-1 min-w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORECAST_OPTIONS.map((option) => (
                    <SelectItem key={option} value={String(option)}>{option} weeks</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              <Button type="button" variant={measure === "units" ? "default" : "outline"} size="sm" onClick={() => setMeasure("units")}>Units</Button>
              <Button type="button" variant={measure === "revenue" ? "default" : "outline"} size="sm" onClick={() => setMeasure("revenue")}>Revenue</Button>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div>
            <h2 className="card-title">Current scope</h2>
            <p className="text-xs text-text-tertiary">
              Submissions land at the selected node and are disaggregated to the series-week leaf before they are stored.
            </p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
              <p className="text-xs text-text-tertiary">Scope</p>
              <p className="mt-1 text-sm font-medium">{pathLabel(path)}</p>
              <p className="mt-1 text-xs text-text-tertiary">{scopeDescription}</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
              <p className="text-xs text-text-tertiary">Committed horizon total</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{formatMetric(data.kpis.planTotal, measure)}</p>
              <div className="mt-1 inline-flex items-center gap-1 text-xs">
                <Direction value={data.kpis.vsLastYearPct} />
                <span>{formatPercentFromRatio(data.kpis.vsLastYearPct)}</span>
                <span className="text-text-tertiary">vs same weeks last year</span>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </>
  );

  if (scopeIsEmpty) {
    return (
      <div className="space-y-5 p-5 lg:p-6">
        {header}
        <Card className="p-6">
          <h2 className="card-title">Nothing matches {pathLabel(path)}</h2>
          <p className="mt-1 text-xs text-text-tertiary">
            No series carries this combination of levels, so there are no actuals, no plan and nothing to adjust. A product chosen with a customer or channel it does not sell in lands here; change one of the levels above.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-5 lg:p-6">
      {header}

      <KpiRow>
        <Kpi
          label="Plan total"
          value={formatMetric(data.kpis.planTotal, measure)}
          detail={`Forward horizon in ${measure === "units" ? "pieces" : "net sales value"}`}
        />
        <Kpi
          label="Same weeks last year"
          value={formatMetric(data.kpis.lastYearTotal, measure)}
          detail="Used as the external comparison point"
        />
        <Kpi
          label="Versus last year"
          value={formatMetric(data.kpis.vsLastYear, measure)}
          detail={
            <>
              <Direction value={data.kpis.vsLastYearPct} />
              <span>{formatPercentFromRatio(data.kpis.vsLastYearPct)}</span>
            </>
          }
        />
        <Kpi
          label="Submission basis"
          value={formatWeek(data.context.HISTORY_END_WEEK)}
          detail="Live cycle anchored on actuals complete to this week"
        />
      </KpiRow>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="card-title">Actuals, plan and contribution spine</h2>
            <p className="text-xs text-text-tertiary">
              The lines show history and the final demand plan. The stacked columns show how the forecast is reconstructed; dimming a lane keeps the arithmetic intact so the bars still reconcile to the plan line.
            </p>
          </div>
          <div className="text-right text-xs text-text-tertiary">
            <p>Actuals to {formatWeek(data.todayWeek)}</p>
            <p>Forecast from {formatWeek(data.context.CURRENT_WEEK)}</p>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {[
            ...data.kpis.components.filter((component) => ["event", "promotion"].includes(component.key)),
            ...data.streams,
            { streamId: "agent", streamLabel: "Agent", description: "Accepted agent proposals already committed.", colourToken: "chart-6", isTarget: false, ownerRole: null, sequenceNo: 999 },
          ].map((item) => {
            const key = "streamId" in item ? item.streamId : item.key;
            const label = "streamLabel" in item ? item.streamLabel : item.label;
            const isTarget = "isTarget" in item ? item.isTarget : false;
            const isDerived = key === "event" || key === "promotion";
            const active = activeLanes.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleLane(key)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "border-border bg-card text-foreground" : "border-border bg-muted/40 text-text-tertiary",
                )}
                aria-pressed={active}
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-2.5 rounded-[2px] border border-border"
                  style={{ backgroundColor: laneStroke(item.colourToken) }}
                />
                <span>{label}</span>
                {isTarget && <Badge className="bg-warning-subtle text-warning">target</Badge>}
                {isDerived && <Badge className="bg-neutral-subtle text-neutral">derived</Badge>}
              </button>
            );
          })}
        </div>

        <div style={{ height: CHART_HEIGHT }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
              <XAxis
                dataKey="weekId"
                tickFormatter={formatWeekShort}
                tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                interval={2}
                stroke="var(--chart-grid)"
              />
              <YAxis
                tickFormatter={(value) => formatAxisValue(value, measure)}
                tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                stroke="var(--chart-grid)"
                width={52}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelFormatter={(value) => formatWeek(String(value))}
                formatter={(value, name) => {
                  if (value === null || value === undefined) return ["—", name];
                  return [formatMetric(Number(value), measure), name];
                }}
              />
              <ReferenceLine
                x={data.todayWeek}
                stroke="var(--chart-grid)"
                strokeDasharray="3 3"
                label={{ value: "today", position: "insideTopRight", fontSize: 10, fill: "var(--text-tertiary)" }}
              />
              <Line dataKey="actual" name="Actual pull" stroke="var(--chart-1)" strokeWidth={1.9} dot={false} isAnimationActive={false} connectNulls={false} />
              <Line dataKey="plan" name="Demand plan" stroke="var(--accent)" strokeWidth={2.1} dot={false} isAnimationActive={false} connectNulls={false} />
              {[
                { key: "baseline", name: "Baseline", token: "chart-1" },
                { key: "event", name: "Event (derived)", token: "chart-3" },
                { key: "promotion", name: "Promotion (derived)", token: "chart-5" },
                { key: "sales", name: "Key accounts", token: "chart-2" },
                { key: "marketing", name: "Programme management", token: "chart-6" },
                { key: "finance", name: "Finance target", token: "chart-4" },
                { key: "planner", name: "Demand planner", token: "accent" },
                { key: "agent", name: "Agent", token: "chart-6" },
              ].map((series) => {
                const active = series.key === "baseline" || activeLanes.includes(series.key);
                return (
                  <Bar
                    key={series.key}
                    dataKey={series.key}
                    name={series.name}
                    stackId="plan"
                    fill={laneStroke(series.token)}
                    opacity={active ? 0.9 : 0.2}
                    isAnimationActive={false}
                  />
                );
              })}
              {selectedScenarioIds.map((scenarioId, index) => {
                const scenario = data.scenarios.available.find((item) => item.scenarioId === scenarioId);
                return (
                  <Line
                    key={scenarioId}
                    dataKey={`scenarios.${scenarioId}`}
                    name={scenario?.scenarioName ?? scenarioId}
                    stroke={scenarioStroke(index)}
                    strokeDasharray={SCENARIO_DASHES[index % SCENARIO_DASHES.length]}
                    strokeWidth={1.6}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                );
              })}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_1fr]">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium">Contribution lanes</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {data.kpis.components.map((component) => (
                <div key={component.key} className="rounded-md border border-border bg-card px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{component.label}</span>
                    {component.isTarget && <Badge className="bg-warning-subtle text-warning">target</Badge>}
                    {data.notes.derivedComponents.includes(component.key) && <Badge className="bg-neutral-subtle text-neutral">derived</Badge>}
                  </div>
                  <p className="mt-1 tabular-nums">{formatMetric(component.value, measure)}</p>
                  <p className="mt-1 text-text-tertiary">{component.pctOfBaseline === null ? "—" : `${formatSignedPercent(component.pctOfBaseline)} of baseline`}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium">Scenario overlay</p>
            <p className="mt-1 text-xs text-text-tertiary">Select up to three scenarios. The committed plan stays solid; scenarios are dashed for contrast.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {data.scenarios.available.map((scenario, index) => {
                const selected = selectedScenarioIds.includes(scenario.scenarioId);
                const disable = !selected && selectedScenarioIds.length >= 3;
                return (
                  <button
                    key={scenario.scenarioId}
                    type="button"
                    onClick={() => toggleScenario(scenario.scenarioId)}
                    disabled={disable}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40",
                      selected ? "border-border bg-card text-foreground" : "border-border bg-muted/40 text-text-tertiary",
                    )}
                    aria-pressed={selected}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-[2px] w-4"
                      style={{ backgroundColor: scenarioStroke(index), borderTop: selected ? undefined : undefined }}
                    />
                    <span>{scenario.scenarioName}</span>
                    <Badge className={statusBadgeClass(scenario.status)}>{scenario.status}</Badge>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 space-y-2">
              {overlayRows.length === 0 ? (
                <p className="text-xs text-text-tertiary">No scenario selected.</p>
              ) : overlayRows.map((row) => (
                <div key={row.scenarioId} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-xs">
                  <div>
                    <p className="font-medium">{row.scenarioName}</p>
                    <p className="text-text-tertiary">{row.status}</p>
                  </div>
                  <div className="text-right">
                    <p className="tabular-nums">{formatMetric(row.total, measure)}</p>
                    <p className="inline-flex items-center gap-1 text-text-tertiary">
                      <Direction value={row.deltaPct} />
                      <span>{formatMetric(row.delta, measure)} · {formatPercentFromRatio(row.deltaPct)}</span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <div>
              <h2 className="card-title">Consensus accuracy</h2>
              <p className="text-xs text-text-tertiary">
                Closed cycles only. WAPE and bias are volume-weighted, so large series matter in proportion to their trading value.
              </p>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="text-xs text-text-tertiary">
                <TableHead>Stream</TableHead>
                <TableHead className="num">Rows</TableHead>
                <TableHead className="num">WAPE</TableHead>
                <TableHead className="num">Baseline</TableHead>
                <TableHead className="num">Bias</TableHead>
                <TableHead className="num">Beat baseline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.accuracy.map((row) => (
                <TableRow key={row.streamId}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{row.streamLabel}</span>
                      {row.isTarget && <Badge className="bg-warning-subtle text-warning">target</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="num tabular-nums">{row.rowsScored.toLocaleString("en-GB")}</TableCell>
                  <TableCell className="num tabular-nums">{row.wape === null ? "—" : formatSignedPercent(row.wape, 1).replace("+", "")}</TableCell>
                  <TableCell className="num tabular-nums text-text-tertiary">{row.baselineWape === null ? "—" : formatSignedPercent(row.baselineWape, 1).replace("+", "")}</TableCell>
                  <TableCell className="num tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Direction value={row.bias} />
                      {formatPercentFromRatio(row.bias)}
                    </span>
                  </TableCell>
                  <TableCell className="num tabular-nums">{row.beatBaselinePct === null ? "—" : formatSignedPercent(row.beatBaselinePct, 1).replace("+", "")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-xs">
            {accuracyInsights.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <div>
            <h2 className="card-title">Submit a stream input</h2>
            <p className="text-xs text-text-tertiary">
              Inputs are stored in pieces. This is the live cycle write surface, so nothing commits without a preview and an explicit confirmation.
            </p>
          </div>

          {writeBlocked ? (
            <div role="status" className="mt-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2 text-xs">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
              <p>
                <span className="font-medium text-warning">Input is off for {pathLabel(path)}.</span>{" "}
                <span className="text-text-tertiary">{writeBlocked}</span>
              </p>
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-text-tertiary">
              Selected node <span className="font-medium text-foreground">{pathLabel(path)}</span>
              {" · "}
              {scopeDescription}
            </div>
          )}

          <div className="mt-4 space-y-3">
            <label className="block text-xs">
              <span className="text-text-tertiary">Stream</span>
              <Select value={streamId} onValueChange={(value) => setStreamId(value ?? "sales") } disabled={formDisabled}>
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.streams.map((stream) => (
                    <SelectItem key={stream.streamId} value={stream.streamId}>
                      {stream.streamLabel}{stream.isTarget ? " · target" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="button" variant={targetMode === "absolute" ? "default" : "outline"} size="sm" onClick={() => setTargetMode("absolute")} disabled={formDisabled}>Absolute units</Button>
              <Button type="button" variant={targetMode === "percentage" ? "default" : "outline"} size="sm" onClick={() => setTargetMode("percentage")} disabled={formDisabled}>Percentage change</Button>
            </div>

            <label className="block text-xs">
              <span className="text-text-tertiary">{targetMode === "absolute" ? "Target units" : "Percentage change"}</span>
              <Input type="number" value={targetValueText} onChange={(event) => setTargetValueText(event.target.value)} className="mt-1 tabular-nums" step={targetMode === "absolute" ? "1" : "0.1"} disabled={formDisabled} />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs">
                <span className="text-text-tertiary">Week from</span>
                <Select value={weekFrom} onValueChange={(value) => setWeekFrom(value ?? data.context.CURRENT_WEEK)} disabled={formDisabled}>
                  <SelectTrigger className="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredWeeks.map((week) => (
                      <SelectItem key={week} value={week}>{formatWeek(week)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="block text-xs">
                <span className="text-text-tertiary">Week to</span>
                <Select value={weekTo} onValueChange={(value) => setWeekTo(value ?? data.context.HORIZON_END_WEEK)} disabled={formDisabled}>
                  <SelectTrigger className="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredWeeks.map((week) => (
                      <SelectItem key={week} value={week}>{formatWeek(week)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>

            <label className="block text-xs">
              <span className="text-text-tertiary">Disaggregation</span>
              <Select value={disaggMethod} onValueChange={(value) => setDisaggMethod((value as "statistical" | "current_plan") ?? "current_plan") } disabled={formDisabled}>
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current_plan">Current plan share</SelectItem>
                  <SelectItem value="statistical">Statistical share</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="block text-xs">
              <span className="text-text-tertiary">Reason</span>
              <Select value={reasonCode} onValueChange={(value) => setReasonCode(value ?? "") } disabled={formDisabled}>
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.reasons.map((reason) => (
                    <SelectItem key={reason.REASON_CODE} value={reason.REASON_CODE}>
                      {reason.REASON_GROUP} · {reason.REASON_LABEL}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="block text-xs">
              <span className="text-text-tertiary">Note {reasonNeedsNote ? <span className="text-warning">(required)</span> : null}</span>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} className="mt-1 min-h-20" placeholder="Why should this stream diverge from the current baseline?" disabled={formDisabled} />
            </label>

            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={handlePreview} disabled={!canPreview || previewLoading}>
                {previewLoading ? "Previewing" : "Preview submission"}
              </Button>
            </div>
          </div>

          {preview && (
            <div className="mt-4 space-y-3">
              <div className={cn("rounded-lg border px-3 py-3", preview.outcome.feasible ? "border-border bg-muted/30" : "border-warning/40 bg-warning-subtle")}>
                <div className="flex flex-wrap items-start justify-between gap-3 text-xs">
                  <div>
                    <p className="font-medium text-foreground">Target {formatUnits(preview.node.targetUnits)}</p>
                    <p className="mt-1 text-text-tertiary">
                      Current {formatUnits(preview.node.currentUnits)} · delta {formatUnits(preview.outcome.targetDelta)}
                    </p>
                  </div>
                  <div className="text-right text-text-tertiary">
                    <p>{preview.outcome.movedCount.toLocaleString("en-GB")} children move</p>
                    <p>{preview.outcome.excludedCount.toLocaleString("en-GB")} excluded · {preview.outcome.clampedCount.toLocaleString("en-GB")} clamped</p>
                  </div>
                </div>
                {!preview.outcome.feasible && (
                  <div className="mt-2 inline-flex items-center gap-2 rounded-md bg-warning-subtle px-2 py-1 text-warning">
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>Infeasible preview. Shortfall {formatUnits(preview.outcome.shortfall)} remains after zero floors.</span>
                  </div>
                )}
              </div>

              <Table>
                <TableHeader>
                  <TableRow className="text-xs text-text-tertiary">
                    <TableHead>Child</TableHead>
                    <TableHead className="num">Current</TableHead>
                    <TableHead className="num">Proposed</TableHead>
                    <TableHead className="num">Delta</TableHead>
                    <TableHead className="num">Value delta</TableHead>
                    <TableHead className="num">Share</TableHead>
                    <TableHead>Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.children.map((child) => (
                    <TableRow key={child.childId}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{child.childLabel}</p>
                          <p className="text-xs text-text-tertiary">{child.movedLeafCount.toLocaleString("en-GB")} leaves move</p>
                        </div>
                      </TableCell>
                      <TableCell className="num tabular-nums">{formatUnits(child.currentUnits)}</TableCell>
                      <TableCell className="num tabular-nums">{formatUnits(child.proposedUnits)}</TableCell>
                      <TableCell className="num tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          <Direction value={child.deltaUnits} />
                          {formatUnits(child.deltaUnits)}
                        </span>
                      </TableCell>
                      <TableCell className="num tabular-nums">{formatEur(child.deltaValueEur)}</TableCell>
                      <TableCell className="num tabular-nums">{child.shareOfChange === null ? "—" : formatSignedPercent(child.shareOfChange, 0)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {child.excluded && <Badge className="bg-neutral-subtle text-neutral">0 share</Badge>}
                          {child.clamped && <Badge className="bg-warning-subtle text-warning">floor at zero</Badge>}
                          {!child.excluded && !child.clamped && <Badge className="bg-positive-subtle text-positive">moves</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-text-tertiary">
                  Sales, marketing and finance inputs go to the demand planning lead for approval; the planner
                  reconciliation is the lead&apos;s own and is written directly. The server recomputes the split on submit.
                </div>
                <Button type="button" size="sm" onClick={handleCommit} disabled={!canCommit || commitLoading}>
                  {commitLoading ? "Submitting" : "Confirm and submit"}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <StreamGridPanel
        key={`${streamId}|${JSON.stringify(path)}`}
        path={Object.fromEntries(Object.entries(path).filter(([, value]) => Boolean(value))) as Record<string, string>}
        stream={(() => {
          const selected = data.streams.find((stream) => stream.streamId === streamId);
          return selected ? { id: selected.streamId, label: selected.streamLabel } : null;
        })()}
        canWrite={writeBlocked === null}
        writeBlockedReason={writeBlocked}
        reasons={data.reasons}
        onSubmitted={(text) => {
          setMessage({ ok: true, text });
          void load();
        }}
      />

      <Card className="p-4">
        <div className="flex items-start gap-2 text-sm">
          <AlertTriangle size={15} className="mt-0.5 text-neutral" aria-hidden="true" />
          <div>
            <p className="font-medium">Derived contribution note</p>
            <p className="mt-1 text-text-tertiary">
              Event and promotion components are reconstructed from the calendar and committed promotions. They are derived terms, not directly measured observations.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

const LEVELS = {
  CATEGORY_NAME: "Category",
  PRODUCT_NAME: "Product",
  CUSTOMER_NAME: "Customer",
  CHANNEL_NAME: "Channel",
  SERIES_ID: "Series",
} as const;