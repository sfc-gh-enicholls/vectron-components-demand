"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Info,
  Minus,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { PageBanner } from "@/components/page-banner";
import { CortexChip } from "@/components/snowflake";
import { PageSkeleton } from "@/components/page-skeleton";
import { AgentWeekChart } from "@/components/agent-week-chart";
import { Card } from "@/components/ui/card";
import { Kpi } from "@/components/kpi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  HierarchyFilter,
  pathLabel,
  pathToParams,
  type HierarchyOptions,
  type HierarchyPath,
} from "@/components/hierarchy-filter";
import {
  SEVERITY_CLASSES,
  formatUnits,
  formatEur,
  formatWeek,
} from "@/lib/format";
import { cn } from "@/lib/utils";

interface AgentWeek {
  weekId: string;
  currentUnits: number;
  proposedUnits: number;
  deltaUnits: number;
}

interface AgentProposal {
  proposalId: string;
  runId: string;
  asOfWeek: string;
  proposalType: string;
  status: string;
  seriesId: string | null;
  nodeLevel: string | null;
  nodeKey: string | null;
  weekFrom: string;
  weekTo: string;
  currentUnits: number;
  proposedUnits: number;
  deltaUnits: number;
  deltaValueEur: number;
  confidence: number;
  reasonCode: string | null;
  reasonLabel: string | null;
  triggerSummary: string;
  diagnosis: Record<string, unknown> | null;
  evidence: string[];
  rationale: string | null;
  rationaleSource: string;
  createdAt: string;
  runType: string;
  narrativeMode: string;
  modelName: string | null;
  seriesLabel: string | null;
  productName: string | null;
  customerName: string | null;
  channelName: string | null;
  categoryName: string | null;
  segmentAbc: string | null;
  segmentXyz: string | null;
  baseAnnualValueEur: number | null;
  priority: string;
  priorityRank: number;
  signalSummary: {
    signals: number;
    agreeCount: number;
    disagreeCount: number;
    neutralCount: number;
    simulatedSignals: number;
    netSupport: number;
    isContested: boolean;
    dissentingSources: string[];
  };
  signals: AgentSignal[];
  weeks: AgentWeek[];
}

interface AgentSignal {
  sourceId: string;
  stance: "agrees" | "disagrees" | "neutral";
  signalText: string;
  strength: number;
  sourceName: string;
  ownerDomain: string;
  description: string | null;
  isSimulated: boolean;
}

interface AgentScenario {
  scenarioId: string;
  name: string;
  description: string | null;
  basePlanWeek: string;
  editCount: number;
  agentEdits: number;
  updatedAt: string | null;
  createdAt: string;
}

interface AgentPageData {
  context: {
    HISTORY_END_WEEK: string;
    CURRENT_WEEK: string;
    HORIZON_END_WEEK: string;
    PRODUCTION_MODEL: string;
    BENCHMARK_MODEL: string;
  };
  latestRun: {
    runId: string;
    asOfWeek: string;
    runType: string;
    startedAt: string;
    completedAt: string | null;
    status: string;
    proposalCount: number;
    narrativeMode: string;
    modelName: string | null;
    cortexCalls: number;
    cortexFallbacks: number;
  } | null;
  summary: {
    openProposals: number;
    totalValueEur: number;
    contestedProposals: number;
  };
  filters: {
    proposalTypes: string[];
    priorities: string[];
    applied: {
      proposalType: string | null;
      priority: string | null;
      path: HierarchyPath;
      minConfidence: number | null;
      contestedOnly: boolean;
      sort: "priority" | "contested";
    };
  };
  options: {
    hierarchy: HierarchyOptions;
  };
  signalReconciliation: {
    headline: string;
    simulationNote: string;
  };
  draftScenarios: AgentScenario[];
  proposals: AgentProposal[];
}

type DecisionType = "accept" | "edit_accept" | "reject" | "defer";

