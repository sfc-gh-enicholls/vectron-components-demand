"use client";

import * as React from "react";
import Link from "next/link";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FlaskConical,
  GitBranch,
  Minus,
  Pencil,
  Plus,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
} from "lucide-react";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
import { Card } from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import {
  HierarchyFilter,
  pathLabel,
  pathToParams,
  type HierarchyOptions,
  type HierarchyPath,
} from "@/components/hierarchy-filter";
import {
  CHART_COLORS,
  formatUnits,
  formatEur,
  formatSignedPercent,
  formatWeek,
  formatWeekShort,
  STATUS_CLASSES,
} from "@/lib/format";
import { cn } from "@/lib/utils";

interface ScenarioSummary {
  scenarioId: string;
  name: string;
  description: string | null;
  status: string;
  basePlanWeek: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string | null;
  promotedAt: string | null;
  promotedBy: string | null;
  parentScenarioId: string | null;
  editCount: number;
  seriesEdited: number;
  editGroups: number;
  agentEdits: number;
  plannerEdits: number;
  deltaUnits: number;
  deltaValueEur: number;
  isStale: boolean;
}

/** The hierarchy path a payload was computed for, echoed by the server. */
interface ScenarioScope {
  path: HierarchyPath;
  label: string;
}

/** A scenario's edits restricted to the scope; equals the summary at the root. */
interface ScenarioImpact {
  editCount: number;
  seriesEdited: number;
  editGroups: number;
  agentEdits: number;
  plannerEdits: number;
  deltaUnits: number;
  deltaValueEur: number;
}

interface ScenarioListData {
  context: {
    HISTORY_END_WEEK: string;
    CURRENT_WEEK: string;
    HORIZON_END_WEEK: string;
    PRODUCTION_MODEL: string;
    BENCHMARK_MODEL: string;
  };
  scope: ScenarioScope;
  baseline: {
    totalUnits: number;
    totalValueEur: number;
    seriesCount: number;
    weekCount: number;
  };
  scenarios: ScenarioSummary[];
  options: {
    hierarchy: HierarchyOptions;
    categories: string[];
    customers: string[];
    channels: string[];
    products: string[];
    weeks: string[];
    series: Array<{
      seriesId: string;
      label: string;
      productName: string;
      productLine: string;
      customerName: string;
      channelName: string;
      categoryName: string;
    }>;
  };
}

interface SupplyGapData {
  planSource: string;
  solvedAt: string;
  isStale: boolean;
  requestedUnits: number;
  onTimeUnits: number;
  gapUnits: number;
  gapValueEur: number;
}

/**
 * Can supply deliver this scenario? The gap is the net requirement supply
 * cannot deliver on time (late, lost to aged liquid or unmet), from each plan's
 * last constrained solve, so the scenario is read against the committed plan
 * without touching it.
 */
function SupplyGapCard({ supply, scenarioId }: { supply: ScenarioDetailData["supply"]; scenarioId: string }) {
  const [solving, setSolving] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const s = supply?.scenario ?? null;
  const c = supply?.committed ?? null;

  async function solve() {
    setSolving(true);
    const res = await fetch("/api/supply/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: scenarioId }),
    });
    setSolving(false);
    setNote(res.ok
      ? "Solving this scenario's supply (about 30 seconds). Reopen the scenario to see the gap, or follow it on the supply review."
      : "Could not start the solve.");
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="card-title">Supply gap</h2>
        <a href="/supply" className="text-xs font-bold text-title-ink hover:underline">Supply review ›</a>
      </div>
      {!supply ? (
        <p className="mt-2 text-xs text-text-tertiary">Supply figures are unavailable right now.</p>
      ) : !s ? (
        <div className="mt-2 space-y-2 text-xs">
          <p className="text-text-tertiary">
            This scenario has not been supply-solved, so its gap is unknown rather than zero.
          </p>
          <Button size="sm" variant="outline" disabled={solving} onClick={() => void solve()}>
            {solving ? "Starting\u2026" : "Solve supply for this scenario"}
          </Button>
          {note && <p className="text-text-tertiary">{note}</p>}
        </div>
      ) : (
        <div className="mt-2 space-y-2 text-xs">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <span className="label">Scenario gap</span>
              <p className="text-base font-medium tabular-nums">{formatUnits(s.gapUnits)}</p>
              <p className="text-text-tertiary tabular-nums">{formatEur(s.gapValueEur)} at ex-works price</p>
            </div>
            <div>
              <span className="label">Committed plan gap</span>
              <p className="text-base font-medium tabular-nums">{c ? formatUnits(c.gapUnits) : "Not solved"}</p>
              <p className="text-text-tertiary tabular-nums">{c ? `${formatEur(c.gapValueEur)} at ex-works price` : ""}</p>
            </div>
            <div>
              <span className="label">Difference</span>
              <p className="text-base font-medium tabular-nums">
                {c ? `${s.gapUnits - c.gapUnits >= 0 ? "+" : "\u2212"}${formatUnits(Math.abs(s.gapUnits - c.gapUnits))}` : "\u2014"}
              </p>
              <p className="text-text-tertiary">
                {c ? (s.gapUnits > c.gapUnits ? "harder for supply than the committed plan" : "no harder for supply than the committed plan") : ""}
              </p>
            </div>
          </div>
          <p className="text-text-tertiary">
            Gap = net requirement (after stock and safety stock) not delivered on time: late, lost to
            aged liquid, or unmet in the 52-week horizon. The committed plan is unchanged until this
            scenario is promoted and approved, which re-solves it.
            {s.isStale ? " This scenario has changed since its last solve, so solve again for current figures." : ""}
          </p>
          {s.isStale && (
            <Button size="sm" variant="outline" disabled={solving} onClick={() => void solve()}>
              {solving ? "Starting\u2026" : "Solve again"}
            </Button>
          )}
          {note && <p className="text-text-tertiary">{note}</p>}
        </div>
      )}
    </Card>
  );
}

