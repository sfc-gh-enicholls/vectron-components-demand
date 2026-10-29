"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eraser,
  GitBranch,
  LockKeyhole,
  Minus,
  Network,
  Pencil,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  HierarchyFilter,
  pathLabel,
  pathOrder,
  pathToParams,
  rollupQuery,
  useHierarchyCatalogue,
  type HierarchyLevel,
  type HierarchyOptions,
  type HierarchyPath,
  type PathLevel,
} from "@/components/hierarchy-filter";
import { LEVEL_LABELS, hierarchiesFor, type Dimension } from "@/lib/dimensions";
import { PageBanner } from "@/components/page-banner";
import { ScenarioGridPanel } from "@/components/plan-grid-panels";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatUnits,
  formatEur,
  formatSignedPercent,
  formatWeek,
  SEGMENT_CLASSES,
  STATUS_CLASSES,
} from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The level selector follows the scope's roll-ups: the chosen product, customer
 * and channel trees' levels, then the series. The defaults give the original
 * Category, Product, Customer, Channel, Series.
 */
const LEVEL_PLURALS: Record<Level, string> = {
  CATEGORY_NAME: "categories",
  PRODUCT_NAME: "products",
  CUSTOMER_NAME: "customers",
  CHANNEL_NAME: "channels",
  SERIES_ID: "series",
  PRODUCT_LINE: "product families",
  PRICE_TIER: "price tiers",
  REGION: "regions",
  ROUTE_TO_CUSTOMER: "routes to customer",
  DELIVERY_MODE: "deliveryModes",
  CHANNEL_GROUP: "channel groups",
};

interface LevelOption {
  value: Level;
  label: string;
  plural: string;
}

function levelOptionsFor(path: HierarchyPath): LevelOption[] {
  return [
    ...pathOrder(path).map((value) => ({ value, label: LEVEL_LABELS[value], plural: LEVEL_PLURALS[value] })),
    { value: "SERIES_ID", label: "Series", plural: "series" },
  ];
}

const DIMENSION_LABELS: Record<Dimension, string> = {
  PRODUCT: "Product",
  CUSTOMER: "Customer",
  CHANNEL: "Channel",
  TIME: "Time",
};

const DIMENSIONS: Dimension[] = ["PRODUCT", "CUSTOMER", "CHANNEL", "TIME"];

const DISAGG_METHOD_COPY = {
  statistical: "Spread the change by the statistical baseline. Use this when the model already captures the right shape and the total is what needs correcting.",
  current_plan: "Spread the change by the current scenario plan. Use this when the existing plan shape is intentional and only the total should move.",
} as const;

type Level = PathLevel | "SERIES_ID";
type TargetMode = "absolute" | "percentage";
type DisaggMethod = "statistical" | "current_plan";

interface IntegrityRow {
  CHECK_NAME: string;
  VIOLATIONS: number;
}

interface ReasonOption {
  REASON_CODE: string;
  REASON_LABEL: string;
  REASON_GROUP: string;
  REQUIRES_NOTE: boolean;
}

interface ScenarioSummary {
  scenarioId: string;
  name: string;
  description: string | null;
  status: string;
  basePlanWeek: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string | null;
  editCount: number;
  editGroups: number;
  deltaUnits: number;
  deltaValueEur: number;
}

interface ScenarioListData {
  scenarios: ScenarioSummary[];
}

interface EditGroupSummary {
  editGroupId: string;
  parentLevel: string | null;
  parentKey: string | null;
  disaggMethod: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  editedBy: string | null;
  editedAt: string | null;
  leafCount: number;
  deltaUnits: number;
  deltaValueEur: number;
}

interface HierarchyChildRow {
  childId: string;
  childLabel: string;
  childLevel: Level | "WEEK_ID";
  nodeKey: string;
  committedUnits: number;
  scenarioUnits: number;
  statUnits: number;
  deltaUnits: number;
  committedValueEur: number;
  scenarioValueEur: number;
  deltaValueEur: number;
  seriesCount: number;
  lockedLeafCount: number;
  hasEdits: boolean;
  editGroups: EditGroupSummary[];
}

interface HierarchyNodeRow extends HierarchyChildRow {
  path: Partial<Record<Level, string>>;
  level: Level;
  childCount: number;
  children: HierarchyChildRow[];
}

interface HierarchyData {
  context: {
    HISTORY_END_WEEK: string;
    CURRENT_WEEK: string;
    HORIZON_END_WEEK: string;
    PRODUCTION_MODEL: string;
  };
  integrity: IntegrityRow[];
  level: Level;
  levelLabel: string;
  scenario: { scenarioId: string; scenarioName: string; status: string } | null;
  weeks: string[];
  reasons: ReasonOption[];
  overall: {
    committedUnits: number;
    scenarioUnits: number;
    deltaUnits: number;
    committedValueEur: number;
    scenarioValueEur: number;
    deltaValueEur: number;
    nodeCount: number;
    editedNodeCount: number;
  };
  nodes: HierarchyNodeRow[];
  scope: { path: Partial<Record<HierarchyLevel, string>>; floor: HierarchyLevel | null };
  options: { hierarchy: HierarchyOptions };
}

interface PreviewChildRow {
  childId: string;
  childLabel: string;
  childLevel: Level | "WEEK_ID";
  nodeKey: string;
  currentUnits: number;
  proposedUnits: number;
  deltaUnits: number;
  deltaValueEur: number;
  shareOfChange: number | null;
  locked: boolean;
  excluded: boolean;
  clamped: boolean;
  lockedLeafCount: number;
  movedLeafCount: number;
}