interface DecisionState {
  proposal: AgentProposal;
  type: DecisionType;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function proposalTypeLabel(value: string) {
  return value.replace(/_/g, " ");
}

function selectValue(value: string | null, fallback = "") {
  return value ?? fallback;
}

function proposalActionLabel(proposal: AgentProposal) {
  switch (proposal.proposalType) {
    case "event_phasing":
      return "Re-phase weekly timing";
    case "override_decay":
      return "Remove manual override";
    case "npd_ramp":
      return "Rescale launch ramp";
    default:
      return proposalTypeLabel(proposal.proposalType);
  }
}

function confidenceBand(confidence: number) {
  if (confidence >= 0.7) return { label: "Higher", className: "bg-positive-subtle text-positive" };
  if (confidence >= 0.5) return { label: "Mid", className: "bg-warning-subtle text-warning" };
  return { label: "Lower", className: "bg-neutral-subtle text-neutral" };
}

function confidenceExplanation(proposal: AgentProposal) {
  const band = confidenceBand(proposal.confidence).label.toLowerCase();
  return `${(proposal.confidence * 100).toFixed(0)}% confidence, in the ${band} band. This score is computed from the documented formula in the engine and is never model-generated.`;
}

function stanceMeta(stance: AgentSignal["stance"]) {
  switch (stance) {
    case "agrees":
      return {
        label: "Agrees",
        icon: Check,
        className: "bg-positive-subtle text-positive",
      };
    case "disagrees":
      return {
        label: "Disagrees",
        icon: AlertTriangle,
        className: "bg-negative-subtle text-negative",
      };
    default:
      return {
        label: "Neutral",
        icon: Minus,
        className: "bg-neutral-subtle text-neutral",
      };
  }
}

function formatNetSupport(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function diagnosisLabel(key: string) {
  return key
    .replace(/_/g, " ")
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/Pct\b/g, "%")
    .replace(/Id\b/g, "ID");
}

function formatDiagnosisValue(key: string, value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    const lower = key.toLowerCase();
    if (lower.includes("week")) return String(value);
    if (lower.includes("confidence") || lower.includes("ratio") || lower.includes("agreement") || lower.includes("factor") || lower.includes("similarity")) {
      return value.toFixed(3).replace(/\.000$/, "");
    }
    if (lower.includes("pct") || lower.includes("bias") || lower.includes("uplift") || lower.includes("move")) {
      return `${value.toFixed(2)}%`;
    }
    if (lower.includes("error") || lower.includes("units") || lower.includes("total")) {
      return formatUnits(value);
    }
    return value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function Direction({ value }: { value: number }) {
  if (Math.abs(value) < 0.001) {
    return <Minus size={13} className="text-neutral" aria-hidden="true" />;
  }
  return value > 0 ? (
    <TrendingUp size={13} className="text-positive" aria-hidden="true" />
  ) : (
    <TrendingDown size={13} className="text-negative" aria-hidden="true" />
  );
}

function NetSupportMeter({ value }: { value: number }) {
  const clamped = Math.max(-2, Math.min(2, value));
  const magnitude = `${Math.abs((clamped / 2) * 100)}%`;
  const positive = clamped > 0;
  const negative = clamped < 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-text-tertiary">
        <span>Net support</span>
        <span className="font-medium text-foreground tabular-nums">{formatNetSupport(value)}</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-1/2 w-px bg-border" aria-hidden="true" />
        {positive && <div className="absolute inset-y-0 left-1/2 bg-positive" style={{ width: magnitude }} aria-hidden="true" />}
        {negative && <div className="absolute inset-y-0 right-1/2 bg-negative" style={{ width: magnitude }} aria-hidden="true" />}
      </div>
    </div>
  );
}

function SignalSummaryInline({ proposal }: { proposal: AgentProposal }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
      <span>
        {proposal.signalSummary.agreeCount} agree · {proposal.signalSummary.disagreeCount} disagree · {proposal.signalSummary.neutralCount} neutral
      </span>
      <span>{proposal.signalSummary.signals} total signals</span>
      <span>{proposal.signalSummary.simulatedSignals} simulated</span>
    </div>
  );
}