interface ScenarioDetailData {
  context: ScenarioListData["context"];
  scope: ScenarioScope;
  scenario: ScenarioSummary;
  impact: ScenarioImpact;
  /** Supply gap from the last constrained solves (null when unavailable). */
  supply?: { scenario: SupplyGapData | null; committed: SupplyGapData | null } | null;
  comparison: {
    weeks: Array<{
      weekId: string;
      committedUnits: number;
      scenarioUnits: number;
      deltaUnits: number;
      deltaValueEur: number;
    }>;
  };
  edits: Array<{
    seriesId: string;
    seriesLabel: string;
    productName: string;
    customerName: string;
    channelName: string;
    categoryName: string;
    weekId: string;
    beforeUnits: number;
    afterUnits: number;
    deltaUnits: number;
    deltaValueEur: number;
    origin: string;
    reasonCode: string | null;
    reasonLabel: string | null;
    note: string | null;
    editGroupId: string;
    parentLevel: string | null;
    parentLevelLabel: string | null;
    parentKey: string | null;
    disaggMethod: string;
    disaggMethodLabel: string | null;
    editedBy: string;
    editedAt: string;
  }>;
  topMovers: Array<{
    seriesId: string;
    seriesLabel: string;
    productName: string;
    customerName: string;
    channelName: string;
    categoryName: string;
    committedUnits: number;
    scenarioUnits: number;
    deltaUnits: number;
    deltaValueEur: number;
  }>;
  reasons: Array<{
    REASON_CODE: string;
    REASON_LABEL: string;
    REASON_GROUP: string;
    REQUIRES_NOTE: boolean;
  }>;
}

type DraftMode = "direct" | "parent";
type PendingAction = null | { type: "create" | "duplicate" | "rename" | "discard" | "promote" };

function Direction({ value }: { value: number }) {
  if (Math.abs(value) < 0.0001) {
    return <Minus size={13} className="text-neutral" aria-hidden="true" />;
  }
  return value > 0 ? (
    <TrendingUp size={13} className="text-positive" aria-hidden="true" />
  ) : (
    <TrendingDown size={13} className="text-negative" aria-hidden="true" />
  );
}

function ScenarioStatusBadge({ status }: { status: string }) {
  const label = status === "in_review" ? "awaiting approval" : status;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]", STATUS_CLASSES[status] ?? "bg-neutral-subtle text-neutral")}>
      <span aria-hidden="true">{status === "promoted" ? "✓" : status === "discarded" ? "×" : status === "in_review" ? "…" : "•"}</span>
      <span className="capitalize">{label}</span>
    </span>
  );
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return date.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function skeletonForScenarioPage() {
  return <div className="p-6"><PageSkeleton kpis={0} chart rows={10} /></div>;
}

function toSelectValue(value: string | null) {
  return value ?? "";
}

function isScoped(path: HierarchyPath) {
  return Object.values(path).some(Boolean);
}

/** Identifies one detail request, so a payload is never mistaken for a newer one. */
function detailRequestKey(scenarioId: string, scopeQuery: string, revision: number) {
  return `${scenarioId}?${scopeQuery}#${revision}`;
}

/**
 * Bar label for a mover. The product is enough across the portfolio, but once the
 * scope pins a product every bar would read the same, so name what still varies.
 */
function moverLabel(mover: ScenarioDetailData["topMovers"][number], scopePath: HierarchyPath) {
  return scopePath.PRODUCT_NAME ? `${mover.customerName} · ${mover.channelName}` : mover.productName;
}