interface PreviewData {
  scenarioId: string;
  scenarioName: string;
  node: {
    level: Level;
    label: string;
    key: string;
    currentUnits: number;
    targetUnits: number;
    weekFrom: string;
    weekTo: string;
  };
  method: DisaggMethod;
  target: {
    mode: TargetMode;
    value: number;
  };
  children: PreviewChildRow[];
  outcome: {
    feasible: boolean;
    shortfall: number;
    targetDelta: number;
    appliedDelta: number;
    lockedCount: number;
    lockedLeafCount: number;
    movedCount: number;
    excludedCount: number;
    clampedCount: number;
    agentEditsReplaced: number;
  };
}

interface EditableRow {
  label: string;
  level: Level;
  nodeKey: string;
  currentUnits: number;
  defaultWeekFrom?: string;
  defaultWeekTo?: string;
  editGroups: EditGroupSummary[];
  hasEdits: boolean;
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

function StatusBadge({ status }: { status: string }) {
  const classes = STATUS_CLASSES[status] ?? "bg-neutral-subtle text-neutral";
  const marker = status === "draft" ? "•" : status === "promoted" ? "✓" : status === "in_review" ? "…" : "×";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]", classes)}>
      <span aria-hidden="true">{marker}</span>
      <span className="capitalize">{status}</span>
    </span>
  );
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPercentInput(value: string): string {
  return value === "" ? "" : value;
}

function buildPreviewRequest(args: {
  scenarioId: string;
  row: EditableRow;
  targetMode: TargetMode;
  targetValueText: string;
  disaggMethod: DisaggMethod;
  weekFrom: string;
  weekTo: string;
  lockedChildIds: Set<string>;
}) {
  const numeric = Number(args.targetValueText);
  return {
    scenarioId: args.scenarioId,
    node: {
      level: args.row.level,
      key: args.row.nodeKey,
    },
    target: {
      mode: args.targetMode,
      value: args.targetMode === "percentage" ? numeric / 100 : numeric,
    },
    disaggMethod: args.disaggMethod,
    weekRange: {
      from: args.weekFrom,
      to: args.weekTo,
    },
    lockedChildIds: Array.from(args.lockedChildIds),
  };
}

function isPreviewDirty(preview: PreviewData | null, targetMode: TargetMode, targetValueText: string, disaggMethod: DisaggMethod, weekFrom: string, weekTo: string, lockedChildIds: Set<string>): boolean {
  if (!preview) return true;
  const previewValue = targetMode === "percentage"
    ? Number((preview.target.value * 100).toFixed(6))
    : preview.target.value;
  const formValue = Number(targetValueText);
  if (!Number.isFinite(formValue)) return true;
  if (preview.target.mode !== targetMode) return true;
  if (Math.abs(previewValue - formValue) > 0.0001) return true;
  if (preview.method !== disaggMethod) return true;
  if (preview.node.weekFrom !== weekFrom || preview.node.weekTo !== weekTo) return true;
  const lockedPreview = new Set(preview.children.filter((child) => child.locked).map((child) => child.childId));
  if (lockedPreview.size !== lockedChildIds.size) return true;
  for (const childId of lockedChildIds) {
    if (!lockedPreview.has(childId)) return true;
  }
  return false;
}

function levelIndex(level: Level, options: LevelOption[]): number {
  return options.findIndex((option) => option.value === level);
}

/**
 * The deepest level the scope selects, counting past gaps, or null at the root.
 *
 * Not the filter's `deepestLevel`, which stops at the first gap: Cognac + China
 * is a customer-level scope here, because a product row under it could only show
 * each product's China rows, while an edit writes to the whole product. The API
 * enforces the same floor (`scopeFloor` in api/hierarchy/shared.ts).
 */
function scopeFloor(path: HierarchyPath): PathLevel | null {
  let floor: PathLevel | null = null;
  for (const level of pathOrder(path)) {
    if (path[level]) floor = level;
  }
  return floor;
}

interface Crumbs {
  ancestors: string[];
  leaf: string;
}

/**
 * Breadcrumb for a node: the path above it, then its own label.
 *
 * Nodes are keyed by their full path but labelled by their last value, so at
 * customer depth every product's Spain reads just "Spain". Display only; keys are
 * untouched. A series label already names its product, customer and channel, so a
 * series adds only its category.
 */
function nodeCrumbs(path: Partial<Record<Level, string>>, level: Level, label: string, order: PathLevel[]): Crumbs {
  const above: PathLevel[] = level === "SERIES_ID"
    ? order.slice(0, 1)
    : order.slice(0, order.indexOf(level));
  return {
    ancestors: above
      .map((ancestor) => path[ancestor])
      .filter((value): value is string => Boolean(value)),
    leaf: label,
  };
}

function crumbText(crumbs: Crumbs): string {
  return [...crumbs.ancestors, crumbs.leaf].join(" / ");
}

function Breadcrumb({ crumbs }: { crumbs: Crumbs }) {
  return (
    <span className="whitespace-normal">
      {crumbs.ancestors.map((ancestor, index) => (
        <span key={`${index}:${ancestor}`} className="text-text-tertiary">{ancestor} / </span>
      ))}
      <span className="font-medium">{crumbs.leaf}</span>
    </span>
  );
}

