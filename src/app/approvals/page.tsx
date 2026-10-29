"use client";

import * as React from "react";
import Link from "next/link";
import { Stamp, Lock, History, Send, ShieldCheck } from "lucide-react";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { STATUS_CLASSES, formatUnits, formatEur } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ROLE_LABELS, STATUS_LABELS, type ApprovalAction, type RequestStatus, type RoleId } from "@/lib/workflow";

interface HistoryRow {
  ACTION_ID: string;
  ACTION: string;
  TO_STATUS: string;
  ACTOR_NAME: string | null;
  ACTOR_USER_ID: string;
  ACTOR_SF_USER: string;
  NOTE: string | null;
  ACTED_AT: string;
}

interface RequestRow {
  REQUEST_ID: string;
  OBJECT_TYPE: "scenario_promote" | "stream_submission" | "cycle_signoff";
  OBJECT_ID: string;
  CYCLE_WEEK: string;
  STATUS: RequestStatus;
  CHAIN_LABEL: string;
  NEXT_ROLE_LABEL: string | null;
  TITLE: string;
  REQUESTED_BY_NAME: string | null;
  REQUESTED_AT: string;
  DECIDED_AT: string | null;
  summary: Record<string, unknown> | null;
  actions: ApprovalAction[];
  history: HistoryRow[];
}

interface CycleRow {
  CYCLE_WEEK: string;
  STATUS: string;
  SIGNED_OFF_BY: string | null;
  SIGNED_OFF_AT: string | null;
  SNAPSHOT_ROWS: number | null;
  SNAPSHOT_SOURCE: string | null;
  IS_CURRENT: boolean;
}

interface Payload {
  persona: { userId: string; displayName: string; roleId: RoleId; roleLabel: string };
  requests: RequestRow[];
  cycles: CycleRow[];
  currentCycle: CycleRow | null;
}

const TYPE_LABEL: Record<RequestRow["OBJECT_TYPE"], string> = {
  scenario_promote: "Scenario promotion",
  stream_submission: "Stream input",
  cycle_signoff: "Cycle sign-off",
};

const ACTION_LABEL: Record<ApprovalAction, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  reject: "Reject",
  withdraw: "Withdraw",
};

const ACTION_CONSEQUENCE: Record<RequestRow["OBJECT_TYPE"], string> = {
  scenario_promote:
    "Approving writes every edit in this scenario into the committed plan, after re-checking that none of the edited cells has moved or been locked.",
  stream_submission:
    "Approving accepts this input into the consensus. It then shows in the plan's contribution waterfall.",
  cycle_signoff:
    "Approving freezes a copy of the committed plan as this cycle's sign-off. Nothing more can be promoted or accepted until the next cycle opens.",
};

const HISTORY_VERB: Record<string, string> = {
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  request_changes: "requested changes",
  withdraw: "withdrew",
};

function formatStamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The two or three figures an approver needs, per request type. */
function SummaryFacts({ row }: { row: RequestRow }) {
  const s = row.summary ?? {};
  const facts: Array<[string, string]> = [];
  if (row.OBJECT_TYPE === "scenario_promote") {
    facts.push(["Cells edited", (num(s.editCount) ?? 0).toLocaleString("en-GB")]);
    facts.push(["Series", (num(s.seriesEdited) ?? 0).toLocaleString("en-GB")]);
    facts.push(["Change vs plan", `${formatUnits(num(s.deltaUnits))} units`]);
    facts.push(["Value moved", formatEur(num(s.deltaValueEur))]);
    if ((num(s.agentEdits) ?? 0) > 0) facts.push(["From agent", (num(s.agentEdits) ?? 0).toLocaleString("en-GB")]);
  } else if (row.OBJECT_TYPE === "stream_submission") {
    facts.push(["Stream", String(s.streamId ?? "—")]);
    facts.push(["Node", String(s.node ?? "—")]);
    facts.push(["Weeks", `${s.weekFrom ?? "?"} to ${s.weekTo ?? "?"}`]);
    facts.push(["Change", `${formatUnits(num(s.appliedDeltaUnits))} units`]);
    facts.push(["Cells", (num(s.cellsMoved) ?? 0).toLocaleString("en-GB")]);
  } else {
    facts.push(["Horizon", String(s.horizon ?? "—")]);
    facts.push(["Plan", `${formatUnits(num(s.planUnits))} units`]);
    facts.push(["Overridden cells", (num(s.overriddenCells) ?? 0).toLocaleString("en-GB")]);
    facts.push([
      `vs ${s.lastSignoffCycle ?? "last sign-off"}`,
      num(s.deltaVsLastSignoffUnits) != null
        ? `${formatUnits(num(s.deltaVsLastSignoffUnits))} units`
        : s.lastSignoffCycle
          ? "Did not reach this horizon"
          : "No earlier sign-off",
    ]);
  }
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3 xl:grid-cols-5">
      {facts.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-text-tertiary">{label}</dt>
          <dd className="num truncate font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RequestCard({ row, onAct }: { row: RequestRow; onAct: (row: RequestRow, action: ApprovalAction, note: string) => Promise<string | null> }) {
  const [pending, setPending] = React.useState<ApprovalAction | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const noteRequired = pending === "reject" || pending === "request_changes";

  const confirm = async () => {
    if (!pending) return;
    if (noteRequired && !note.trim()) {
      setError("Say why: a rejection or change request needs a note.");
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onAct(row, pending, note);
    setBusy(false);
    if (failure) setError(failure);
    else {
      setPending(null);
      setNote("");
    }
  };

  const objectLink =
    row.OBJECT_TYPE === "scenario_promote" ? `/scenarios?scenario=${row.OBJECT_ID}` : row.OBJECT_TYPE === "stream_submission" ? "/plan" : "/plan";

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-tertiary">
            <span className="uppercase">{TYPE_LABEL[row.OBJECT_TYPE]}</span>
            <span>·</span>
            <span>Cycle {row.CYCLE_WEEK}</span>
          </div>
          <h3 className="mt-0.5 text-sm font-semibold">
            <Link href={objectLink} className="hover:underline">{row.TITLE}</Link>
          </h3>
          <p className="text-xs text-text-tertiary">
            {row.REQUESTED_BY_NAME ?? "Unknown"} · {formatStamp(row.REQUESTED_AT)}
            {row.STATUS === "submitted" && row.NEXT_ROLE_LABEL ? ` · waiting on ${row.NEXT_ROLE_LABEL}` : ""}
          </p>
        </div>
        <Badge className={cn("shrink-0", STATUS_CLASSES[row.STATUS])}>{STATUS_LABELS[row.STATUS]}</Badge>
      </div>

      <SummaryFacts row={row} />

      <ol className="space-y-1 border-l border-border pl-3 text-xs" aria-label="Request history">
        {row.history.map((entry) => (
          <li key={entry.ACTION_ID}>
            <span className="font-medium">{entry.ACTOR_NAME ?? entry.ACTOR_USER_ID}</span>{" "}
            {HISTORY_VERB[entry.ACTION] ?? entry.ACTION}{" "}
            <span className="text-text-tertiary">{formatStamp(entry.ACTED_AT)} · via {entry.ACTOR_SF_USER}</span>
            {entry.NOTE && <span className="block text-neutral">“{entry.NOTE}”</span>}
          </li>
        ))}
      </ol>

      {row.actions.length > 0 && !pending && (
        <div className="flex flex-wrap gap-2">
          {row.actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "approve" ? "default" : action === "reject" ? "destructive" : "outline"}
              onClick={() => {
                setPending(action);
                setError(null);
              }}
            >
              {ACTION_LABEL[action]}
            </Button>
          ))}
        </div>
      )}

      {pending && (
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs">
            <span className="font-medium">{ACTION_LABEL[pending]}:</span>{" "}
            {pending === "approve"
              ? ACTION_CONSEQUENCE[row.OBJECT_TYPE]
              : pending === "withdraw"
                ? "The item goes back to being editable. Nothing in the plan changes."
                : "The item goes back to its owner to revise. Nothing in the plan changes."}
          </p>
          <label className="block text-xs">
            <span className="text-text-tertiary">Note{noteRequired ? " (required)" : " (optional)"}</span>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="mt-1 min-h-16 text-sm"
              maxLength={600}
            />
          </label>
          {error && <p className="text-xs text-negative" role="alert">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void confirm()} disabled={busy}>
              {busy ? "Working…" : `Confirm ${ACTION_LABEL[pending].toLowerCase()}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function CycleCard({ data, onRequestSignoff }: { data: Payload; onRequestSignoff: (note: string) => Promise<string | null> }) {
  const cycle = data.currentCycle;
  const lastSigned = data.cycles.find((row) => row.STATUS === "signed_off");
  const canRequest = data.persona.roleId === "demand_lead" && cycle?.STATUS === "open";
  const openItems = data.requests.filter(
    (row) => row.STATUS === "submitted" && row.CYCLE_WEEK === cycle?.CYCLE_WEEK && row.OBJECT_TYPE !== "cycle_signoff",
  ).length;
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase text-text-tertiary">Current S&amp;OP cycle</p>
          <p className="font-display text-xl font-semibold">{cycle?.CYCLE_WEEK ?? "—"}</p>
          <p className="text-xs text-text-tertiary">
            Last sign-off: {lastSigned ? `${lastSigned.CYCLE_WEEK} by ${lastSigned.SIGNED_OFF_BY ?? "—"}${lastSigned.SNAPSHOT_SOURCE === "backfill" ? " (reconstructed)" : ""}` : "none yet"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cycle?.STATUS === "signed_off" && <Lock size={14} className="text-positive" aria-hidden="true" />}
          <Badge className={STATUS_CLASSES[cycle?.STATUS ?? ""]}>{(cycle?.STATUS ?? "unknown").replace("_", " ")}</Badge>
        </div>
      </div>
      <p className="text-xs text-neutral">
        {cycle?.STATUS === "signed_off"
          ? "This cycle is signed off and the committed plan is frozen until the next cycle opens."
          : cycle?.STATUS === "in_review"
            ? "Sign-off has been requested. Promotions and stream acceptances are paused until the S&OP lead decides."
            : openItems > 0
              ? `${openItems} promotion or stream request(s) are still open. They must be decided before sign-off can be requested.`
              : "Nothing is waiting. The demand lead can request sign-off."}
      </p>
      {canRequest && !open && (
        <Button size="sm" onClick={() => setOpen(true)} disabled={openItems > 0}>
          <Send size={13} aria-hidden="true" /> Request sign-off
        </Button>
      )}
      {open && (
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs">
            The cycle moves to review. The S&amp;OP lead then approves, which freezes a snapshot of the committed plan.
          </p>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note for the S&OP lead (optional)" className="min-h-16 text-sm" maxLength={600} />
          {error && <p className="text-xs text-negative" role="alert">{error}</p>}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const failure = await onRequestSignoff(note);
                setBusy(false);
                if (failure) setError(failure);
                else setOpen(false);
              }}
            >
              {busy ? "Submitting…" : "Confirm request"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

type Filter = "mine" | "open" | "all";

export default function ApprovalsPage() {
  const [data, setData] = React.useState<Payload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<Filter>("mine");
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load approvals");
      setData(json);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const act = async (row: RequestRow, action: ApprovalAction, note: string): Promise<string | null> => {
    const res = await fetch(`/api/approvals/${row.REQUEST_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, note, confirm: true }),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) return json.error ?? "The action failed.";
    setNotice(
      action === "approve" && row.OBJECT_TYPE === "scenario_promote"
        ? `Approved. ${json.rowsApplied ?? 0} plan cell(s) updated.`
        : action === "approve" && row.OBJECT_TYPE === "cycle_signoff"
          ? `Signed off. ${(json.rowsApplied ?? 0).toLocaleString("en-GB")} plan rows frozen as the snapshot.`
          : `${ACTION_LABEL[action]}: done.`,
    );
    await load();
    return null;
  };

  const requestSignoff = async (note: string): Promise<string | null> => {
    const res = await fetch("/api/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectType: "cycle_signoff", note, confirm: true }),
    });
    const json = await res.json();
    if (!res.ok) return json.error ?? "Could not request sign-off.";
    setNotice("Sign-off requested.");
    await load();
    return null;
  };

  if (error && !data) {
    return (
      <div className="p-6">
        <Card className="p-4 text-sm text-negative" role="alert">{error}</Card>
      </div>
    );
  }
  if (!data) return <div className="p-6"><PageSkeleton kpis={3} chart={false} rows={6} /></div>;

  const mine = data.requests.filter((row) => row.STATUS === "submitted" && row.actions.some((a) => a !== "withdraw"));
  const visible =
    filter === "mine" ? mine : filter === "open" ? data.requests.filter((row) => row.STATUS === "submitted") : data.requests;
  const counts = {
    mine: mine.length,
    open: data.requests.filter((row) => row.STATUS === "submitted").length,
    all: data.requests.length,
  };

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Governance"
        headline="Approvals"
        subtitle="Nothing reaches the committed plan or the consensus without a second person's approval. Scenario promotions and stream inputs go to the demand planning lead; the cycle sign-off goes to the S&OP lead."
        icon={<Stamp size={18} aria-hidden="true" />}
        metadata={
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span>
              Acting as <span className="font-medium">{data.persona.displayName}</span> ({ROLE_LABELS[data.persona.roleId]})
            </span>
            <span>{counts.mine} waiting on you</span>
          </div>
        }
      />

      <Card className="flex items-start gap-2 p-3 text-xs text-neutral">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          Personas are simulated for the demo: the app connects to Snowflake as one user, so who is acting is chosen in the sidebar.
          The rules are still enforced on the server, including that no one can approve their own request. Each action records the
          persona and the Snowflake user.
        </span>
      </Card>

      {notice && (
        <Card className="p-3 text-sm text-positive" role="status">{notice}</Card>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-3" aria-label="Approval requests">
          <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
            <TabsList>
              <TabsTrigger value="mine">For me ({counts.mine})</TabsTrigger>
              <TabsTrigger value="open">All open ({counts.open})</TabsTrigger>
              <TabsTrigger value="all">History ({counts.all})</TabsTrigger>
            </TabsList>
          </Tabs>
          {visible.length === 0 ? (
            <Card className="p-6 text-center text-sm text-text-tertiary">
              {filter === "mine"
                ? `Nothing is waiting on the ${data.persona.roleLabel.toLowerCase()}.`
                : "No requests yet. Submit a scenario from Scenarios, or a stream input from Consensus plan."}
            </Card>
          ) : (
            visible.map((row) => <RequestCard key={row.REQUEST_ID} row={row} onAct={act} />)
          )}
        </section>

        <aside className="space-y-4" aria-label="Cycle">
          <CycleCard data={data} onRequestSignoff={requestSignoff} />
          <Card className="space-y-2 p-4">
            <p className="flex items-center gap-1.5 text-[11px] uppercase text-text-tertiary">
              <History size={12} aria-hidden="true" /> Signed-off cycles
            </p>
            {data.cycles.filter((row) => row.STATUS === "signed_off").length === 0 ? (
              <p className="text-xs text-text-tertiary">None yet.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {data.cycles
                  .filter((row) => row.STATUS === "signed_off")
                  .map((row) => (
                    <li key={row.CYCLE_WEEK} className="flex justify-between gap-2">
                      <span className="font-medium">{row.CYCLE_WEEK}</span>
                      <span className="text-text-tertiary">
                        {row.SNAPSHOT_SOURCE === "backfill" ? "reconstructed" : row.SIGNED_OFF_BY ?? "—"} ·{" "}
                        <span className="num">{(row.SNAPSHOT_ROWS ?? 0).toLocaleString("en-GB")}</span> rows
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