function ProposalSummary({ proposal }: { proposal: AgentProposal }) {
  const band = confidenceBand(proposal.confidence);
  return (
    <div className="grid gap-2 lg:grid-cols-[minmax(0,2.3fr)_minmax(280px,1fr)] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{proposalActionLabel(proposal)}</span>
          <Badge className={cn("border-0", SEVERITY_CLASSES[proposal.priority] ?? "bg-neutral-subtle text-neutral")}>{proposal.priority}</Badge>
          <Badge variant="outline">{proposalTypeLabel(proposal.proposalType)}</Badge>
          <Badge className={cn("border-0", band.className)}>{band.label} confidence</Badge>
          {proposal.signalSummary.isContested && (
            <Badge className="border-0 bg-warning-subtle text-warning">
              <AlertTriangle aria-hidden="true" />
              Contested: {proposal.signalSummary.dissentingSources.join(", ")}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-text-tertiary">
          {proposal.productName ?? proposal.seriesLabel ?? proposal.seriesId ?? "Unknown series"}
          {proposal.customerName ? ` · ${proposal.customerName}` : ""}
          {proposal.channelName ? ` · ${proposal.channelName}` : ""}
        </p>
        <p className="mt-1 text-xs text-text-tertiary">
          {formatWeek(proposal.weekFrom)}
          {proposal.weekFrom !== proposal.weekTo ? ` to ${formatWeek(proposal.weekTo)}` : ""}
          {proposal.nodeKey ? ` · ${proposal.nodeKey}` : ""}
        </p>
        <div className="mt-2">
          <SignalSummaryInline proposal={proposal} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
        <div>
          <p className="text-text-tertiary">Delta</p>
          <p className="mt-1 inline-flex items-center gap-1 font-medium tabular-nums">
            <Direction value={proposal.deltaUnits} />
            {proposal.deltaUnits >= 0 ? "+" : ""}{formatUnits(proposal.deltaUnits)}
          </p>
        </div>
        <div>
          <p className="text-text-tertiary">Value at stake</p>
          <p className="mt-1 font-medium tabular-nums">{formatEur(Math.abs(proposal.deltaValueEur))}</p>
        </div>
        <div>
          <p className="text-text-tertiary">Current</p>
          <p className="mt-1 font-medium tabular-nums">{formatUnits(proposal.currentUnits)}</p>
        </div>
        <div>
          <p className="text-text-tertiary">Proposed</p>
          <p className="mt-1 font-medium tabular-nums">{formatUnits(proposal.proposedUnits)}</p>
        </div>
        <div className="col-span-2 sm:col-span-4 lg:col-span-2 xl:col-span-4">
          <NetSupportMeter value={proposal.signalSummary.netSupport} />
        </div>
      </div>
    </div>
  );
}

// useSearchParams needs a Suspense boundary for the static export to prerender.
export default function AgentPage() {
  return (
    <React.Suspense fallback={null}>
      <AgentPageContent />
    </React.Suspense>
  );
}

function AgentPageContent() {
  const searchParams = useSearchParams();
  const linkedProposalId = searchParams.get("proposalId");
  const [data, setData] = React.useState<AgentPageData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = React.useState<Record<string, boolean>>({});
  const [proposalType, setProposalType] = React.useState<string>("all");
  const [priority, setPriority] = React.useState<string>("all");
  const [path, setPath] = React.useState<HierarchyPath>({});
  const [minConfidence, setMinConfidence] = React.useState<string>("");
  const [contestedOnly, setContestedOnly] = React.useState(false);
  const [sort, setSort] = React.useState<"priority" | "contested">("priority");
  const [scenarioId, setScenarioId] = React.useState<string>("");
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [decisionState, setDecisionState] = React.useState<DecisionState | null>(null);
  const [decisionWeeks, setDecisionWeeks] = React.useState<Record<string, string>>({});
  const [decisionNote, setDecisionNote] = React.useState("");
  const [decisionBusy, setDecisionBusy] = React.useState(false);
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (proposalType !== "all") qs.set("proposalType", proposalType);
      if (priority !== "all") qs.set("priority", priority);
      for (const [key, value] of Object.entries(pathToParams(path))) {
        qs.set(key, value);
      }
      if (minConfidence.trim()) qs.set("minConfidence", minConfidence.trim());
      if (contestedOnly) qs.set("contestedOnly", "true");
      qs.set("sort", sort);
      const response = await fetch(`/api/agent?${qs.toString()}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to load agent inbox");
      const payload = json as AgentPageData;
      setData(payload);
      setScenarioId((current) => current || payload.draftScenarios[0]?.scenarioId || "");
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [proposalType, priority, path, minConfidence, contestedOnly, sort]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!data || !linkedProposalId) return;
    const exists = data.proposals.some((proposal) => proposal.proposalId === linkedProposalId);
    if (!exists) return;
    setExpanded((current) => ({ ...current, [linkedProposalId]: true }));
    const timer = window.setTimeout(() => {
      document.getElementById(`proposal-${linkedProposalId}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [data, linkedProposalId]);

  const visibleProposals = data?.proposals ?? [];
  const grouped = React.useMemo(() => {
    const groups: Record<string, AgentProposal[]> = {};
    for (const proposal of visibleProposals) {
      (groups[proposal.priority] ??= []).push(proposal);
    }
    return groups;
  }, [visibleProposals]);

  const selectedProposalIds = React.useMemo(
    () => visibleProposals.filter((proposal) => selectedIds[proposal.proposalId]).map((proposal) => proposal.proposalId),
    [selectedIds, visibleProposals],
  );

  const selectedScenario = data?.draftScenarios.find((item) => item.scenarioId === scenarioId) ?? null;

  async function refreshWithMessage(nextMessage?: { ok: boolean; text: string } | null) {
    await load();
    setSelectedIds({});
    setDecisionState(null);
    setDecisionWeeks({});
    setDecisionNote("");
    if (nextMessage) setMessage(nextMessage);
  }

  function openDecision(proposal: AgentProposal, type: DecisionType) {
    setDecisionState({ proposal, type });
    setDecisionWeeks(
      Object.fromEntries(proposal.weeks.map((week) => [week.weekId, String(Math.round(week.proposedUnits))])),
    );
    setDecisionNote("");
  }

  async function submitDecision() {
    if (!decisionState) return;
    const { proposal, type } = decisionState;
    if ((type === "accept" || type === "edit_accept") && !scenarioId) {
      setMessage({ ok: false, text: "Select a draft scenario first. The agent can only write into a scenario." });
      return;
    }
    if (type === "reject" && !decisionNote.trim()) {
      setMessage({ ok: false, text: "Rejecting a proposal requires a reason." });
      return;
    }

    setDecisionBusy(true);
    try {
      const response = await fetch("/api/agent/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId: proposal.proposalId,
          decision: type,
          targetScenarioId: type === "accept" || type === "edit_accept" ? scenarioId : undefined,
          editedWeeks:
            type === "edit_accept"
              ? proposal.weeks.map((week) => ({
                  weekId: week.weekId,
                  editUnits: Number(decisionWeeks[week.weekId]),
                }))
              : undefined,
          note: decisionNote.trim() || undefined,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to record decision");

      const outcome =
        type === "accept"
          ? `Accepted into ${selectedScenario?.name ?? "the selected draft scenario"}.`
          : type === "edit_accept"
            ? `Accepted with edits into ${selectedScenario?.name ?? "the selected draft scenario"}.`
            : type === "reject"
              ? "Proposal rejected."
              : "Proposal deferred.";
      await refreshWithMessage({ ok: true, text: outcome });
    } catch (requestError) {
      setMessage({ ok: false, text: (requestError as Error).message });
    } finally {
      setDecisionBusy(false);
    }
  }

  async function submitBulkAccept() {
    if (!data || !scenarioId || !selectedProposalIds.length) return;
    setBulkBusy(true);
    try {
      for (const proposalId of selectedProposalIds) {
        const response = await fetch("/api/agent/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proposalId,
            decision: "accept",
            targetScenarioId: scenarioId,
          }),
        });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? `Failed to accept ${proposalId}`);
      }
      setBulkOpen(false);
      await refreshWithMessage({
        ok: true,
        text: `Accepted ${selectedProposalIds.length} proposals into ${selectedScenario?.name ?? "the selected draft scenario"}.`,
      });
    } catch (requestError) {
      setMessage({ ok: false, text: (requestError as Error).message });
    } finally {
      setBulkBusy(false);
    }
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-negative/40 bg-negative-subtle p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium text-negative">Could not load the agent inbox</p>
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

  const totalSelectedWeeks = visibleProposals
    .filter((proposal) => selectedIds[proposal.proposalId])
    .reduce((sum, proposal) => sum + proposal.weeks.length, 0);
  const totalSelectedValue = visibleProposals
    .filter((proposal) => selectedIds[proposal.proposalId])
    .reduce((sum, proposal) => sum + Math.abs(proposal.deltaValueEur), 0);

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Recommended actions"
        headline="Agent inbox"
        subtitle={`Live proposals for future weeks only. Accepting a proposal writes a draft scenario edit, never the committed plan. Latest live origin: ${data.latestRun?.asOfWeek ?? data.context.HISTORY_END_WEEK}.`}
        icon={<Bot size={18} aria-hidden="true" />}
        metadata={
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span>Scope: <span className="font-medium">{pathLabel(path)}</span></span>
            <span>{data.summary.openProposals.toLocaleString("en-GB")} open proposals</span>
            <span>{formatEur(data.summary.totalValueEur)} at stake</span>
            <span>Model narratives: {data.latestRun?.modelName ?? "—"}</span>
          </div>
        }
      />

      <Card className="bg-accent-subtle p-3">
        <div className="flex items-start gap-2 text-xs">
          <ClipboardCheck size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <p className="text-text-tertiary">
            <span className="font-medium text-accent">The agent proposes only.</span>{" "}
            A human accepts, trims, rejects or defers. Any acceptance lands in a draft scenario so the live plan is never touched directly.
          </p>
        </div>
      </Card>

      <Card className="p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-foreground">Signal reconciliation</p>
                <p className="mt-1 text-sm text-text-tertiary">{data.signalReconciliation.headline}</p>
              </div>
            </div>
            <p className="text-sm text-text-tertiary">
              The proposals worth attention are the contested ones, because that is where planner judgement is actually doing work.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-text-tertiary">
            <p>{data.signalReconciliation.simulationNote}</p>
          </div>
        </div>
      </Card>

      {message && (
        <Card className={cn("p-3", message.ok ? "bg-positive-subtle" : "bg-negative-subtle")}>
          <div className={cn("flex items-start gap-2 text-xs", message.ok ? "text-positive" : "text-negative")}>
            {message.ok ? <Check size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
            <span>{message.text}</span>
          </div>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi
          label="Open proposals"
          value={data.summary.openProposals.toLocaleString("en-GB")}
          detail="Future weeks only, with no outturn yet"
        />
        <Kpi
          label="Value at stake"
          value={formatEur(data.summary.totalValueEur)}
          detail="Absolute volume moved, priced at ex-works value"
        />
        <Kpi
          label="Last live run"
          value={formatWeek(data.latestRun?.asOfWeek ?? data.context.HISTORY_END_WEEK)}
          detail={`Completed ${formatDateTime(data.latestRun?.completedAt ?? data.latestRun?.startedAt ?? null)}`}
        />
        <Kpi
          label="Contested proposals"
          value={data.summary.contestedProposals.toLocaleString("en-GB")}
          detail="Signals disagree, so these need planner judgement"
        />
        <Kpi
          label="Narrative provenance"
          value={data.latestRun?.modelName ?? "—"}
          detail={`Cortex calls ${data.latestRun?.cortexCalls ?? 0} · template fallbacks ${data.latestRun?.cortexFallbacks ?? 0}. Whole live run — not affected by scope.`}
        />
      </div>

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
        <div className="grid gap-3 border-t border-border pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] lg:items-end">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <label className="text-xs">
              <span className="text-text-tertiary">Proposal type</span>
              <Select value={proposalType} onValueChange={(value) => setProposalType(selectValue(value, "all"))}>
                <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {data.filters.proposalTypes.map((item) => (
                    <SelectItem key={item} value={item}>{proposalTypeLabel(item)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="text-xs">
              <span className="text-text-tertiary">Priority</span>
              <Select value={priority} onValueChange={(value) => setPriority(selectValue(value, "all"))}>
                <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  {data.filters.priorities.map((item) => (
                    <SelectItem key={item} value={item}>{item}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="text-xs">
              <span className="text-text-tertiary">Minimum confidence</span>
              <Input
                value={minConfidence}
                onChange={(event) => setMinConfidence(event.target.value)}
                className="mt-1 tabular-nums"
                placeholder="0.50"
                inputMode="decimal"
              />
            </label>
            <label className="text-xs">
              <span className="text-text-tertiary">Sort proposals</span>
              <Select value={sort} onValueChange={(value) => setSort(value === "contested" ? "contested" : "priority")}>
                <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="priority">Priority first</SelectItem>
                  <SelectItem value="contested">Contested first</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-text-tertiary">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border text-accent focus-visible:ring-ring"
                checked={contestedOnly}
                onChange={(event) => setContestedOnly(event.target.checked)}
              />
              <span>Contested proposals only</span>
            </label>
          </div>
          <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
            <p className="font-medium">Acceptance target</p>
            <p className="text-text-tertiary">
              Accepted proposals become draft scenario edits. They never write to the committed plan.
            </p>
            <Select value={scenarioId} onValueChange={(value) => setScenarioId(selectValue(value))}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select draft scenario" /></SelectTrigger>
              <SelectContent>
                {data.draftScenarios.map((scenario) => (
                  <SelectItem key={scenario.scenarioId} value={scenario.scenarioId}>{scenario.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedScenario && (
              <p className="text-text-tertiary">
                Whole scenario: {selectedScenario.editCount.toLocaleString("en-GB")} existing edits · {selectedScenario.agentEdits.toLocaleString("en-GB")} already from the agent
              </p>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 className="card-title">Queue</h2>
            <p className="text-xs text-text-tertiary">
              {sort === "contested"
                ? "Contested proposals are brought to the top. Expand a row to see where sources conflict before you accept, trim, reject or defer."
                : "Ranked by priority first, then by value at stake. Expand a row to see where the signals line up and where they disagree."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-text-tertiary">
              {selectedProposalIds.length.toLocaleString("en-GB")} selected
            </span>
            <Button
              type="button"
              size="sm"
              disabled={!selectedProposalIds.length || !scenarioId}
              onClick={() => setBulkOpen(true)}
            >
              <Check aria-hidden="true" />
              Accept selected
            </Button>
          </div>
        </div>

        <div className="mt-4 space-y-5">
          {visibleProposals.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm font-medium">No live proposals match this filter.</p>
              <p className="mt-1 text-xs text-text-tertiary">
                Scope: {pathLabel(path)}. Try widening the scope or the other filters, or wait for the next live agent run.
              </p>
            </div>
          ) : (
            (sort === "priority"
              ? data.filters.priorities.filter((group) => grouped[group]?.length).map((group) => ({
                  key: group,
                  label: group,
                  proposals: grouped[group],
                  badgeClass: cn("border-0", SEVERITY_CLASSES[group] ?? "bg-neutral-subtle text-neutral"),
                }))
              : [{
                  key: "all",
                  label: contestedOnly ? "Contested queue" : "All proposals",
                  proposals: visibleProposals,
                  badgeClass: "border-0 bg-neutral-subtle text-neutral",
                }]
            ).map((section) => (
                <section key={section.key} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge className={section.badgeClass}>{section.label}</Badge>
                    <span className="text-xs text-text-tertiary">
                      {section.proposals.length.toLocaleString("en-GB")} proposal{section.proposals.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {section.proposals.map((proposal) => {
                      const isExpanded = Boolean(expanded[proposal.proposalId]);
                      const highlighted = linkedProposalId === proposal.proposalId;
                      const diagnosisEntries = Object.entries(proposal.diagnosis ?? {});
                      return (
                        <div
                          key={proposal.proposalId}
                          id={`proposal-${proposal.proposalId}`}
                          className={cn(
                            "rounded-lg border border-border p-3 transition-colors",
                            highlighted && "border-accent bg-accent-subtle/40",
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              className="mt-1 h-4 w-4 rounded border-border text-accent focus-visible:ring-ring"
                              aria-label={`Select proposal ${proposal.proposalId}`}
                              checked={Boolean(selectedIds[proposal.proposalId])}
                              onChange={(event) => setSelectedIds((current) => ({
                                ...current,
                                [proposal.proposalId]: event.target.checked,
                              }))}
                            />
                            <div className="min-w-0 flex-1 space-y-3">
                              <button
                                type="button"
                                className="w-full text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                                aria-expanded={isExpanded}
                                onClick={() => setExpanded((current) => ({
                                  ...current,
                                  [proposal.proposalId]: !current[proposal.proposalId],
                                }))}
                              >
                                <div className="flex items-start gap-2">
                                  {isExpanded ? <ChevronDown size={16} className="mt-0.5 text-text-tertiary" aria-hidden="true" /> : <ChevronRight size={16} className="mt-0.5 text-text-tertiary" aria-hidden="true" />}
                                  <div className="min-w-0 flex-1">
                                    <ProposalSummary proposal={proposal} />
                                  </div>
                                </div>
                              </button>

                              {isExpanded && (
                                <div className="space-y-4 border-t border-border pt-4">
                                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
                                    <div className="space-y-4">
                                      <div>
                                        <div className="mb-1 flex flex-wrap items-center gap-2">
                                          <h3 className="text-sm font-medium">Trigger and rationale</h3>
                                          {proposal.rationaleSource === "cortex" ? (
                                            <CortexChip>Cortex narrative</CortexChip>
                                          ) : (
                                            <Badge className="border-0 bg-neutral-subtle text-neutral">Template narrative</Badge>
                                          )}
                                        </div>
                                        <p className="text-sm text-foreground">{proposal.triggerSummary}</p>
                                        <p className="mt-2 text-sm leading-6 text-text-tertiary">
                                          {proposal.rationale ?? "No narrative was stored for this proposal."}
                                        </p>
                                      </div>

                                      <div>
                                        <div className="mb-1 flex items-center gap-2">
                                          <h3 className="text-sm font-medium">Confidence</h3>
                                          <Info size={13} className="text-text-tertiary" aria-hidden="true" />
                                        </div>
                                        <p className="text-sm text-text-tertiary">{confidenceExplanation(proposal)}</p>
                                      </div>

                                      <div>
                                        <h3 className="mb-2 text-sm font-medium">Diagnosis</h3>
                                        {diagnosisEntries.length === 0 ? (
                                          <p className="text-xs text-text-tertiary">No diagnosis fields were stored for this proposal.</p>
                                        ) : (
                                          <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                                            {diagnosisEntries.map(([key, value]) => (
                                              <div key={key} className="rounded-md border border-border bg-muted/40 px-3 py-2">
                                                <dt className="text-[11px] uppercase text-text-tertiary">
                                                  {diagnosisLabel(key)}
                                                </dt>
                                                <dd className="mt-1 text-sm text-foreground">
                                                  {formatDiagnosisValue(key, value)}
                                                </dd>
                                              </div>
                                            ))}
                                          </dl>
                                        )}
                                      </div>
                                    </div>

                                    <div className="space-y-4">
                                      <div>
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                          <h3 className="text-sm font-medium">Signal reconciliation</h3>
                                          {proposal.signalSummary.isContested ? (
                                            <Badge className="border-0 bg-warning-subtle text-warning">
                                              <AlertTriangle aria-hidden="true" />
                                              Contested by {proposal.signalSummary.dissentingSources.join(", ")}
                                            </Badge>
                                          ) : (
                                            <Badge className="border-0 bg-positive-subtle text-positive">
                                              <Check aria-hidden="true" />
                                              Signals align
                                            </Badge>
                                          )}
                                        </div>
                                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                                          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                                            <p className="text-[11px] uppercase text-text-tertiary">Agree</p>
                                            <p className="mt-1 text-sm font-medium text-foreground">{proposal.signalSummary.agreeCount}</p>
                                          </div>
                                          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                                            <p className="text-[11px] uppercase text-text-tertiary">Disagree</p>
                                            <p className="mt-1 text-sm font-medium text-foreground">{proposal.signalSummary.disagreeCount}</p>
                                          </div>
                                          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                                            <p className="text-[11px] uppercase text-text-tertiary">Neutral</p>
                                            <p className="mt-1 text-sm font-medium text-foreground">{proposal.signalSummary.neutralCount}</p>
                                          </div>
                                          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                                            <NetSupportMeter value={proposal.signalSummary.netSupport} />
                                          </div>
                                        </div>
                                        <div className="mt-3 space-y-2">
                                          {proposal.signals.length === 0 ? (
                                            <p className="text-xs text-text-tertiary">No signals were attached to this proposal.</p>
                                          ) : (
                                            proposal.signals.map((signal) => {
                                              const meta = stanceMeta(signal.stance);
                                              const Icon = meta.icon;
                                              return (
                                                <div key={`${proposal.proposalId}-${signal.sourceId}`} className="rounded-md border border-border bg-muted/40 px-3 py-3">
                                                  <div className="flex flex-wrap items-center gap-2">
                                                    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", meta.className)}>
                                                      <Icon size={12} aria-hidden="true" />
                                                      {meta.label}
                                                    </span>
                                                    <span className="text-sm font-medium text-foreground">{signal.sourceName}</span>
                                                    <Badge variant="outline">{signal.ownerDomain}</Badge>
                                                    {signal.isSimulated && (
                                                      <Badge variant="outline">Simulated</Badge>
                                                    )}
                                                    <span className="text-xs text-text-tertiary">Strength {signal.strength.toFixed(2)}</span>
                                                  </div>
                                                  <p className="mt-2 text-sm text-foreground">{signal.signalText}</p>
                                                  {signal.description && (
                                                    <p className="mt-1 text-xs text-text-tertiary">{signal.description}</p>
                                                  )}
                                                </div>
                                              );
                                            })
                                          )}
                                        </div>
                                      </div>

                                      <div>
                                        <h3 className="mb-2 text-sm font-medium">Evidence</h3>
                                        {proposal.evidence.length === 0 ? (
                                          <p className="text-xs text-text-tertiary">No evidence strings were recorded.</p>
                                        ) : (
                                          <ul className="space-y-2 text-sm text-text-tertiary">
                                            {proposal.evidence.map((item, index) => (
                                              <li key={`${proposal.proposalId}-evidence-${index}`} className="rounded-md border border-border bg-muted/40 px-3 py-2">
                                                {item}
                                              </li>
                                            ))}
                                          </ul>
                                        )}
                                      </div>
                                      <div className="rounded-md border border-border bg-muted/40 px-3 py-3 text-xs text-text-tertiary">
                                        <p className="font-medium text-foreground">What acceptance writes</p>
                                        <p className="mt-1">
                                          {proposal.weeks.length.toLocaleString("en-GB")} series-week rows into the selected draft scenario, with origin set to agent and this proposal linked for audit.
                                        </p>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,1fr)]">
                                    <div>
                                      <h3 className="mb-2 text-sm font-medium">Week-by-week comparison</h3>
                                      <AgentWeekChart weeks={proposal.weeks} />
                                    </div>
                                    <div>
                                      <h3 className="mb-2 text-sm font-medium">Weekly detail</h3>
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                          <thead>
                                            <tr className="border-b border-border text-xs text-text-tertiary">
                                              <th className="py-1.5 text-left font-medium">Week</th>
                                              <th className="num py-1.5 font-medium">Current</th>
                                              <th className="num py-1.5 font-medium">Proposed</th>
                                              <th className="num py-1.5 font-medium">Delta</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {proposal.weeks.map((week) => (
                                              <tr key={week.weekId} className="border-b border-border/50">
                                                <td className="py-1.5 text-text-tertiary">{formatWeek(week.weekId)}</td>
                                                <td className="num py-1.5 tabular-nums">{formatUnits(week.currentUnits)}</td>
                                                <td className="num py-1.5 tabular-nums">{formatUnits(week.proposedUnits)}</td>
                                                <td className="num py-1.5 tabular-nums">
                                                  <span className="inline-flex items-center gap-1">
                                                    <Direction value={week.deltaUnits} />
                                                    {week.deltaUnits >= 0 ? "+" : ""}{formatUnits(week.deltaUnits)}
                                                  </span>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                                    <Button type="button" size="sm" disabled={!scenarioId} onClick={() => openDecision(proposal, "accept")}>
                                      <Check aria-hidden="true" />
                                      Accept
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" disabled={!scenarioId} onClick={() => openDecision(proposal, "edit_accept")}>
                                      <ClipboardCheck aria-hidden="true" />
                                      Accept with edit
                                    </Button>
                                    <Button type="button" size="sm" variant="destructive" onClick={() => openDecision(proposal, "reject")}>
                                      Reject
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" onClick={() => openDecision(proposal, "defer")}>
                                      Defer
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))
          )}
        </div>
      </Card>

      <Dialog open={decisionState !== null} onOpenChange={(open) => { if (!open) setDecisionState(null); }}>
        <DialogContent className="sm:max-w-2xl">
          {decisionState && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {decisionState.type === "accept" && "Accept proposal"}
                  {decisionState.type === "edit_accept" && "Accept with edits"}
                  {decisionState.type === "reject" && "Reject proposal"}
                  {decisionState.type === "defer" && "Defer proposal"}
                </DialogTitle>
                <DialogDescription>
                  {decisionState.type === "accept" || decisionState.type === "edit_accept"
                    ? `This will write draft scenario edits into ${selectedScenario?.name ?? "the selected scenario"}. The committed plan is untouched.`
                    : "This records the human decision against the proposal and updates its queue status."}
                </DialogDescription>
              </DialogHeader>

              {(decisionState.type === "accept" || decisionState.type === "edit_accept") && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm">
                    <ProposalSummary proposal={decisionState.proposal} />
                  </div>
                  {decisionState.type === "edit_accept" ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-xs text-text-tertiary">
                            <th className="py-1.5 text-left font-medium">Week</th>
                            <th className="num py-1.5 font-medium">Current</th>
                            <th className="num py-1.5 font-medium">Suggested</th>
                            <th className="num py-1.5 font-medium">Apply</th>
                          </tr>
                        </thead>
                        <tbody>
                          {decisionState.proposal.weeks.map((week) => (
                            <tr key={week.weekId} className="border-b border-border/50">
                              <td className="py-1.5 text-text-tertiary">{formatWeek(week.weekId)}</td>
                              <td className="num py-1.5 tabular-nums">{formatUnits(week.currentUnits)}</td>
                              <td className="num py-1.5 tabular-nums">{formatUnits(week.proposedUnits)}</td>
                              <td className="num py-1.5">
                                <Input
                                  value={decisionWeeks[week.weekId] ?? ""}
                                  onChange={(event) => setDecisionWeeks((current) => ({
                                    ...current,
                                    [week.weekId]: event.target.value,
                                  }))}
                                  className="w-28 justify-self-end tabular-nums"
                                  inputMode="decimal"
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-xs text-text-tertiary">
                      {decisionState.proposal.weeks.length.toLocaleString("en-GB")} week rows will be merged into the selected draft scenario using the proposal's weekly numbers.
                    </div>
                  )}
                </div>
              )}

              <label className="text-xs">
                <span className="text-text-tertiary">
                  {decisionState.type === "reject" ? "Reason for rejection" : "Note"}
                </span>
                <Textarea
                  value={decisionNote}
                  onChange={(event) => setDecisionNote(event.target.value)}
                  className="mt-1 min-h-20"
                  placeholder={decisionState.type === "reject" ? "Why is this proposal wrong for the business?" : "Optional context for the decision"}
                />
              </label>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDecisionState(null)}>
                  Cancel
                </Button>
                <Button type="button" variant={decisionState.type === "reject" ? "destructive" : "default"} disabled={decisionBusy} onClick={submitDecision}>
                  {decisionBusy ? "Saving…" : "Confirm"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm bulk acceptance</DialogTitle>
            <DialogDescription>
              This will write the currently selected proposals into {selectedScenario?.name ?? "the selected draft scenario"} as draft scenario edits.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm">
            <p>{selectedProposalIds.length.toLocaleString("en-GB")} proposals selected</p>
            <p className="mt-1 text-text-tertiary">{totalSelectedWeeks.toLocaleString("en-GB")} week rows will be written</p>
            <p className="mt-1 text-text-tertiary">{formatEur(totalSelectedValue)} total value at stake</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBulkOpen(false)}>Cancel</Button>
            <Button type="button" disabled={bulkBusy} onClick={submitBulkAccept}>
              {bulkBusy ? "Writing…" : "Accept selected"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}