function rowForChild(parent: HierarchyNodeRow, child: HierarchyChildRow, order: PathLevel[]): EditableRow | null {
  if (child.childLevel === "WEEK_ID") {
    return {
      label: `${crumbText(nodeCrumbs(parent.path, parent.level, parent.childLabel, order))} · ${formatWeek(child.childId)}`,
      level: "SERIES_ID",
      nodeKey: parent.nodeKey,
      currentUnits: child.scenarioUnits,
      defaultWeekFrom: child.childId,
      defaultWeekTo: child.childId,
      editGroups: child.editGroups,
      hasEdits: child.hasEdits,
    };
  }
  return {
    // The parent's path is exactly this child's ancestry.
    label: crumbText(nodeCrumbs(parent.path, child.childLevel, child.childLabel, order)),
    level: child.childLevel,
    nodeKey: child.nodeKey,
    currentUnits: child.scenarioUnits,
    editGroups: child.editGroups,
    hasEdits: child.hasEdits,
  };
}

export default function HierarchyPage() {
  const [level, setLevel] = React.useState<Level>("CATEGORY_NAME");
  const [path, setPath] = React.useState<HierarchyPath>({});
  const { catalogue } = useHierarchyCatalogue();
  const [hierarchy, setHierarchy] = React.useState<HierarchyData | null>(null);
  const [scenarios, setScenarios] = React.useState<ScenarioSummary[]>([]);
  const [scenariosLoaded, setScenariosLoaded] = React.useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = React.useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = React.useState<Record<string, boolean>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState("");
  const [createDescription, setCreateDescription] = React.useState("");
  const [creatingScenario, setCreatingScenario] = React.useState(false);

  const [editorRow, setEditorRow] = React.useState<EditableRow | null>(null);
  const [targetMode, setTargetMode] = React.useState<TargetMode>("absolute");
  const [targetValueText, setTargetValueText] = React.useState("");
  const [disaggMethod, setDisaggMethod] = React.useState<DisaggMethod>("current_plan");
  const [weekFrom, setWeekFrom] = React.useState("");
  const [weekTo, setWeekTo] = React.useState("");
  const [reasonCode, setReasonCode] = React.useState("");
  const [note, setNote] = React.useState("");
  const [lockedChildIds, setLockedChildIds] = React.useState<Set<string>>(new Set());
  const [preview, setPreview] = React.useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [commitLoading, setCommitLoading] = React.useState(false);
  const [revertLoadingId, setRevertLoadingId] = React.useState<string | null>(null);

  const draftScenarios = React.useMemo(
    () => scenarios.filter((scenario) => scenario.status === "draft"),
    [scenarios],
  );

  const reasonNeedsNote = React.useMemo(
    () => hierarchy?.reasons.find((reason) => reason.REASON_CODE === reasonCode)?.REQUIRES_NOTE ?? false,
    [hierarchy?.reasons, reasonCode],
  );

  const selectedScenario = React.useMemo(
    () => draftScenarios.find((scenario) => scenario.scenarioId === selectedScenarioId) ?? null,
    [draftScenarios, selectedScenarioId],
  );

  // The grid takes only the levels that are set; this page's path allows nulls.
  const gridPath = React.useMemo(
    () => Object.fromEntries(Object.entries(path).filter(([, value]) => Boolean(value))) as Record<string, string>,
    [path],
  );

  const previewDirty = React.useMemo(
    () => isPreviewDirty(preview, targetMode, targetValueText, disaggMethod, weekFrom, weekTo, lockedChildIds),
    [preview, targetMode, targetValueText, disaggMethod, weekFrom, weekTo, lockedChildIds],
  );

  const canPreview = Boolean(
    editorRow &&
    selectedScenarioId &&
    weekFrom &&
    weekTo &&
    targetValueText.trim().length > 0 &&
    Number.isFinite(Number(targetValueText)),
  );

  const canCommit = Boolean(
    selectedScenarioId &&
    editorRow &&
    reasonCode &&
    preview &&
    !previewDirty &&
    preview.outcome.feasible &&
    (!reasonNeedsNote || note.trim().length > 0),
  );

  const loadScenarios = React.useCallback(async () => {
    const res = await fetch("/api/scenarios");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Failed to load scenarios");
    const payload = json as ScenarioListData;
    setScenarios(payload.scenarios);
    setScenariosLoaded(true);

    const draftIds = payload.scenarios.filter((scenario) => scenario.status === "draft");
    setSelectedScenarioId((current) => {
      if (current && draftIds.some((scenario) => scenario.scenarioId === current)) {
        return current;
      }
      return draftIds[0]?.scenarioId ?? null;
    });
  }, []);

  const loadHierarchy = React.useCallback(async (activeLevel: Level, scenarioId: string | null, scope: HierarchyPath) => {
    setLoading(true);
    const params = new URLSearchParams({ level: activeLevel, ...pathToParams(scope) });
    if (scenarioId) params.set("scenarioId", scenarioId);
    const res = await fetch(`/api/hierarchy?${params.toString()}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Failed to load hierarchy");
    setHierarchy(json as HierarchyData);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        await loadScenarios();
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadScenarios]);

  React.useEffect(() => {
    if (!selectedScenarioId) {
      setHierarchy(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        await loadHierarchy(level, selectedScenarioId, path);
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [level, path, selectedScenarioId, loadHierarchy]);

  React.useEffect(() => {
    if (!editorRow || !hierarchy) return;
    const firstWeek = editorRow.defaultWeekFrom ?? hierarchy.weeks[0] ?? "";
    const lastWeek = editorRow.defaultWeekTo ?? hierarchy.weeks.at(-1) ?? firstWeek;
    setWeekFrom(firstWeek);
    setWeekTo(lastWeek);
    setReasonCode(hierarchy.reasons[0]?.REASON_CODE ?? "");
    setTargetMode("absolute");
    setTargetValueText(String(Math.round(editorRow.currentUnits)));
    setDisaggMethod("current_plan");
    setNote("");
    setLockedChildIds(new Set());
    setPreview(null);
  }, [editorRow, hierarchy]);

  React.useEffect(() => {
    // Only once the list has loaded: on the first render it is empty because it
    // has not arrived yet, which used to pop this dialog on every visit.
    if (scenariosLoaded && !draftScenarios.length) {
      setCreateOpen(true);
    }
  }, [scenariosLoaded, draftScenarios.length]);

  async function handleCreateScenario() {
    setCreatingScenario(true);
    setMessage(null);
    try {
      const res = await fetch("/api/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: createName,
          description: createDescription,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create scenario");
      await loadScenarios();
      setSelectedScenarioId(json.scenarioId as string);
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      setMessage({ ok: true, text: "Draft scenario created." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setCreatingScenario(false);
    }
  }

  async function handlePreview() {
    if (!selectedScenarioId || !editorRow) return;
    setPreviewLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/hierarchy/preview${rollupQuery(path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPreviewRequest({
          scenarioId: selectedScenarioId,
          row: editorRow,
          targetMode,
          targetValueText,
          disaggMethod,
          weekFrom,
          weekTo,
          lockedChildIds,
        })),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to preview edit");
      setPreview(json as PreviewData);
    } catch (err) {
      setPreview(null);
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCommit() {
    if (!selectedScenarioId || !editorRow) return;
    setCommitLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/hierarchy/commit${rollupQuery(path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildPreviewRequest({
            scenarioId: selectedScenarioId,
            row: editorRow,
            targetMode,
            targetValueText,
            disaggMethod,
            weekFrom,
            weekTo,
            lockedChildIds,
          }),
          reasonCode,
          note,
          confirm: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to commit edit");
      await Promise.all([loadScenarios(), loadHierarchy(level, selectedScenarioId, path)]);
      setEditorRow(null);
      setPreview(null);
      setLockedChildIds(new Set());
      setMessage({ ok: true, text: `Edit committed into ${selectedScenario?.name ?? "the draft scenario"}.` });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setCommitLoading(false);
    }
  }

  async function handleRevert(editGroupId: string) {
    if (!selectedScenarioId) return;
    setRevertLoadingId(editGroupId);
    setMessage(null);
    try {
      const res = await fetch(`/api/hierarchy/commit${rollupQuery(path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revert", scenarioId: selectedScenarioId, editGroupId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to revert edit group");
      await Promise.all([loadScenarios(), loadHierarchy(level, selectedScenarioId, path)]);
      setMessage({ ok: true, text: "Edit group reverted." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setRevertLoadingId(null);
    }
  }

  function openEditor(row: EditableRow) {
    setEditorRow(row);
  }

  function closeEditor() {
    setEditorRow(null);
    setPreview(null);
    setLockedChildIds(new Set());
  }

  function handleScopeChange(next: HierarchyPath) {
    setPath(next);
    // A new roll-up brings new levels: a listed level that is not one of them
    // falls back to the first. Then a scope deeper than the listed level moves
    // the listing down to it, rather than listing rows that would each have to
    // be split (see scopeFloor).
    const nextOptions = levelOptionsFor(next);
    const kept = levelIndex(level, nextOptions) >= 0 ? level : nextOptions[0].value;
    const floor = scopeFloor(next);
    setLevel(floor && levelIndex(floor, nextOptions) > levelIndex(kept, nextOptions) ? floor : kept);
    setExpandedNodes({});
    closeEditor();
  }

  function toggleLockedChild(childId: string, checked: boolean) {
    setLockedChildIds((current) => {
      const next = new Set(current);
      if (checked) next.add(childId);
      else next.delete(childId);
      return next;
    });
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-negative/40 bg-negative-subtle p-4">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div>
              <p className="font-medium text-negative">Could not load the hierarchy workspace.</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (loading) {
    return <div className="p-6"><PageSkeleton kpis={4} chart rows={10} /></div>;
  }

  const failing = hierarchy?.integrity.filter((row) => row.VIOLATIONS > 0) ?? [];
  const levelOptions = levelOptionsFor(path);
  const order = pathOrder(path);
  const scopeFloorLevel = scopeFloor(path);
  const floorIndex = scopeFloorLevel ? levelIndex(scopeFloorLevel, levelOptions) : 0;

  return (
    <>
      <div className="space-y-5 p-5 lg:p-6">
        <PageBanner
          eyebrow="Demand planning"
          headline="Hierarchy overrides"
          subtitle={`Edit the forward plan in a draft scenario, preview the per-child landing, then commit only once the split is defensible. Current week is ${hierarchy?.context.CURRENT_WEEK ?? "—"}.`}
          icon={<Network size={18} aria-hidden="true" />}
        />

        <Card className="p-4">
          <p className="text-xs text-text-tertiary">Portfolio scope</p>
          <HierarchyFilter
            path={path}
            options={hierarchy?.options.hierarchy ?? {}}
            onChange={handleScopeChange}
            className="mt-1"
          />
          <p className="mt-1 text-xs text-text-tertiary">
            The scope chooses which rows are listed and totalled. Each row keeps its whole total, because an edit writes to the whole row.
          </p>
        </Card>

        <ScenarioGridPanel
          key={`${selectedScenario?.scenarioId ?? "none"}|${JSON.stringify(gridPath)}`}
          path={gridPath}
          scenarioId={selectedScenario?.scenarioId ?? null}
          scenarioName={selectedScenario?.name ?? null}
          scenarioStatus={selectedScenario?.status ?? null}
          reasons={hierarchy?.reasons ?? []}
          onCommitted={(text) => {
            setMessage({ ok: true, text });
            void Promise.all([loadScenarios(), loadHierarchy(level, selectedScenarioId, path)]);
          }}
        />

        {message && (
          <Card className={cn("p-3", message.ok ? "bg-positive-subtle" : "bg-negative-subtle")}>
            <div className={cn("flex items-start gap-2 text-xs", message.ok ? "text-positive" : "text-negative")}>
              {message.ok ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
              <span>{message.text}</span>
            </div>
          </Card>
        )}

        {failing.length > 0 && (
          <Card className="p-3">
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle size={15} className="mt-0.5 text-warning" aria-hidden="true" />
              <div>
                <span className="font-medium text-warning">Data integrity warning.</span>{" "}
                <span className="text-text-tertiary">
                  {failing.map((row) => `${row.CHECK_NAME} (${row.VIOLATIONS})`).join(", ")}. No edit should be promoted until these return to zero. Portfolio-wide check — not affected by the scope.
                </span>
              </div>
            </div>
          </Card>
        )}

        <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
          <Card className="p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="card-title">Scenario selector</h2>
                <p className="text-xs text-text-tertiary">
                  Overrides always land in a draft scenario. Nothing writes to the committed plan from this page.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={selectedScenarioId ?? ""} onValueChange={setSelectedScenarioId}>
                  <SelectTrigger className="min-w-[240px]">
                    <SelectValue placeholder="Select a draft scenario" />
                  </SelectTrigger>
                  <SelectContent>
                    {draftScenarios.map((scenario) => (
                      <SelectItem key={scenario.scenarioId} value={scenario.scenarioId}>
                        {scenario.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="button" size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                  <GitBranch aria-hidden="true" />
                  New draft
                </Button>
              </div>
            </div>

            {!selectedScenario ? (
              <div className="mt-4 rounded-lg border border-border bg-muted/40 px-4 py-6 text-center">
                <p className="text-sm font-medium">No draft scenario is available.</p>
                <p className="mt-1 text-xs text-text-tertiary">
                  Create one first. This page previews and commits into a draft only.
                </p>
              </div>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <p className="text-xs text-text-tertiary">Active draft</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{selectedScenario.name}</p>
                    <StatusBadge status={selectedScenario.status} />
                  </div>
                  <p className="mt-1 text-xs text-text-tertiary">{selectedScenario.description || "No description recorded"}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <p className="text-xs text-text-tertiary">Draft delta</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{formatUnits(selectedScenario.deltaUnits)}</p>
                  <p className="mt-1 text-xs text-text-tertiary">{formatEur(selectedScenario.deltaValueEur)}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <p className="text-xs text-text-tertiary">Edit groups</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{selectedScenario.editGroups.toLocaleString("en-GB")}</p>
                  <p className="mt-1 text-xs text-text-tertiary">Updated {formatDateTime(selectedScenario.updatedAt ?? selectedScenario.createdAt)}</p>
                </div>
                <p className="text-xs text-text-tertiary sm:col-span-3">
                  Whole-scenario figures — not affected by the scope, because they describe the draft rather than the rows listed below.
                </p>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div>
              <h2 className="card-title">Level selector</h2>
              <p className="text-xs text-text-tertiary">
                Choose which accountability boundary to edit; the scope chooses which of those rows are listed. The preview always shows the next level down before you commit.
              </p>
            </div>
            <div className="mt-4 inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1">
              {levelOptions.map((option, index) => {
                const shallowerThanScope = index < floorIndex;
                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant={level === option.value ? "default" : "ghost"}
                    size="sm"
                    disabled={shallowerThanScope}
                    aria-describedby={shallowerThanScope ? "hierarchy-depth-note" : undefined}
                    onClick={() => {
                      setLevel(option.value);
                      setExpandedNodes({});
                      closeEditor();
                    }}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
            {floorIndex > 0 && (
              <p id="hierarchy-depth-note" className="mt-2 text-xs text-text-tertiary">
                Scope is set to {levelOptions[floorIndex].label.toLowerCase()} — list {levelOptions[floorIndex].plural} or deeper.
              </p>
            )}
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <p className="text-xs text-text-tertiary">Committed plan</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{formatUnits(hierarchy?.overall.committedUnits ?? 0)}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <p className="text-xs text-text-tertiary">Scenario-effective plan</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{formatUnits(hierarchy?.overall.scenarioUnits ?? 0)}</p>
                <div className="mt-1 inline-flex items-center gap-1 text-xs">
                  <Direction value={hierarchy?.overall.deltaUnits ?? 0} />
                  <span>{formatUnits(hierarchy?.overall.deltaUnits ?? 0)}</span>
                </div>
              </div>
            </div>
            <p className="mt-2 text-xs text-text-tertiary">Totals cover {pathLabel(path)}.</p>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <Card className="p-4">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <div>
                <h2 className="card-title">Hierarchy table</h2>
                <p className="text-xs text-text-tertiary">
                  Expand one row at a time. Edited rows are labelled, and every edit opens in preview mode first.
                </p>
              </div>
              <div className="text-right text-xs text-text-tertiary">
                {hierarchy?.overall.nodeCount.toLocaleString("en-GB") ?? 0} {hierarchy?.levelLabel.toLowerCase()} rows · {pathLabel(path)}
                <br />
                {hierarchy?.overall.editedNodeCount.toLocaleString("en-GB") ?? 0} contain edits
              </div>
            </div>

            {!hierarchy || hierarchy.nodes.length === 0 ? (
              <div className="py-8 text-center">
                {hierarchy && scopeFloorLevel ? (
                  <>
                    <p className="text-sm font-medium">Nothing in the forward plan matches {pathLabel(path)}.</p>
                    <p className="mt-1 text-xs text-text-tertiary">
                      A product may not sell in the selected customer or channel. Widen the scope to list rows again.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-text-tertiary">No hierarchy rows are available.</p>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="text-xs text-text-tertiary">
                    <TableHead>{hierarchy.levelLabel}</TableHead>
                    <TableHead className="num">Committed</TableHead>
                    <TableHead className="num">Scenario</TableHead>
                    <TableHead className="num">Baseline</TableHead>
                    <TableHead className="num">Delta</TableHead>
                    <TableHead className="num">Value delta</TableHead>
                    <TableHead className="num">Children</TableHead>
                    <TableHead className="num">Edit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hierarchy.nodes.map((node) => {
                    const expanded = Boolean(expandedNodes[node.nodeKey]);
                    const edited = node.hasEdits;
                    const crumbs = nodeCrumbs(node.path, node.level, node.childLabel, order);
                    return (
                      <React.Fragment key={node.nodeKey}>
                        <TableRow className={cn(editorRow?.nodeKey === node.nodeKey && editorRow.level === node.level && "bg-accent-subtle")}>
                          <TableCell>
                            <div className="flex items-start gap-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => setExpandedNodes((current) => ({ ...current, [node.nodeKey]: !current[node.nodeKey] }))}
                                aria-label={expanded ? `Collapse ${crumbText(crumbs)}` : `Expand ${crumbText(crumbs)}`}
                              >
                                {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                              </Button>
                              <div className="min-w-48">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Breadcrumb crumbs={crumbs} />
                                  {edited && (
                                    <Badge className="bg-accent-subtle text-accent">
                                      <Pencil aria-hidden="true" />
                                      edited
                                    </Badge>
                                  )}
                                  {node.lockedLeafCount > 0 && (
                                    <Badge className="bg-warning-subtle text-warning">
                                      <LockKeyhole aria-hidden="true" />
                                      {node.lockedLeafCount} locked
                                    </Badge>
                                  )}
                                </div>
                                <p className="mt-1 text-xs text-text-tertiary">
                                  {node.editGroups.length > 0
                                    ? `${node.editGroups.length} edit group${node.editGroups.length === 1 ? "" : "s"}`
                                    : "No edit groups on this row"}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="num tabular-nums">{formatUnits(node.committedUnits)}</TableCell>
                          <TableCell className="num tabular-nums">{formatUnits(node.scenarioUnits)}</TableCell>
                          <TableCell className="num tabular-nums text-text-tertiary">{formatUnits(node.statUnits)}</TableCell>
                          <TableCell className="num tabular-nums">
                            <span className="inline-flex items-center gap-1">
                              <Direction value={node.deltaUnits} />
                              {formatUnits(node.deltaUnits)}
                            </span>
                          </TableCell>
                          <TableCell className="num tabular-nums">{formatEur(node.deltaValueEur)}</TableCell>
                          <TableCell className="num tabular-nums">{node.childCount.toLocaleString("en-GB")}</TableCell>
                          <TableCell className="num">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => openEditor({
                                label: crumbText(crumbs),
                                level: node.level,
                                nodeKey: node.nodeKey,
                                currentUnits: node.scenarioUnits,
                                editGroups: node.editGroups,
                                hasEdits: node.hasEdits,
                              })}
                              disabled={!selectedScenario}
                            >
                              <Pencil aria-hidden="true" />
                              Edit
                            </Button>
                          </TableCell>
                        </TableRow>

                        {expanded && node.children.map((child) => {
                          const childEditor = rowForChild(node, child, order);
                          return (
                            <TableRow key={`${node.nodeKey}:${child.childId}`} className={cn("bg-muted/25 text-xs", childEditor && editorRow?.nodeKey === childEditor.nodeKey && editorRow.level === childEditor.level && editorRow.defaultWeekFrom === childEditor.defaultWeekFrom && "bg-accent-subtle")}>
                              <TableCell className="pl-8">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium">{child.childLabel}</span>
                                  {child.hasEdits && (
                                    <Badge className="bg-accent-subtle text-accent">
                                      <Pencil aria-hidden="true" />
                                      edited
                                    </Badge>
                                  )}
                                  {child.lockedLeafCount > 0 && (
                                    <Badge className="bg-warning-subtle text-warning">
                                      <LockKeyhole aria-hidden="true" />
                                      {child.lockedLeafCount} locked
                                    </Badge>
                                  )}
                                  {child.childLevel === "WEEK_ID" && (
                                    <Badge className={SEGMENT_CLASSES.A}>
                                      one week
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="num tabular-nums">{formatUnits(child.committedUnits)}</TableCell>
                              <TableCell className="num tabular-nums">{formatUnits(child.scenarioUnits)}</TableCell>
                              <TableCell className="num tabular-nums text-text-tertiary">{formatUnits(child.statUnits)}</TableCell>
                              <TableCell className="num tabular-nums">
                                <span className="inline-flex items-center gap-1">
                                  <Direction value={child.deltaUnits} />
                                  {formatUnits(child.deltaUnits)}
                                </span>
                              </TableCell>
                              <TableCell className="num tabular-nums">{formatEur(child.deltaValueEur)}</TableCell>
                              <TableCell className="num tabular-nums">{child.seriesCount.toLocaleString("en-GB")}</TableCell>
                              <TableCell className="num">
                                {childEditor ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => openEditor(childEditor)}
                                    disabled={!selectedScenario}
                                  >
                                    <Pencil aria-hidden="true" />
                                    Edit
                                  </Button>
                                ) : (
                                  <span className="text-text-tertiary">Open series to edit</span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card className="p-4">
            {!editorRow || !hierarchy || !selectedScenario ? (
              <div className="py-10 text-center">
                <Pencil size={20} className="mx-auto text-text-tertiary" aria-hidden="true" />
                <p className="mt-2 text-sm font-medium">Select a row to edit</p>
                <p className="mt-1 text-xs text-text-tertiary">
                  Set the target, choose the split, preview the landing on the children, then commit only when it adds up.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="card-title">Preview before commit</h2>
                      <p className="text-xs text-text-tertiary">{editorRow.label} in {selectedScenario.name}</p>
                    </div>
                    <Button type="button" variant="ghost" size="sm" onClick={closeEditor}>
                      Cancel
                    </Button>
                  </div>
                  <div className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-text-tertiary">
                    Current node total <span className="font-medium text-foreground tabular-nums">{formatUnits(editorRow.currentUnits)}</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      type="button"
                      variant={targetMode === "absolute" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setTargetMode("absolute")}
                    >
                      Absolute units
                    </Button>
                    <Button
                      type="button"
                      variant={targetMode === "percentage" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setTargetMode("percentage")}
                    >
                      Percentage change
                    </Button>
                  </div>

                  <label className="block text-xs">
                    <span className="text-text-tertiary">{targetMode === "absolute" ? "Target units" : "Percentage change"}</span>
                    <Input
                      type="number"
                      value={formatPercentInput(targetValueText)}
                      onChange={(event) => setTargetValueText(event.target.value)}
                      className="mt-1 tabular-nums"
                      step={targetMode === "absolute" ? "1" : "0.1"}
                    />
                  </label>

                  <label className="block text-xs">
                    <span className="text-text-tertiary">Disaggregation method</span>
                    <Select value={disaggMethod} onValueChange={(value) => setDisaggMethod(value as DisaggMethod)}>
                      <SelectTrigger className="mt-1 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="current_plan">Current plan share</SelectItem>
                        <SelectItem value="statistical">Statistical share</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-text-tertiary">{DISAGG_METHOD_COPY[disaggMethod]}</p>
                  </label>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs">
                      <span className="text-text-tertiary">Week from</span>
                      <Select value={weekFrom} onValueChange={(v) => setWeekFrom(v ?? "")}>
                        <SelectTrigger className="mt-1 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {hierarchy.weeks.map((week) => (
                            <SelectItem key={week} value={week}>{formatWeek(week)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="block text-xs">
                      <span className="text-text-tertiary">Week to</span>
                      <Select value={weekTo} onValueChange={(v) => setWeekTo(v ?? "")}>
                        <SelectTrigger className="mt-1 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {hierarchy.weeks.map((week) => (
                            <SelectItem key={week} value={week}>{formatWeek(week)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  </div>

                  <label className="block text-xs">
                    <span className="text-text-tertiary">Reason code</span>
                    <Select value={reasonCode} onValueChange={(v) => setReasonCode(v ?? "")}>
                      <SelectTrigger className="mt-1 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {hierarchy.reasons.map((reason) => (
                          <SelectItem key={reason.REASON_CODE} value={reason.REASON_CODE}>
                            {reason.REASON_GROUP} · {reason.REASON_LABEL}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>

                  <label className="block text-xs">
                    <span className="text-text-tertiary">
                      Note {reasonNeedsNote ? <span className="text-warning">(required)</span> : null}
                    </span>
                    <Textarea
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      className="mt-1 min-h-20"
                      placeholder="Explain why the scenario should diverge from the committed plan."
                    />
                  </label>

                  <div className="flex justify-end">
                    <Button type="button" size="sm" onClick={handlePreview} disabled={!canPreview || previewLoading}>
                      <Network aria-hidden="true" />
                      {previewLoading ? "Previewing" : "Preview split"}
                    </Button>
                  </div>
                </div>

                {preview && (
                  <div className="space-y-3">
                    <div className={cn("rounded-lg border px-3 py-3", preview.outcome.feasible ? "border-border bg-muted/40" : "border-warning/40 bg-warning-subtle")}>
                      <div className="flex flex-wrap items-start justify-between gap-3 text-xs">
                        <div>
                          <p className="font-medium text-foreground">Target {formatUnits(preview.node.targetUnits)}</p>
                          <p className="mt-1 text-text-tertiary">
                            Current {formatUnits(preview.node.currentUnits)} · delta {formatUnits(preview.outcome.targetDelta)}
                          </p>
                        </div>
                        <div className="text-right text-text-tertiary">
                          <p>{preview.outcome.movedCount.toLocaleString("en-GB")} children move</p>
                          <p>{preview.outcome.lockedCount.toLocaleString("en-GB")} planner-locked · {preview.outcome.lockedLeafCount.toLocaleString("en-GB")} source-locked leaves</p>
                          <p>{preview.outcome.excludedCount.toLocaleString("en-GB")} excluded · {preview.outcome.clampedCount.toLocaleString("en-GB")} clamped</p>
                        </div>
                      </div>
                      {!preview.outcome.feasible && (
                        <div className="mt-2 inline-flex items-center gap-2 rounded-md bg-warning-subtle px-2 py-1 text-warning">
                          <AlertTriangle size={14} aria-hidden="true" />
                          <span>
                            Infeasible preview. Shortfall {formatUnits(preview.outcome.shortfall)} remains after locks and zero floors.
                          </span>
                        </div>
                      )}
                      {preview.outcome.agentEditsReplaced > 0 && (
                        <div className="mt-2 inline-flex items-start gap-2 rounded-md bg-warning-subtle px-2 py-1 text-warning">
                          <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                          <span>
                            Replaces {preview.outcome.agentEditsReplaced.toLocaleString("en-GB")}{" "}
                            accepted agent {preview.outcome.agentEditsReplaced === 1 ? "edit" : "edits"} in this
                            range. Those cells will be reattributed to you, so the
                            scenario will no longer credit the agent for them.
                          </span>
                        </div>
                      )}
                      {previewDirty && (
                        <div className="mt-2 inline-flex items-center gap-2 rounded-md bg-neutral-subtle px-2 py-1 text-neutral">
                          <AlertTriangle size={14} aria-hidden="true" />
                          <span>Form values changed after the preview. Run preview again before committing.</span>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="mb-2 flex items-baseline justify-between gap-2">
                        <div>
                          <h3 className="card-title">Child breakdown</h3>
                          <p className="text-xs text-text-tertiary">Lock a child to hold it fixed and let the rest absorb the change.</p>
                        </div>
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
                            <TableHead className="num">Lock</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.children.map((child) => (
                            <TableRow key={child.childId}>
                              <TableCell>
                                <div>
                                  <p className="font-medium">{child.childLabel}</p>
                                  <p className="text-xs text-text-tertiary">
                                    {child.movedLeafCount.toLocaleString("en-GB")} leaves move
                                    {child.lockedLeafCount > 0 ? ` · ${child.lockedLeafCount} source-locked` : ""}
                                  </p>
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
                              <TableCell className="num tabular-nums">
                                {child.shareOfChange === null ? "—" : formatSignedPercent(child.shareOfChange, 0)}
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {child.locked && <Badge className="bg-warning-subtle text-warning"><LockKeyhole aria-hidden="true" /> locked</Badge>}
                                  {child.excluded && <Badge className="bg-neutral-subtle text-neutral">0 share</Badge>}
                                  {child.clamped && <Badge className="bg-warning-subtle text-warning">floor at zero</Badge>}
                                  {!child.locked && !child.excluded && !child.clamped && <Badge className="bg-positive-subtle text-positive">moves</Badge>}
                                </div>
                              </TableCell>
                              <TableCell className="num">
                                <div className="inline-flex items-center gap-2">
                                  <Switch
                                    checked={lockedChildIds.has(child.childId)}
                                    onCheckedChange={(checked) => toggleLockedChild(child.childId, checked)}
                                    aria-label={`Lock ${child.childLabel}`}
                                  />
                                  <span className="text-xs text-text-tertiary">{lockedChildIds.has(child.childId) ? "Hold" : "Open"}</span>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs text-text-tertiary">
                        Commit recomputes the split on the server. The preview is advisory until you confirm it.
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={closeEditor}>
                          Cancel
                        </Button>
                        <Button type="button" size="sm" onClick={handleCommit} disabled={!canCommit || commitLoading}>
                          <CheckCircle2 aria-hidden="true" />
                          {commitLoading ? "Committing" : "Commit override"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {editorRow.hasEdits && editorRow.editGroups.length > 0 && (
                  <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                    <div>
                      <h3 className="card-title">Existing edit groups on this row</h3>
                      <p className="text-xs text-text-tertiary">Revert the whole parent action, not just one child row, so reconciliation stays intact.</p>
                    </div>
                    {editorRow.editGroups.map((group) => (
                      <div key={group.editGroupId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
                        <div>
                          <p className="font-medium">
                            {group.parentKey ?? editorRow.label} · {group.reasonLabel ?? "No reason"}
                          </p>
                          <p className="mt-1 text-text-tertiary">
                            {formatUnits(group.deltaUnits)} · {formatEur(group.deltaValueEur)} · {group.leafCount.toLocaleString("en-GB")} leaves · {formatDateTime(group.editedAt)}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleRevert(group.editGroupId)}
                          disabled={revertLoadingId === group.editGroupId}
                        >
                          <Eraser aria-hidden="true" />
                          {revertLoadingId === group.editGroupId ? "Reverting" : "Revert group"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>

        <Card className="p-4">
          <h2 className="card-title">Hierarchies</h2>
          <p className="text-xs text-text-tertiary">
            Each dimension rolls the same leaves up through one or more trees, so a total is the same whichever way it is rolled up. Pick one per dimension under Roll up by; the default is the original structure. Time is listed for reference and keeps its fiscal weeks here.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {DIMENSIONS.map((dimension) => (
              <div key={dimension}>
                <p className="text-xs font-medium">{DIMENSION_LABELS[dimension]}</p>
                <ul className="mt-2 space-y-2">
                  {hierarchiesFor(dimension, catalogue).map((tree) => (
                    <li key={tree.id} className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{tree.name}</span>
                        {tree.isDefault && <Badge className="bg-accent-subtle text-accent">Default</Badge>}
                      </div>
                      {tree.description && <p className="mt-1 text-text-tertiary">{tree.description}</p>}
                      <p className="mt-1 text-text-tertiary">
                        {tree.levels
                          .map((entry) => (entry.nodeCount === undefined
                            ? entry.label
                            : `${entry.label} (${entry.nodeCount.toLocaleString("en-GB")})`))
                          .join(" › ")}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create draft scenario</DialogTitle>
            <DialogDescription>
              Hierarchy overrides cannot write straight onto the committed plan. Create a draft first, then preview and commit inside that branch.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-xs">
              <span className="text-text-tertiary">Scenario name</span>
              <Input value={createName} onChange={(event) => setCreateName(event.target.value)} className="mt-1" />
            </label>
            <label className="block text-xs">
              <span className="text-text-tertiary">Description</span>
              <Textarea value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} className="mt-1 min-h-20" />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleCreateScenario} disabled={creatingScenario || createName.trim().length === 0}>
              <GitBranch aria-hidden="true" />
              {creatingScenario ? "Creating" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}