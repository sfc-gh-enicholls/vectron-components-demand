"use client";

import * as React from "react";
import {
  ComposedChart, Area, Line, Bar, BarChart, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";
import {
  ClipboardCheck, AlertTriangle, TrendingUp, TrendingDown, Minus, Lock,
  Check, Info,
} from "lucide-react";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
import { Sparkline } from "@/components/sparkline";
import { WhyThis } from "@/components/why-this";
import { AgentRecommendationLink } from "@/components/agent-recommendation-link";
import { Card } from "@/components/ui/card";
import {
  formatUnits, formatEur, formatSignedPercent, formatWeekShort,
  SEGMENT_CLASSES, STATUS_CLASSES, CHART_COLORS,
} from "@/lib/format";
import { cn } from "@/lib/utils";

interface Exception {
  SERIES_ID: string; SERIES_LABEL: string; PRODUCT_NAME: string;
  CUSTOMER_NAME: string; CHANNEL_NAME: string; CATEGORY_NAME: string;
  SEGMENT_ABC: string; SEGMENT_XYZ: string;
  PLAN_UNITS_8WK: number; STAT_UNITS_8WK: number; NAIVE_UNITS_8WK: number;
  GAP_UNITS: number; GAP_VALUE_EUR: number; GAP_PCT: number;
  REASON_CODE: string | null; REASON_LABEL: string | null;
  PLANNER: string | null; ANY_LOCKED: boolean;
  agentRecommendation: {
    proposalId: string;
    priority: string;
    proposalType: string;
    confidence: number;
  } | null;
}

interface Driver {
  DRIVER: string; DRIVER_LABEL: string; DRIVER_ORDER: number;
  CONTRIB_UNITS: number; IS_MODELLED_INPUT: boolean;
}

interface Reason {
  REASON_CODE: string; REASON_LABEL: string; REASON_GROUP: string;
  REQUIRES_NOTE: boolean;
}

interface Detail {
  series: {
    SERIES_ID: string; SERIES_LABEL: string; PRODUCT_NAME: string;
    CUSTOMER_NAME: string; CHANNEL_NAME: string; CATEGORY_NAME: string;
    PRICE_TIER: string; SEGMENT_ABC: string; SEGMENT_XYZ: string;
    LIFECYCLE_STATUS: string; BASE_ANNUAL_UNITS: number;
    BASE_ANNUAL_VALUE_EUR: number; UNIT_PRICE_EUR: number;
  };
  targetWeek: string;
  history: Array<{
    WEEK_ID: string; POS_UNITS: number; SHIP_UNITS: number | null;
    STOCK_UNITS: number | null; WEEKS_OF_COVER: number | null;
    PROMO_FLAG: boolean; LOST_SALES_UNITS: number;
  }>;
  forward: Array<{
    WEEK_ID: string; STAT_UNITS: number; OVERRIDE_UNITS: number | null;
    PLAN_UNITS: number; NAIVE_UNITS: number | null;
    LOWER_95: number | null; UPPER_95: number | null; LAG_WEEKS: number;
    REASON_LABEL: string | null; PLANNER: string | null; IS_LOCKED: boolean;
  }>;
  drivers: Driver[];
  promos: Array<{
    PROMO_ID: string; START_WEEK_ID: string; END_WEEK_ID: string;
    MECHANIC: string; DEPTH_PCT: number;
    PLANNED_UPLIFT_PCT: number; ACTUAL_UPLIFT_PCT: number | null;
  }>;
  driverTotal: number;
  actual: number | null;
  reconciles: boolean | null;
  agentRecommendation: {
    proposalId: string;
    priority: string;
    proposalType: string;
    confidence: number;
  } | null;
}

interface ReviewData {
  context: { HISTORY_END_WEEK: string; CURRENT_WEEK: string };
  worklist: Exception[];
  reasons: Reason[];
  detail: Detail | null;
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

export default function ReviewPage() {
  const [data, setData] = React.useState<ReviewData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [week, setWeek] = React.useState<string | null>(null);

  // Override form
  const [ovWeek, setOvWeek] = React.useState<string>("");
  const [ovValue, setOvValue] = React.useState<string>("");
  const [ovReason, setOvReason] = React.useState<string>("");
  const [ovNote, setOvNote] = React.useState<string>("");
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const load = React.useCallback(async (seriesId: string | null, wk: string | null) => {
    const qs = new URLSearchParams();
    if (seriesId) qs.set("series", seriesId);
    if (wk) qs.set("week", wk);
    const res = await fetch(`/api/review?${qs.toString()}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Failed to load");
    return json as ReviewData;
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await load(selected, week);
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [selected, week, load]);

  const submitOverride = async () => {
    if (!data?.detail) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seriesId: data.detail.series.SERIES_ID,
          weekId: ovWeek,
          overrideUnits: Number(ovValue),
          reasonCode: ovReason,
          note: ovNote,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveMsg({ ok: false, text: json.error ?? "Failed to save" });
      } else {
        setSaveMsg({
          ok: true,
          text: `Override for ${ovWeek} saved to the “${json.scenario?.name ?? "Exception review"}” scenario. The committed plan is unchanged until that scenario is submitted and approved.`,
        });
        setOvValue(""); setOvNote("");
        const refreshed = await load(selected, week);
        setData(refreshed);
      }
    } catch (e) {
      setSaveMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-negative/40 bg-negative-subtle p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium text-negative">Could not load demand review</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!data) return <div className="p-6"><PageSkeleton kpis={0} chart rows={12} /></div>;

  const { worklist, reasons, detail, context } = data;
  const selectedReason = reasons.find((r) => r.REASON_CODE === ovReason);

  // ---- waterfall assembly -------------------------------------------
  // Recharts has no waterfall type. A transparent spacer bar carries each
  // step to its starting height, then the visible bar shows the delta.
  let running = 0;
  const waterfall = (detail?.drivers ?? []).map((d) => {
    const v = Number(d.CONTRIB_UNITS);
    const start = d.DRIVER === "BASE" ? 0 : running;
    running = d.DRIVER === "BASE" ? v : running + v;
    return {
      name: d.DRIVER === "BASE" ? "Base" : d.DRIVER_LABEL,
      label: d.DRIVER_LABEL,
      spacer: v >= 0 ? start : start + v,
      delta: Math.abs(v),
      signed: v,
      isBase: d.DRIVER === "BASE",
      modelled: d.IS_MODELLED_INPUT,
    };
  });

  const chartData = [
    ...(detail?.history ?? []).map((h) => ({
      WEEK_ID: h.WEEK_ID,
      POS: Number(h.POS_UNITS),
      PLAN: null as number | null,
      BAND_BASE: null as number | null,
      BAND_SPAN: null as number | null,
    })),
    ...(detail?.forward ?? []).map((f) => ({
      WEEK_ID: f.WEEK_ID,
      POS: null as number | null,
      PLAN: Number(f.PLAN_UNITS),
      BAND_BASE: f.LOWER_95 !== null ? Number(f.LOWER_95) : null,
      BAND_SPAN:
        f.LOWER_95 !== null && f.UPPER_95 !== null
          ? Number(f.UPPER_95) - Number(f.LOWER_95)
          : null,
    })),
  ];

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Exception workbench"
        headline="Demand review"
        subtitle={`Every number decomposes into its drivers. Actuals to ${context.HISTORY_END_WEEK}.`}
        icon={<ClipboardCheck size={18} aria-hidden="true" />}
      />

      <div className="grid gap-4 xl:grid-cols-5">
        {/* ---------------- Worklist ---------------- */}
        <Card className="xl:col-span-2 p-4">
          <div className="mb-3">
            <h2 className="card-title">Worklist</h2>
            <p className="text-xs text-text-tertiary">
              Ranked by the value of the gap between plan and model over 8 weeks
            </p>
          </div>
          <div className="max-h-[28rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border text-xs text-text-tertiary">
                  <th className="py-2 text-left font-medium">Series</th>
                  <th className="num py-2 font-medium">Gap</th>
                  <th className="num py-2 font-medium">Value</th>
                  <th className="py-2 text-left font-medium">Agent</th>
                </tr>
              </thead>
              <tbody>
                {worklist.slice(0, 80).map((e) => (
                  <tr
                    key={e.SERIES_ID}
                    className={cn(
                      "cursor-pointer border-b border-border/50 transition-colors hover:bg-accent-subtle/40",
                      selected === e.SERIES_ID && "bg-accent-subtle",
                    )}
                    onClick={() => { setSelected(e.SERIES_ID); setWeek(null); }}
                  >
                    <td className="py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{e.PRODUCT_NAME}</span>
                        {e.ANY_LOCKED && (
                          <Lock size={11} className="text-text-tertiary" aria-label="Contains locked weeks" />
                        )}
                      </div>
                      <span className="text-xs text-text-tertiary">
                        {e.CUSTOMER_NAME} · {e.CHANNEL_NAME}
                      </span>
                    </td>
                    <td className="num py-2 tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <Direction value={Number(e.GAP_PCT)} />
                        {formatSignedPercent(Number(e.GAP_PCT))}
                      </span>
                    </td>
                    <td className="num py-2 tabular-nums text-xs">
                      {formatEur(Number(e.GAP_VALUE_EUR))}
                    </td>
                    <td className="py-2 text-xs">
                      {e.agentRecommendation ? (
                        <AgentRecommendationLink
                          proposalId={e.agentRecommendation.proposalId}
                          priority={e.agentRecommendation.priority}
                          proposalType={e.agentRecommendation.proposalType}
                          confidence={e.agentRecommendation.confidence}
                          compact
                        />
                      ) : (
                        <span className="text-text-tertiary">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* ---------------- Detail ---------------- */}
        <div className="space-y-4 xl:col-span-3">
          {!detail ? (
            <Card className="p-8 text-center">
              <ClipboardCheck size={22} className="mx-auto text-text-tertiary" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium">Select a series to review</p>
              <p className="mt-1 text-xs text-text-tertiary">
                The worklist on the left is ordered by how much value is at stake
                in the difference between the committed plan and the model.
              </p>
            </Card>
          ) : (
            <>
              <Card className="p-4">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h2 className="card-title">
                      {detail.series.PRODUCT_NAME}
                      <span className="font-normal text-text-tertiary">
                        {" · "}{detail.series.CUSTOMER_NAME}{" · "}{detail.series.CHANNEL_NAME}
                      </span>
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px]", SEGMENT_CLASSES[detail.series.SEGMENT_ABC])}>
                        {detail.series.SEGMENT_ABC}{detail.series.SEGMENT_XYZ}
                      </span>
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px]", STATUS_CLASSES[detail.series.LIFECYCLE_STATUS] ?? "")}>
                        {detail.series.LIFECYCLE_STATUS}
                      </span>
                      <span className="text-text-tertiary">
                        {detail.series.PRICE_TIER} · {formatEur(Number(detail.series.UNIT_PRICE_EUR))}/case
                      </span>
                      {detail.agentRecommendation && (
                        <AgentRecommendationLink
                          proposalId={detail.agentRecommendation.proposalId}
                          priority={detail.agentRecommendation.priority}
                          proposalType={detail.agentRecommendation.proposalType}
                          confidence={detail.agentRecommendation.confidence}
                        />
                      )}
                    </div>
                  </div>
                  <Sparkline
                    data={detail.history.map((h) => Number(h.POS_UNITS))}
                    width={90} height={24} stroke={CHART_COLORS[0]}
                    label="78-week pull trend"
                  />
                </div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                      <XAxis
                        dataKey="WEEK_ID" tickFormatter={formatWeekShort}
                        tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                        interval={9} stroke="var(--chart-grid)"
                      />
                      <YAxis
                        tickFormatter={(v) => formatUnits(v).replace(" pcs", "")}
                        tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                        stroke="var(--chart-grid)" width={48}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--border)",
                          borderRadius: 6, fontSize: 12,
                        }}
                        formatter={(value, name) =>
                          value === null || value === undefined
                            ? ["—", name]
                            : [formatUnits(Number(value)), name]
                        }
                      />
                      <ReferenceLine
                        x={context.CURRENT_WEEK} stroke="var(--chart-grid)"
                        strokeDasharray="3 3"
                      />
                      <Area dataKey="BAND_BASE" stackId="b" stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
                      <Area dataKey="BAND_SPAN" stackId="b" stroke="none" fill="var(--chart-band)" name="95% interval" isAnimationActive={false} />
                      <Line dataKey="POS" name="Pull" stroke={CHART_COLORS[0]} strokeWidth={1.75} dot={false} connectNulls={false} isAnimationActive={false} />
                      <Line dataKey="PLAN" name="Plan" stroke={CHART_COLORS[1]} strokeWidth={1.75} strokeDasharray="4 3" dot={false} connectNulls={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              {/* ---------------- Driver waterfall ---------------- */}
              <Card className="p-4">
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="card-title">
                    Why {formatUnits(detail.actual ?? 0)} in {detail.targetWeek}
                  </h2>
                  <select
                    value={detail.targetWeek}
                    onChange={(e) => setWeek(e.target.value)}
                    className="rounded-md border border-border bg-card px-2 py-1 text-xs"
                    aria-label="Week to decompose"
                  >
                    {detail.history.slice(-26).reverse().map((h) => (
                      <option key={h.WEEK_ID} value={h.WEEK_ID}>{h.WEEK_ID}</option>
                    ))}
                  </select>
                </div>
                <p className="mb-3 text-xs text-text-tertiary">
                  Contributions are additive and sum exactly to the actual. The
                  decomposition is sequential, so each driver carries its
                  incremental effect given the drivers before it — the order is
                  fixed and the split is not symmetric.
                </p>

                {detail.reconciles === false && (
                  <div className="mb-3 flex items-start gap-2 rounded-md bg-negative-subtle p-2 text-xs">
                    <AlertTriangle size={13} className="mt-0.5 text-negative" aria-hidden="true" />
                    <span className="text-negative">
                      Drivers sum to {formatUnits(detail.driverTotal)} but the actual is{" "}
                      {formatUnits(detail.actual ?? 0)}. This decomposition is unreliable.
                    </span>
                  </div>
                )}

                <div className="h-60">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={waterfall} margin={{ top: 4, right: 8, left: 0, bottom: 44 }}>
                      <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                      <XAxis
                        dataKey="name" tick={{ fontSize: 9, fill: "var(--text-tertiary)" }}
                        angle={-35} textAnchor="end" interval={0} height={44}
                        stroke="var(--chart-grid)"
                      />
                      <YAxis
                        tickFormatter={(v) => formatUnits(v).replace(" pcs", "")}
                        tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                        stroke="var(--chart-grid)" width={48}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--border)",
                          borderRadius: 6, fontSize: 12,
                        }}
                        formatter={(_v, _n, item) => {
                          const p = item?.payload as (typeof waterfall)[number] | undefined;
                          if (!p) return ["—", ""];
                          return [
                            `${p.signed >= 0 ? "+" : ""}${formatUnits(p.signed)}`,
                            p.label + (p.modelled ? " (modelled input)" : ""),
                          ];
                        }}
                      />
                      <ReferenceLine y={0} stroke="var(--chart-grid)" />
                      <Bar dataKey="spacer" stackId="w" fill="transparent" isAnimationActive={false} />
                      <Bar dataKey="delta" stackId="w" isAnimationActive={false}>
                        {waterfall.map((d, i) => (
                          <Cell
                            key={i}
                            fill={
                              d.isBase
                                ? "var(--chart-1)"
                                : d.signed >= 0
                                  ? "var(--positive)"
                                  : "var(--negative)"
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <ul className="mt-2 space-y-0.5">
                  {waterfall.filter((d) => !d.isBase && Math.abs(d.signed) > 0.5)
                    .sort((a, b) => Math.abs(b.signed) - Math.abs(a.signed))
                    .slice(0, 5)
                    .map((d) => (
                      <li key={d.label} className="flex items-baseline justify-between text-xs">
                        <span className="text-text-tertiary">
                          {d.label}
                          {d.modelled && (
                            <span className="ml-1 rounded bg-neutral-subtle px-1 text-[10px] text-neutral">
                              modelled
                            </span>
                          )}
                        </span>
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <Direction value={d.signed} />
                          {d.signed >= 0 ? "+" : ""}{formatUnits(d.signed)}
                        </span>
                      </li>
                    ))}
                </ul>
              </Card>

              {/* ---------------- Override ---------------- */}
              <Card className="p-4">
                <h2 className="card-title">Propose an override</h2>
                <p className="mt-0.5 text-xs text-text-tertiary">
                  Overrides collect in this cycle’s Exception review scenario and reach the committed plan only
                  once it is approved. A reason code is mandatory: overrides are scored against outturn on the
                  accuracy page, so an unexplained change cannot be learned from.
                </p>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="text-xs">
                    <span className="text-text-tertiary">Week</span>
                    <select
                      value={ovWeek}
                      onChange={(e) => {
                        setOvWeek(e.target.value);
                        const row = detail.forward.find((f) => f.WEEK_ID === e.target.value);
                        if (row) setOvValue(String(Math.round(Number(row.PLAN_UNITS))));
                      }}
                      className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5"
                    >
                      <option value="">Select a week…</option>
                      {detail.forward.map((f) => (
                        <option key={f.WEEK_ID} value={f.WEEK_ID} disabled={f.IS_LOCKED}>
                          {f.WEEK_ID} — model {Math.round(Number(f.STAT_UNITS)).toLocaleString("en-GB")}
                          {f.IS_LOCKED ? " (locked)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="text-xs">
                    <span className="text-text-tertiary">Override (pcs)</span>
                    <input
                      type="number" min={0} value={ovValue}
                      onChange={(e) => setOvValue(e.target.value)}
                      className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 tabular-nums"
                    />
                  </label>

                  <label className="text-xs">
                    <span className="text-text-tertiary">Reason</span>
                    <select
                      value={ovReason}
                      onChange={(e) => setOvReason(e.target.value)}
                      className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5"
                    >
                      <option value="">Select a reason…</option>
                      {reasons.map((r) => (
                        <option key={r.REASON_CODE} value={r.REASON_CODE}>
                          {r.REASON_GROUP} — {r.REASON_LABEL}
                          {r.REQUIRES_NOTE ? " *" : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="text-xs">
                    <span className="text-text-tertiary">
                      Note {selectedReason?.REQUIRES_NOTE && (
                        <span className="text-warning">(required)</span>
                      )}
                    </span>
                    <input
                      type="text" value={ovNote}
                      onChange={(e) => setOvNote(e.target.value)}
                      placeholder="What do you know that the model does not?"
                      className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5"
                    />
                  </label>
                </div>

                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={submitOverride}
                    disabled={saving || !ovWeek || !ovValue || !ovReason}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-on transition-opacity disabled:opacity-40"
                  >
                    {saving ? "Committing…" : "Commit override"}
                  </button>
                  {saveMsg && (
                    <span className={cn(
                      "inline-flex items-center gap-1 text-xs",
                      saveMsg.ok ? "text-positive" : "text-negative",
                    )}>
                      {saveMsg.ok
                        ? <Check size={13} aria-hidden="true" />
                        : <AlertTriangle size={13} aria-hidden="true" />}
                      {saveMsg.text}
                    </span>
                  )}
                </div>
              </Card>

              {/* ---------------- Promotions ---------------- */}
              <Card className="p-4">
                <h2 className="card-title">Recent trade campaigns</h2>
                <p className="mt-0.5 text-xs text-text-tertiary">
                  Planned versus realised uplift from aftermarket campaigns. A persistent
                  gap means the campaign assumption, not the baseline, is what needs fixing.
                </p>
                {detail.promos.length === 0 ? (
                  <p className="mt-3 text-xs text-text-tertiary">
                    No trade campaigns for this series. OE call-offs are not promoted.
                  </p>
                ) : (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-xs text-text-tertiary">
                          <th className="py-1.5 text-left font-medium">Weeks</th>
                          <th className="py-1.5 text-left font-medium">Mechanic</th>
                          <th className="num py-1.5 font-medium">Depth</th>
                          <th className="num py-1.5 font-medium">Planned</th>
                          <th className="num py-1.5 font-medium">Actual</th>
                          <th className="num py-1.5 font-medium">Delta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.promos.map((p) => {
                          const planned = Number(p.PLANNED_UPLIFT_PCT);
                          const actual = p.ACTUAL_UPLIFT_PCT === null
                            ? null : Number(p.ACTUAL_UPLIFT_PCT);
                          const delta = actual === null ? null : actual - planned;
                          return (
                            <tr key={p.PROMO_ID} className="border-b border-border/50">
                              <td className="py-1.5 text-xs">
                                {p.START_WEEK_ID}
                                {p.END_WEEK_ID !== p.START_WEEK_ID && ` – ${p.END_WEEK_ID}`}
                              </td>
                              <td className="py-1.5 text-xs">
                                {p.MECHANIC.toLowerCase().replace(/_/g, " ")}
                              </td>
                              <td className="num py-1.5 tabular-nums">
                                {(Number(p.DEPTH_PCT) * 100).toFixed(0)}%
                              </td>
                              <td className="num py-1.5 tabular-nums">
                                {(planned * 100).toFixed(0)}%
                              </td>
                              <td className="num py-1.5 tabular-nums">
                                {actual === null
                                  ? <span className="text-text-tertiary">pending</span>
                                  : `${(actual * 100).toFixed(0)}%`}
                              </td>
                              <td className="num py-1.5 tabular-nums">
                                {delta === null ? (
                                  <span className="text-text-tertiary">—</span>
                                ) : (
                                  <span className="inline-flex items-center gap-1">
                                    <Direction value={delta} />
                                    {(delta * 100).toFixed(0)}pp
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