export default function ScenariosPage() {
  const [data, setData] = React.useState<ScenarioListData | null>(null);
  const [detail, setDetail] = React.useState<ScenarioDetailData | null>(null);
  const [selectedScenarioId, setSelectedScenarioId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [draftName, setDraftName] = React.useState("");
  const [draftDescription, setDraftDescription] = React.useState("");
  const [copyFromScenarioId, setCopyFromScenarioId] = React.useState("none");
  const [includeDiscarded, setIncludeDiscarded] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [path, setPath] = React.useState<HierarchyPath>({});
  const [listRevision, setListRevision] = React.useState(0);
  const [detailRevision, setDetailRevision] = React.useState(0);
  const [detailKey, setDetailKey] = React.useState<string | null>(null);
  const scopeQuery = React.useMemo(() => new URLSearchParams(pathToParams(path)).toString(), [path]);

  const [editMode, setEditMode] = React.useState<DraftMode>("direct");
  const [editWeek, setEditWeek] = React.useState("");
  const [editSeriesId, setEditSeriesId] = React.useState("");
  const [editParentLevel, setEditParentLevel] = React.useState("CATEGORY_NAME");
  const [editParentKey, setEditParentKey] = React.useState("");
  const [editDisaggMethod, setEditDisaggMethod] = React.useState("current_plan");
  const [editUnits, setEditUnits] = React.useState("");
  const [editReasonCode, setEditReasonCode] = React.useState("");
  const [editNote, setEditNote] = React.useState("");
  const [editing, setEditing] = React.useState(false);

  // Both reads run from effects keyed on what they depend on, so the newest
  // scope, scenario or revision always wins and a late, older response is
  // dropped instead of overwriting it. Mutations bump a revision to re-read.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams(scopeQuery);
        if (includeDiscarded) params.set("includeDiscarded", "1");
        const res = await fetch(`/api/scenarios?${params.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? "Failed to load scenarios");
        const payload = json as ScenarioListData;
        setData(payload);
        // Keep the open scenario while it is still listed, so changing the scope
        // or saving an edit does not jump back to the first card.
        setSelectedScenarioId((current) => (
          current && payload.scenarios.some((scenario) => scenario.scenarioId === current)
            ? current
            : payload.scenarios[0]?.scenarioId ?? null
        ));
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [includeDiscarded, scopeQuery, listRevision]);

  React.useEffect(() => {
    if (!selectedScenarioId) {
      setDetail(null);
      setDetailKey(null);
      return;
    }
    const key = detailRequestKey(selectedScenarioId, scopeQuery, detailRevision);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/scenarios/${selectedScenarioId}${scopeQuery ? `?${scopeQuery}` : ""}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? "Failed to load scenario detail");
          return;
        }
        setDetail(json as ScenarioDetailData);
        setDetailKey(key);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedScenarioId, scopeQuery, detailRevision]);

  React.useEffect(() => {
    if (!detail) return;
    setDraftName(detail.scenario.name);
    setDraftDescription(detail.scenario.description ?? "");
  }, [detail?.scenario.scenarioId]);

  React.useEffect(() => {
    if (!data) return;
    const inScope = data.options.series;
    // A direct edit targets a series inside the scope. When the scope moves past
    // the chosen one, clear it, or take the only series left at the leaf.
    setEditSeriesId((current) => {
      if (inScope.some((series) => series.seriesId === current)) return current;
      return inScope.length === 1 ? inScope[0].seriesId : "";
    });
  }, [data]);

  const selectedScenario = detail?.scenario ?? data?.scenarios.find((scenario) => scenario.scenarioId === selectedScenarioId) ?? null;
  const requestedDetailKey = selectedScenarioId
    ? detailRequestKey(selectedScenarioId, scopeQuery, detailRevision)
    : null;
  // The detail on screen belongs to an earlier scenario, scope or revision until
  // its replacement lands: keep it visible, but mark it as updating.
  const detailUpdating = detail !== null && detailKey !== requestedDetailKey;
  const detailScoped = detail ? isScoped(detail.scope.path) : false;
  const pageScoped = isScoped(path);

  const reasonNeedsNote = detail?.reasons.find((reason) => reason.REASON_CODE === editReasonCode)?.REQUIRES_NOTE ?? false;
  const parentOptions = React.useMemo(() => {
    if (!data) return [] as string[];
    switch (editParentLevel) {
      case "PRODUCT_LINE":
        return data.options.products;
      case "CUSTOMER_NAME":
        return data.options.customers;
      case "CHANNEL_NAME":
        return data.options.channels;
      default:
        return data.options.categories;
    }
  }, [data, editParentLevel]);

  const chartData = detail?.comparison.weeks.map((week) => ({
    weekId: week.weekId,
    committed: week.committedUnits,
    scenario: week.scenarioUnits,
    deltaUnits: week.deltaUnits,
  })) ?? [];

  const moverScopePath = detail?.scope.path ?? {};
  const moverData = detail?.topMovers.slice(0, 8).map((row) => ({
    seriesId: row.seriesId,
    label: moverLabel(row, moverScopePath),
    deltaUnits: row.deltaUnits,
  })) ?? [];

  function refreshAfterMutation(nextScenarioId?: string | null) {
    setListRevision((revision) => revision + 1);
    if (nextScenarioId) {
      setSelectedScenarioId(nextScenarioId);
      setDetailRevision((revision) => revision + 1);
      // A freshly opened scenario starts on the first forward week, as before.
      if (!editWeek && data?.options.weeks[0]) setEditWeek(data.options.weeks[0]);
    }
  }

  async function submitScenarioAction() {
    if (!pendingAction) return;
    setSubmitting(true);
    setMessage(null);
    try {
      let body: Record<string, unknown>;
      if (pendingAction.type === "create") {
        body = {
          action: "create",
          name: draftName,
          description: draftDescription,
          copyFrom: copyFromScenarioId === "none" ? null : copyFromScenarioId,
        };
      } else if (!selectedScenario) {
        throw new Error("Select a scenario first.");
      } else if (pendingAction.type === "duplicate") {
        body = {
          action: "duplicate",
          scenarioId: selectedScenario.scenarioId,
          name: draftName,
          description: draftDescription,
        };
      } else if (pendingAction.type === "rename") {
        body = {
          action: "rename",
          scenarioId: selectedScenario.scenarioId,
          name: draftName,
          description: draftDescription,
        };
      } else if (pendingAction.type === "discard") {
        body = { action: "discard", scenarioId: selectedScenario.scenarioId };
      } else {
        body = { action: "promote", scenarioId: selectedScenario.scenarioId, confirm: true };
      }

      const res = await fetch("/api/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Scenario action failed");

      const nextScenarioId = typeof json.scenarioId === "string"
        ? json.scenarioId
        : pendingAction.type === "discard"
          ? null
          : selectedScenarioId;

      setPendingAction(null);
      setMessage({
        ok: true,
        text:
          pendingAction.type === "promote"
            ? "Submitted for approval. The demand planning lead approves it on the Approvals screen; until then the scenario is frozen and the committed plan is unchanged."
            : pendingAction.type === "discard"
              ? "Scenario discarded."
              : pendingAction.type === "rename"
                ? "Scenario details updated."
                : pendingAction.type === "duplicate"
                  ? "Scenario duplicated."
                  : "Scenario created.",
      });
      refreshAfterMutation(nextScenarioId);
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedScenario) return;
    setEditing(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        action: "upsertEdit",
        weekId: editWeek,
        targetUnits: Number(editUnits),
        reasonCode: editReasonCode,
        note: editNote,
      };
      if (editMode === "direct") {
        body.seriesId = editSeriesId;
      } else {
        body.parentLevel = editParentLevel;
        body.parentKey = editParentKey;
        body.disaggMethod = editDisaggMethod;
      }

      const res = await fetch(`/api/scenarios/${selectedScenario.scenarioId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save edit");
      // The POST answers with the portfolio-wide detail, so re-read the detail for
      // the scope on screen rather than showing that one, and refresh the cards.
      setDetailRevision((revision) => revision + 1);
      setListRevision((revision) => revision + 1);
      setMessage({ ok: true, text: "Scenario edit saved." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setEditing(false);
    }
  }

  async function removeEdit(seriesId: string, weekId: string) {
    if (!selectedScenario) return;
    setEditing(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/scenarios/${selectedScenario.scenarioId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "removeEdit", seriesId, weekId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to remove edit");
      setDetailRevision((revision) => revision + 1);
      setListRevision((revision) => revision + 1);
      setMessage({ ok: true, text: "Scenario edit removed." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setEditing(false);
    }
  }

  function openCreateDialog() {
    setDraftName("");
    setDraftDescription("");
    setCopyFromScenarioId(selectedScenarioId ?? "none");
    setPendingAction({ type: "create" });
  }

  function openDuplicateDialog() {
    if (!selectedScenario) return;
    setDraftName(`${selectedScenario.name} copy`);
    setDraftDescription(selectedScenario.description ?? "");
    setPendingAction({ type: "duplicate" });
  }

  function openRenameDialog() {
    if (!selectedScenario) return;
    setDraftName(selectedScenario.name);
    setDraftDescription(selectedScenario.description ?? "");
    setPendingAction({ type: "rename" });
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-negative/40 bg-negative-subtle p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium text-negative">Could not load scenario workspace</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!data) return skeletonForScenarioPage();

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Scenario workspace"
        headline="Versioned planning scenarios"
        subtitle={`Named working copies of the committed plan. Baseline weeks run from ${data.options.weeks[0] ?? data.context.CURRENT_WEEK} to ${data.options.weeks.at(-1) ?? data.context.HORIZON_END_WEEK}.`}
        icon={<GitBranch size={18} aria-hidden="true" />}
        metadata={
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span>{data.scenarios.length.toLocaleString("en-GB")} scenarios</span>
            <span>
              {formatUnits(data.baseline.totalUnits)} committed, {formatEur(data.baseline.totalValueEur)} baseline value in {data.scope.label}
            </span>
          </div>
        }
      />

      <Card className="p-4">
        <div>
          <p className="text-xs text-text-tertiary">Portfolio scope</p>
          <HierarchyFilter
            path={path}
            options={data.options.hierarchy}
            onChange={setPath}
            className="mt-1"
          />
          <p className="mt-1 text-xs text-text-tertiary">
            Narrows the open scenario's impact, weekly comparison, edits and movers, the committed baseline, and the series offered for a direct edit. Scenario cards, parent-level edits and promotion always cover the whole portfolio.
          </p>
        </div>
      </Card>

      <Card className="bg-positive-subtle p-3">
        <div className="flex items-start gap-2 text-xs">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-positive" aria-hidden="true" />
          <p className="text-text-tertiary">
            <span className="font-medium text-positive">Nothing commits until confirmed.</span>{" "}
            Scenarios are draft working copies. Promotion writes only the scenario's edited series-weeks into the committed plan, and only after an explicit confirmation step.
          </p>
        </div>
      </Card>

      {message && (
        <Card className={cn("p-3", message.ok ? "bg-positive-subtle" : "bg-negative-subtle")}>
          <div className={cn("flex items-start gap-2 text-xs", message.ok ? "text-positive" : "text-negative")}>
            {message.ok ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
            <span>{message.text}</span>
          </div>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1.8fr]">
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="card-title">Scenario list</h2>
              <p className="text-xs text-text-tertiary">
                Summary first: status, size and commercial impact. Card totals are portfolio-wide, whatever the scope.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
                <input
                  type="checkbox"
                  checked={includeDiscarded}
                  onChange={(event) => setIncludeDiscarded(event.target.checked)}
                  className="accent-accent"
                />
                Include discarded
              </label>
              <Button type="button" size="sm" onClick={openCreateDialog}>
                <Plus aria-hidden="true" />
                New scenario
              </Button>
            </div>
          </div>

          <div className="mt-3 space-y-3">
            {data.scenarios.length === 0 ? (
              <div className="rounded-lg border border-border bg-muted/50 px-3 py-6 text-center">
                <p className="text-sm font-medium">No scenarios yet</p>
                <p className="mt-1 text-xs text-text-tertiary">
                  Create a named working copy to start editing the forward plan.
                </p>
              </div>
            ) : (
              data.scenarios.map((scenario) => {
                const selected = scenario.scenarioId === selectedScenarioId;
                return (
                  <button
                    key={scenario.scenarioId}
                    type="button"
                    onClick={() => setSelectedScenarioId(scenario.scenarioId)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-3 text-left transition-colors",
                      selected ? "border-accent bg-accent-subtle" : "border-border bg-card hover:bg-muted/50",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{scenario.name}</span>
                          <ScenarioStatusBadge status={scenario.status} />
                          {scenario.isStale && (
                            <Badge className="bg-warning-subtle text-warning">
                              <AlertTriangle aria-hidden="true" />
                              stale base
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-text-tertiary">
                          {scenario.description || "No description recorded"}
                        </p>
                      </div>
                      <span className="text-xs text-text-tertiary">
                        {formatDateTime(scenario.updatedAt ?? scenario.createdAt)}
                      </span>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-tertiary sm:grid-cols-3">
                      <span>{scenario.editCount.toLocaleString("en-GB")} edits</span>
                      <span>{scenario.seriesEdited.toLocaleString("en-GB")} series touched</span>
                      <span>{scenario.agentEdits.toLocaleString("en-GB")} agent / {scenario.plannerEdits.toLocaleString("en-GB")} planner</span>
                      <span className="inline-flex items-center gap-1 text-foreground">
                        <Direction value={scenario.deltaUnits} />
                        {formatUnits(scenario.deltaUnits)}
                      </span>
                      <span className="inline-flex items-center gap-1 text-foreground">
                        <Direction value={scenario.deltaValueEur} />
                        {formatEur(scenario.deltaValueEur)}
                      </span>
                      <span>by {scenario.createdBy}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        <div className="space-y-4">
          {!detail || !selectedScenario ? (
            <Card className="p-8 text-center">
              <FlaskConical size={22} className="mx-auto text-text-tertiary" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium">Select a scenario</p>
              <p className="mt-1 text-xs text-text-tertiary">
                Detail opens on demand: weekly comparison, individual edits and the biggest movers.
              </p>
            </Card>
          ) : (
            <>
              {detail.scenario.isStale && (
                <Card className="bg-warning-subtle p-3">
                  <div className="flex items-start gap-2 text-xs text-warning">
                    <AlertTriangle size={14} className="mt-0.5" aria-hidden="true" />
                    <p>
                      <span className="font-medium">Scenario is stale.</span>{" "}
                      It branched from {detail.scenario.basePlanWeek}, while actuals now run to {detail.context.HISTORY_END_WEEK}. The committed plan moved under this scenario.
                    </p>
                  </div>
                </Card>
              )}

              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="card-title">{detail.scenario.name}</h2>
                      <ScenarioStatusBadge status={detail.scenario.status} />
                    </div>
                    <p className="mt-1 text-xs text-text-tertiary">
                      {detail.scenario.description || "No description recorded"}
                    </p>
                    <p className="mt-2 text-xs text-text-tertiary">
                      Created by {detail.scenario.createdBy} on {formatDateTime(detail.scenario.createdAt)}
                      {detail.scenario.parentScenarioId ? " · branched from another scenario" : " · branched from the committed plan"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {detail.scenario.status === "draft" && (
                      <>
                        <Button type="button" variant="outline" size="sm" onClick={openRenameDialog}>
                          <Pencil aria-hidden="true" />
                          Rename
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={openDuplicateDialog}>
                          <Copy aria-hidden="true" />
                          Duplicate
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setPendingAction({ type: "discard" })}>
                          <Trash2 aria-hidden="true" />
                          Discard
                        </Button>
                        <Button type="button" size="sm" onClick={() => setPendingAction({ type: "promote" })}>
                          <Upload aria-hidden="true" />
                          Submit for approval
                        </Button>
                      </>
                    )}
                    {detail.scenario.status === "in_review" && (
                      <Link href="/approvals" className="text-xs font-medium text-accent hover:underline">
                        Awaiting approval — view request
                      </Link>
                    )}
                  </div>
                </div>

                <div
                  className={cn("mt-4 transition-opacity", detailUpdating && "opacity-60")}
                  aria-busy={detailUpdating}
                >
                  <p className="text-xs text-text-tertiary">
                    Impact in <span className="font-medium text-foreground">{detail.scope.label}</span>
                    {detailScoped && (
                      <> &middot; whole scenario {formatUnits(detail.scenario.deltaUnits)}, {formatEur(detail.scenario.deltaValueEur)}</>
                    )}
                  </p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                      <p className="text-xs text-text-tertiary">Delta volume</p>
                      <p className="mt-1 text-lg font-semibold tabular-nums">{formatUnits(detail.impact.deltaUnits)}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                      <p className="text-xs text-text-tertiary">Delta value</p>
                      <p className="mt-1 text-lg font-semibold tabular-nums">{formatEur(detail.impact.deltaValueEur)}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                      <p className="text-xs text-text-tertiary">Planner versus agent edits</p>
                      <p className="mt-1 text-lg font-semibold tabular-nums">
                        {detail.impact.plannerEdits.toLocaleString("en-GB")} / {detail.impact.agentEdits.toLocaleString("en-GB")}
                      </p>
                    </div>
                  </div>
                </div>
              </Card>

              {detail.scenario.status === "draft" && (
                <Card className="p-4">
                  <div className="mb-3">
                    <h2 className="card-title">Add or update an edit</h2>
                    <p className="text-xs text-text-tertiary">
                      Direct edits change one series-week. Parent-level edits disaggregate the total across matching children and keep the leaf rows reconciled.
                    </p>
                  </div>

                  <form className="space-y-3" onSubmit={submitEdit}>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Button
                        type="button"
                        variant={editMode === "direct" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setEditMode("direct")}
                      >
                        Direct series-week
                      </Button>
                      <Button
                        type="button"
                        variant={editMode === "parent" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setEditMode("parent")}
                      >
                        Parent-level total
                      </Button>
                    </div>

                    {editMode === "parent" && pageScoped && (
                      <p className="text-xs text-text-tertiary">
                        <span className="font-medium text-foreground">Portfolio-wide.</span>{" "}
                        A parent total spreads across every series under the chosen category, product family, customer or channel, not only those in {pathLabel(path)}.
                      </p>
                    )}

                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <label className="text-xs">
                        <span className="text-text-tertiary">Week</span>
                        <Select value={editWeek} onValueChange={(value) => setEditWeek(toSelectValue(value))}>
                          <SelectTrigger className="mt-1 w-full">
                            <SelectValue placeholder="Select week" />
                          </SelectTrigger>
                          <SelectContent>
                            {data.options.weeks.map((weekId) => (
                              <SelectItem key={weekId} value={weekId}>{formatWeek(weekId)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>

                      {editMode === "direct" ? (
                        <label className="text-xs md:col-span-2 xl:col-span-1">
                          <span className="text-text-tertiary">
                            Series &middot; {data.options.series.length.toLocaleString("en-GB")} in scope
                          </span>
                          <Select
                            value={editSeriesId}
                            onValueChange={(value) => setEditSeriesId(toSelectValue(value))}
                            disabled={data.options.series.length === 0}
                          >
                            <SelectTrigger className="mt-1 w-full">
                              <SelectValue
                                placeholder={data.options.series.length === 0 ? "No series in this scope" : "Select series"}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {data.options.series.map((series) => (
                                <SelectItem key={series.seriesId} value={series.seriesId}>
                                  {series.productName} · {series.customerName} · {series.channelName}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                      ) : (
                        <>
                          <label className="text-xs">
                            <span className="text-text-tertiary">Parent level</span>
                            <Select value={editParentLevel} onValueChange={(value) => setEditParentLevel(toSelectValue(value))}>
                              <SelectTrigger className="mt-1 w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="CATEGORY_NAME">Category</SelectItem>
                                <SelectItem value="PRODUCT_LINE">Product family</SelectItem>
                                <SelectItem value="CUSTOMER_NAME">Customer</SelectItem>
                                <SelectItem value="CHANNEL_NAME">Channel</SelectItem>
                              </SelectContent>
                            </Select>
                          </label>
                          <label className="text-xs">
                            <span className="text-text-tertiary">Parent selection</span>
                            <Select value={editParentKey} onValueChange={(value) => setEditParentKey(toSelectValue(value))}>
                              <SelectTrigger className="mt-1 w-full">
                                <SelectValue placeholder="Select member" />
                              </SelectTrigger>
                              <SelectContent>
                                {parentOptions.map((option) => (
                                  <SelectItem key={option} value={option}>{option}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </label>
                        </>
                      )}

                      <label className="text-xs">
                        <span className="text-text-tertiary">
                          {editMode === "direct" ? "New case volume" : "Parent total case volume"}
                        </span>
                        <Input
                          type="number"
                          min={0}
                          value={editUnits}
                          onChange={(event) => setEditUnits(event.target.value)}
                          className="mt-1 tabular-nums"
                        />
                      </label>

                      {editMode === "parent" && (
                        <label className="text-xs">
                          <span className="text-text-tertiary">Disaggregation</span>
                          <Select value={editDisaggMethod} onValueChange={(value) => setEditDisaggMethod(toSelectValue(value))}>
                            <SelectTrigger className="mt-1 w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="current_plan">Current plan share</SelectItem>
                              <SelectItem value="statistical">Statistical share</SelectItem>
                            </SelectContent>
                          </Select>
                        </label>
                      )}

                      <label className="text-xs">
                        <span className="text-text-tertiary">Reason</span>
                        <Select value={editReasonCode} onValueChange={(value) => setEditReasonCode(toSelectValue(value))}>
                          <SelectTrigger className="mt-1 w-full">
                            <SelectValue placeholder="Select reason" />
                          </SelectTrigger>
                          <SelectContent>
                            {detail.reasons.map((reason) => (
                              <SelectItem key={reason.REASON_CODE} value={reason.REASON_CODE}>
                                {reason.REASON_GROUP} · {reason.REASON_LABEL}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>

                      <label className="text-xs md:col-span-2 xl:col-span-3">
                        <span className="text-text-tertiary">
                          Note {reasonNeedsNote ? <span className="text-warning">(required)</span> : null}
                        </span>
                        <Textarea
                          value={editNote}
                          onChange={(event) => setEditNote(event.target.value)}
                          className="mt-1 min-h-20"
                          placeholder="Why should this scenario differ from the committed plan?"
                        />
                      </label>
                    </div>

                    <div className="flex justify-end">
                      <Button type="submit" size="sm" disabled={editing}>
                        <Plus aria-hidden="true" />
                        {editing ? "Saving…" : "Save edit"}
                      </Button>
                    </div>
                  </form>
                </Card>
              )}

              <SupplyGapCard supply={detail.supply ?? null} scenarioId={detail.scenario.scenarioId} />

              <Card className={cn("p-4 transition-opacity", detailUpdating && "opacity-60")} aria-busy={detailUpdating}>
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <div>
                    <h2 className="card-title">Weekly total comparison</h2>
                    <p className="text-xs text-text-tertiary">
                      Committed plan versus scenario for the forward horizon in {detail.scope.label}.
                    </p>
                  </div>
                  <span className="text-xs text-text-tertiary">{chartData.length.toLocaleString("en-GB")} weeks</span>
                </div>
                {chartData.length === 0 ? (
                  <div className="flex h-56 flex-col items-center justify-center rounded-lg border border-border bg-muted/40 px-3 text-center">
                    <p className="text-sm font-medium">No forward plan in this scope</p>
                    <p className="mt-1 text-xs text-text-tertiary">
                      No series match {detail.scope.label}. Widen the scope to compare the plans.
                    </p>
                  </div>
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                        <XAxis
                          dataKey="weekId"
                          tickFormatter={formatWeekShort}
                          tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                          stroke="var(--chart-grid)"
                        />
                        <YAxis
                          tickFormatter={(value) => formatUnits(value).replace(" pcs", "")}
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
                          formatter={(value, name) => [formatUnits(Number(value)), name]}
                          labelFormatter={(value) => formatWeek(String(value))}
                        />
                        <ReferenceLine y={0} stroke="var(--chart-grid)" />
                        <Line
                          dataKey="committed"
                          name="Committed plan"
                          stroke={CHART_COLORS[1]}
                          strokeDasharray="4 3"
                          strokeWidth={1.75}
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Line
                          dataKey="scenario"
                          name="Scenario"
                          stroke={CHART_COLORS[0]}
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>

              <div
                className={cn("grid gap-4 transition-opacity xl:grid-cols-[1.6fr_1fr]", detailUpdating && "opacity-60")}
                aria-busy={detailUpdating}
              >
                <Card className="p-4">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <div>
                      <h2 className="card-title">Individual edits</h2>
                      <p className="text-xs text-text-tertiary">
                        Before, after, delta, source and explanation for each edited leaf row in {detail.scope.label}.
                      </p>
                    </div>
                    <span className="text-xs text-text-tertiary">{detail.edits.length.toLocaleString("en-GB")} rows</span>
                  </div>
                  {detail.edits.length === 0 ? (
                    <div className="rounded-lg border border-border bg-muted/40 px-3 py-6 text-center">
                      <p className="text-sm font-medium">{detailScoped ? "No edits in this scope" : "No edits yet"}</p>
                      <p className="mt-1 text-xs text-text-tertiary">
                        {detailScoped
                          ? `This scenario changes nothing in ${detail.scope.label}.`
                          : "This scenario still matches the committed plan."}
                      </p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="text-xs text-text-tertiary">
                          <TableHead>Series</TableHead>
                          <TableHead>Week</TableHead>
                          <TableHead className="num">Before</TableHead>
                          <TableHead className="num">After</TableHead>
                          <TableHead className="num">Delta</TableHead>
                          <TableHead>Origin</TableHead>
                          <TableHead>Reason</TableHead>
                          <TableHead>Note</TableHead>
                          {detail.scenario.status === "draft" && <TableHead className="num">Remove</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.edits.slice(0, 24).map((edit) => (
                          <TableRow key={`${edit.seriesId}:${edit.weekId}`}>
                            <TableCell>
                              <div>
                                <p className="font-medium">{edit.productName}</p>
                                <p className="text-xs text-text-tertiary">
                                  {edit.customerName} · {edit.channelName}
                                  {edit.parentLevelLabel && edit.parentKey ? ` · ${edit.parentLevelLabel}: ${edit.parentKey}` : ""}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell>{formatWeek(edit.weekId)}</TableCell>
                            <TableCell className="num">{formatUnits(edit.beforeUnits)}</TableCell>
                            <TableCell className="num">{formatUnits(edit.afterUnits)}</TableCell>
                            <TableCell className="num">
                              <span className="inline-flex items-center gap-1">
                                <Direction value={edit.deltaUnits} />
                                {formatUnits(edit.deltaUnits)}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="inline-flex items-center gap-1 text-xs">
                                {edit.origin === "agent" ? <GitBranch size={12} aria-hidden="true" /> : <Pencil size={12} aria-hidden="true" />}
                                {edit.origin}
                              </span>
                            </TableCell>
                            <TableCell>
                              <div className="text-xs">
                                <p>{edit.reasonLabel ?? edit.reasonCode ?? "No reason"}</p>
                                <p className="text-text-tertiary">{edit.disaggMethodLabel ?? edit.disaggMethod}</p>
                              </div>
                            </TableCell>
                            <TableCell className="max-w-56 whitespace-normal text-xs text-text-tertiary">
                              {edit.note ?? "—"}
                            </TableCell>
                            {detail.scenario.status === "draft" && (
                              <TableCell className="num">
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  onClick={() => removeEdit(edit.seriesId, edit.weekId)}
                                  aria-label={`Remove edit for ${edit.productName} ${edit.weekId}`}
                                >
                                  <Trash2 aria-hidden="true" />
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </Card>

                <Card className="p-4">
                  <div className="mb-3">
                    <h2 className="card-title">Top movers</h2>
                    <p className="text-xs text-text-tertiary">
                      Largest absolute scenario shifts by value in {detail.scope.label}, with bars for the case movement.
                    </p>
                  </div>
                  {moverData.length === 0 ? (
                    <p className="py-6 text-sm text-text-tertiary">
                      {detailScoped
                        ? `No movers in ${detail.scope.label}: the scenario changes nothing there.`
                        : "No movers yet because the scenario has no edits."}
                    </p>
                  ) : (
                    <>
                      <div className="h-56">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={moverData} layout="vertical" margin={{ top: 4, right: 8, left: 72, bottom: 0 }}>
                            <CartesianGrid horizontal={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                            <XAxis
                              type="number"
                              tickFormatter={(value) => formatUnits(value).replace(" pcs", "")}
                              tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                              stroke="var(--chart-grid)"
                            />
                            <YAxis
                              type="category"
                              dataKey="label"
                              width={72}
                              tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                              stroke="var(--chart-grid)"
                            />
                            <Tooltip
                              contentStyle={{
                                background: "var(--bg-elevated)",
                                border: "1px solid var(--border)",
                                borderRadius: 6,
                                fontSize: 12,
                              }}
                              formatter={(value) => [formatUnits(Number(value)), "Case delta"]}
                            />
                            <ReferenceLine x={0} stroke="var(--chart-grid)" />
                            <Bar dataKey="deltaUnits" isAnimationActive={false}>
                              {moverData.map((row) => (
                                <Cell
                                  key={row.seriesId}
                                  fill={row.deltaUnits >= 0 ? "var(--positive)" : "var(--negative)"}
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <Separator className="my-3" />
                      <div className="space-y-2">
                        {detail.topMovers.slice(0, 6).map((mover) => (
                          <div key={mover.seriesId} className="flex items-center justify-between gap-3 text-xs">
                            <div>
                              <p className="font-medium text-foreground">{mover.productName}</p>
                              <p className="text-text-tertiary">{mover.customerName} · {mover.channelName}</p>
                            </div>
                            <div className="text-right">
                              <p className="inline-flex items-center gap-1 text-foreground">
                                <Direction value={mover.deltaUnits} />
                                {formatUnits(mover.deltaUnits)}
                              </p>
                              <p className="text-text-tertiary">{formatEur(mover.deltaValueEur)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </Card>
              </div>
            </>
          )}
        </div>
      </div>

      <Dialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.type === "create" && "New scenario"}
              {pendingAction?.type === "duplicate" && "Duplicate scenario"}
              {pendingAction?.type === "rename" && "Rename scenario"}
              {pendingAction?.type === "discard" && "Discard scenario"}
              {pendingAction?.type === "promote" && "Submit for approval"}
            </DialogTitle>
            <DialogDescription>
              {pendingAction?.type === "create" && "Create a named, versioned working copy of the committed plan or branch from an existing scenario."}
              {pendingAction?.type === "duplicate" && "Create another draft copy with the same edits."}
              {pendingAction?.type === "rename" && "Update the scenario name and description."}
              {pendingAction?.type === "discard" && "Discarded scenarios leave the working list but remain in the audit trail."}
              {pendingAction?.type === "promote" && "The scenario is frozen and sent to the demand planning lead. Their approval writes its edited rows into the committed plan, after checking that none has gone stale."}
            </DialogDescription>
          </DialogHeader>

          {(pendingAction?.type === "create" || pendingAction?.type === "duplicate" || pendingAction?.type === "rename") && (
            <div className="space-y-3">
              <label className="block text-xs">
                <span className="text-text-tertiary">Scenario name</span>
                <Input value={draftName} onChange={(event) => setDraftName(event.target.value)} className="mt-1" />
              </label>
              <label className="block text-xs">
                <span className="text-text-tertiary">Description</span>
                <Textarea value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} className="mt-1 min-h-24" />
              </label>
              {pendingAction.type === "create" && (
                <label className="block text-xs">
                  <span className="text-text-tertiary">Copy edits from</span>
                  <Select value={copyFromScenarioId} onValueChange={(value) => setCopyFromScenarioId(toSelectValue(value))}>
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Committed plan only</SelectItem>
                      {data.scenarios.filter((scenario) => scenario.status !== "discarded").map((scenario) => (
                        <SelectItem key={scenario.scenarioId} value={scenario.scenarioId}>{scenario.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
            </div>
          )}

          {pendingAction?.type === "discard" && selectedScenario && (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm">
              <p>
                <span className="font-medium">{selectedScenario.name}</span> will move to discarded status and disappear from the default list.
              </p>
            </div>
          )}

          {pendingAction?.type === "promote" && selectedScenario && (
            <div className="space-y-3">
              <div className="rounded-lg border border-warning bg-warning-subtle px-3 py-3 text-sm text-warning">
                <p className="font-medium">This goes to approval.</p>
                <p className="mt-1 text-warning">
                  If approved, {selectedScenario.editCount.toLocaleString("en-GB")} edited rows across {selectedScenario.seriesEdited.toLocaleString("en-GB")} series are written into `CORE.FACT_DEMAND_PLAN`. You cannot approve your own request.
                </p>
                {pageScoped && (
                  <p className="mt-1 text-warning">
                    That is the whole scenario across the portfolio, not only {pathLabel(path)}.
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-xs text-text-tertiary">
                <p>Scenario: {selectedScenario.name}</p>
                <p>Delta volume: {formatUnits(selectedScenario.deltaUnits)}</p>
                <p>Delta value: {formatEur(selectedScenario.deltaValueEur)}</p>
                <p>Rows to write: {selectedScenario.editCount.toLocaleString("en-GB")}</p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingAction(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={submitScenarioAction} disabled={submitting}>
              {submitting ? "Working…" : pendingAction?.type === "promote" ? "Confirm submission" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}