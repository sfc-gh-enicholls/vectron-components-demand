"use client";

import * as React from "react";
import {
  RadioTower, AlertTriangle, TrendingUp, TrendingDown, Minus, CalendarClock,
  Info, ArrowRight, Thermometer,
} from "lucide-react";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
import { Card } from "@/components/ui/card";
import {
  formatUnits, formatEur, formatPercent, formatSignedPercent,
  SEVERITY_CLASSES, SEVERITY_ORDER, SEGMENT_CLASSES,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentRecommendationLink } from "@/components/agent-recommendation-link";

interface Signal {
  SERIES_ID: string; SERIES_LABEL: string; PRODUCT_NAME: string;
  CUSTOMER_NAME: string; CHANNEL_NAME: string; CATEGORY_NAME: string;
  SEGMENT_ABC: string; BASE_ANNUAL_VALUE_EUR: number;
  SIGNAL_TYPE: string; SIGNAL_LABEL: string; DEVIATION: number;
  OBSERVED: number; EXPECTED: number; SEVERITY: string;
  SUGGESTED_ACTION: string;
  agentRecommendation: {
    proposalId: string;
    priority: string;
    proposalType: string;
    confidence: number;
  } | null;
}

interface PhasingRow {
  EVENT_SERIES: string; EVENT_NAME: string; EVENT_DATE: string;
  WEEK_ID: string; ISO_WEEK: number; FALLS_IN_MONTH: string;
  CUSTOMER_SCOPE: string;
}

interface SensingData {
  context: { HISTORY_END_WEEK: string; CURRENT_WEEK: string };
  signals: Signal[];
  byType: Array<{ SIGNAL_TYPE: string; SEVERITY: string; N: number; VALUE_AT_RISK: number }>;
  upcoming: Array<{
    EVENT_NAME: string; EVENT_TYPE: string; EVENT_DATE: string; WEEK_ID: string;
    CUSTOMER_SCOPE: string; LEAD_WEEKS: number; DESCRIPTION: string | null;
    WEEKS_AWAY: number;
  }>;
  phasing: PhasingRow[];
  weather: Array<{
    CUSTOMER_NAME: string; TEMP_ANOMALY_C: number; IS_HEATWAVE: boolean;
    IS_COLDSNAP: boolean; AUTO_SENTIMENT_IDX: number;
    TARIFF_INDEX: number; FLEET_MILEAGE_IDX: number;
  }>;
  competitor: Array<{
    COMPETITOR: string; ACTIVITY_TYPE: string; INTENSITY: number;
    CUSTOMER_NAME: string; CATEGORY_NAME: string; WEEK_ID: string;
  }>;
  provenance: { modelledInputs: string[]; note: string };
}

const TYPE_LABEL: Record<string, string> = {
  POS_VELOCITY: "Pull velocity",
  PROMO_RESPONSE: "Promotion response",
  DISTRIBUTION_SHIFT: "Distribution shift",
  SERVICE_RISK: "Service risk",
};

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

export default function SensingPage() {
  const [data, setData] = React.useState<SensingData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = React.useState<string | null>(null);
  const [typeFilter, setTypeFilter] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sensing");
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(json.error ?? "Failed to load"); return; }
        setData(json);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-negative/40 bg-negative-subtle p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium text-negative">Could not load demand sensing</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
              <p className="mt-2 text-text-tertiary">
                The signal views depend on APP.V_SENSING_SIGNALS and
                APP.V_WEEK_INDEX. Confirm both exist.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!data) return <div className="p-6"><PageSkeleton kpis={4} chart rows={10} /></div>;

  const { signals, byType, upcoming, phasing, weather, competitor, context, provenance } = data;

  const visible = signals.filter(
    (s) =>
      (!severityFilter || s.SEVERITY === severityFilter) &&
      (!typeFilter || s.SIGNAL_TYPE === typeFilter),
  );

  const severityTotals = SEVERITY_ORDER.map((sev) => ({
    severity: sev,
    count: byType.filter((r) => r.SEVERITY === sev).reduce((s, r) => s + Number(r.N), 0),
  })).filter((r) => r.count > 0);

  const typeTotals = Object.keys(TYPE_LABEL)
    .map((t) => ({
      type: t,
      count: byType.filter((r) => r.SIGNAL_TYPE === t).reduce((s, r) => s + Number(r.N), 0),
    }))
    .filter((r) => r.count > 0);

  // Group the phasing exhibit by event family so the week drift is visible.
  const phasingGroups = phasing.reduce<Record<string, PhasingRow[]>>((acc, r) => {
    (acc[r.EVENT_SERIES] ??= []).push(r);
    return acc;
  }, {});
  const driftGroups = Object.entries(phasingGroups)
    .map(([name, rows]) => {
      const weeks = rows.map((r) => Number(r.ISO_WEEK));
      return { name, rows, drift: Math.max(...weeks) - Math.min(...weeks) };
    })
    .sort((a, b) => b.drift - a.drift);

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="0 to 8 weeks"
        headline="Demand sensing"
        subtitle={`Divergences visible in actuals to ${context.HISTORY_END_WEEK} that the forward plan does not yet reflect.`}
        icon={<RadioTower size={18} aria-hidden="true" />}
      />

      {/* ---------- Provenance, stated up front ---------- */}
      <Card className="bg-bg-elevated p-3">
        <div className="flex items-start gap-2 text-xs">
          <Info size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <p className="text-text-tertiary">{provenance.note}</p>
        </div>
      </Card>

      {/* ---------- Filters ---------- */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-tertiary">Severity</span>
        <button
          type="button"
          onClick={() => setSeverityFilter(null)}
          className={cn(
            "rounded px-2 py-1 text-xs transition-colors",
            severityFilter === null ? "bg-accent-subtle text-accent" : "text-text-tertiary hover:text-foreground",
          )}
          aria-pressed={severityFilter === null}
        >
          All
        </button>
        {severityTotals.map((r) => (
          <button
            key={r.severity}
            type="button"
            onClick={() => setSeverityFilter(r.severity)}
            aria-pressed={severityFilter === r.severity}
            className={cn(
              "rounded px-2 py-1 text-xs tabular-nums transition-colors",
              severityFilter === r.severity
                ? SEVERITY_CLASSES[r.severity]
                : "text-text-tertiary hover:text-foreground",
            )}
          >
            {r.severity} ({r.count})
          </button>
        ))}
        <span className="ml-3 text-xs text-text-tertiary">Type</span>
        <button
          type="button"
          onClick={() => setTypeFilter(null)}
          aria-pressed={typeFilter === null}
          className={cn(
            "rounded px-2 py-1 text-xs transition-colors",
            typeFilter === null ? "bg-accent-subtle text-accent" : "text-text-tertiary hover:text-foreground",
          )}
        >
          All
        </button>
        {typeTotals.map((r) => (
          <button
            key={r.type}
            type="button"
            onClick={() => setTypeFilter(r.type)}
            aria-pressed={typeFilter === r.type}
            className={cn(
              "rounded px-2 py-1 text-xs tabular-nums transition-colors",
              typeFilter === r.type ? "bg-accent-subtle text-accent" : "text-text-tertiary hover:text-foreground",
            )}
          >
            {TYPE_LABEL[r.type]} ({r.count})
          </button>
        ))}
      </div>

      {/* ---------- Signal list ---------- */}
      <Card className="p-4">
        <div className="mb-3">
          <h2 className="card-title">
            Signals ({visible.length.toLocaleString("en-GB")})
          </h2>
          <p className="text-xs text-text-tertiary">
            Ranked by deviation weighted by series value, so a large miss on a
            tail series does not outrank a smaller one on a top series
          </p>
        </div>

        {visible.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-text-tertiary">No signals match this filter.</p>
            <button
              type="button"
              onClick={() => { setSeverityFilter(null); setTypeFilter(null); }}
              className="mt-2 text-xs text-accent hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-tertiary">
                  <th className="py-2 text-left font-medium">Series</th>
                  <th className="py-2 text-left font-medium">Seg</th>
                  <th className="py-2 text-left font-medium">Signal</th>
                  <th className="num py-2 font-medium">Observed</th>
                  <th className="num py-2 font-medium">Expected</th>
                  <th className="num py-2 font-medium">Deviation</th>
                  <th className="py-2 text-left font-medium">Severity</th>
                  <th className="py-2 text-left font-medium">Suggested action</th>
                  <th className="py-2 text-left font-medium">Agent</th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 60).map((s, i) => {
                  const isRate = s.SIGNAL_TYPE === "PROMO_RESPONSE";
                  const fmt = isRate
                    ? (v: number) => formatPercent(v)
                    : (v: number) => formatUnits(v);
                  return (
                    <tr key={`${s.SERIES_ID}-${s.SIGNAL_TYPE}-${i}`} className="border-b border-border/50">
                      <td className="py-2">
                        <span className="font-medium">{s.PRODUCT_NAME}</span>
                        <span className="text-text-tertiary">
                          {" · "}{s.CUSTOMER_NAME}{" · "}{s.CHANNEL_NAME}
                        </span>
                      </td>
                      <td className="py-2">
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px]", SEGMENT_CLASSES[s.SEGMENT_ABC])}>
                          {s.SEGMENT_ABC}
                        </span>
                      </td>
                      <td className="py-2 text-xs">{s.SIGNAL_LABEL}</td>
                      <td className="num py-2 tabular-nums">{fmt(Number(s.OBSERVED))}</td>
                      <td className="num py-2 tabular-nums text-text-tertiary">
                        {fmt(Number(s.EXPECTED))}
                      </td>
                      <td className="num py-2 tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          <Direction value={Number(s.DEVIATION)} />
                          {formatSignedPercent(Number(s.DEVIATION))}
                        </span>
                      </td>
                      <td className="py-2">
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px]", SEVERITY_CLASSES[s.SEVERITY])}>
                          {s.SEVERITY}
                        </span>
                      </td>
                      <td className="py-2 text-xs text-text-tertiary">
                        <span className="inline-flex items-center gap-1">
                          {s.SUGGESTED_ACTION}
                          <ArrowRight size={11} aria-hidden="true" />
                        </span>
                      </td>
                      <td className="py-2 text-xs">
                        {s.agentRecommendation ? (
                          <AgentRecommendationLink
                            proposalId={s.agentRecommendation.proposalId}
                            priority={s.agentRecommendation.priority}
                            proposalType={s.agentRecommendation.proposalType}
                            confidence={s.agentRecommendation.confidence}
                            compact
                          />
                        ) : (
                          <span className="text-text-tertiary">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length > 60 && (
              <p className="mt-2 text-xs text-text-tertiary">
                Showing the 60 highest-ranked of {visible.length.toLocaleString("en-GB")} matching signals.
              </p>
            )}
          </div>
        )}
      </Card>

      {/* ---------- Event phasing: the weekly-grain argument ---------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">
              Event phasing drift
            </h2>
            <p className="text-xs text-text-tertiary">
              Which ISO week each moveable feast falls in, by year. This is why
              the plan is built weekly: at monthly grain a peak that moves
              across a month boundary makes the year-on-year comparison
              meaningless.
            </p>
          </div>
          <div className="space-y-3">
            {driftGroups.map((g) => (
              <div key={g.name}>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-xs font-medium">{g.name}</span>
                  <span className={cn(
                    "text-xs tabular-nums",
                    g.drift >= 3 ? "text-warning" : "text-text-tertiary",
                  )}>
                    {g.drift} week{g.drift === 1 ? "" : "s"} of drift
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {g.rows.map((r) => (
                    <span
                      key={r.EVENT_NAME}
                      className="rounded bg-bg-elevated px-1.5 py-0.5 text-[11px] tabular-nums text-text-tertiary"
                    >
                      {r.EVENT_DATE?.slice(0, 4)}: W{String(r.ISO_WEEK).padStart(2, "0")}{" "}
                      <span className="text-foreground">{r.FALLS_IN_MONTH}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-start gap-2">
            <CalendarClock size={15} className="mt-0.5 text-accent" aria-hidden="true" />
            <div>
              <h2 className="card-title">Next events</h2>
              <p className="text-xs text-text-tertiary">
                Ship-in should already be building for anything inside its lead time
              </p>
            </div>
          </div>
          {upcoming.length === 0 ? (
            <p className="py-4 text-sm text-text-tertiary">
              No festival or gifting events remain in the calendar after {context.CURRENT_WEEK}.
            </p>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((e) => {
                const inLead = e.WEEKS_AWAY <= e.LEAD_WEEKS;
                return (
                  <li key={e.EVENT_NAME} className="border-b border-border/50 pb-2 last:border-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{e.EVENT_NAME}</span>
                      <span className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[11px] tabular-nums",
                        inLead ? SEVERITY_CLASSES.High : "text-text-tertiary",
                      )}>
                        {e.WEEKS_AWAY}w away
                      </span>
                    </div>
                    <p className="text-xs text-text-tertiary">
                      {e.WEEK_ID} · {e.CUSTOMER_SCOPE} · {e.LEAD_WEEKS}w ship-in lead
                      {inLead && (
                        <span className="text-warning"> · inside lead time now</span>
                      )}
                    </p>
                    {e.DESCRIPTION && (
                      <p className="mt-0.5 text-xs text-text-tertiary">{e.DESCRIPTION}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* ---------- Modelled exogenous context ---------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex items-start gap-2">
            <Thermometer size={15} className="mt-0.5 text-accent" aria-hidden="true" />
            <div>
              <h2 className="card-title">
                Customer conditions
                <span className="ml-1.5 rounded bg-neutral-subtle px-1.5 py-0.5 text-[10px] font-normal text-neutral">
                  modelled
                </span>
              </h2>
              <p className="text-xs text-text-tertiary">
                Week {context.HISTORY_END_WEEK}. These inputs are generated with
                realistic structure, not observed.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-tertiary">
                  <th className="py-1.5 text-left font-medium">Customer</th>
                  <th className="num py-1.5 font-medium">Temp anom.</th>
                  <th className="num py-1.5 font-medium">Confidence</th>
                  <th className="num py-1.5 font-medium">Duty idx</th>
                  <th className="num py-1.5 font-medium">Footfall</th>
                </tr>
              </thead>
              <tbody>
                {weather.map((w) => (
                  <tr key={w.CUSTOMER_NAME} className="border-b border-border/50">
                    <td className="py-1.5">
                      {w.CUSTOMER_NAME}
                      {w.IS_HEATWAVE && (
                        <span className="ml-1 rounded bg-warning-subtle px-1 text-[10px] text-warning">heat</span>
                      )}
                      {w.IS_COLDSNAP && (
                        <span className="ml-1 rounded bg-accent-subtle px-1 text-[10px] text-accent">cold</span>
                      )}
                    </td>
                    <td className="num py-1.5 tabular-nums">
                      {Number(w.TEMP_ANOMALY_C) > 0 ? "+" : ""}
                      {Number(w.TEMP_ANOMALY_C).toFixed(1)}°C
                    </td>
                    <td className="num py-1.5 tabular-nums">
                      {Number(w.AUTO_SENTIMENT_IDX).toFixed(0)}
                    </td>
                    <td className="num py-1.5 tabular-nums">
                      {Number(w.TARIFF_INDEX) > 1
                        ? <span className="text-warning">{Number(w.TARIFF_INDEX).toFixed(3)}</span>
                        : Number(w.TARIFF_INDEX).toFixed(3)}
                    </td>
                    <td className="num py-1.5 tabular-nums">
                      {Number(w.FLEET_MILEAGE_IDX).toFixed(0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">
              Competitor activity
              <span className="ml-1.5 rounded bg-neutral-subtle px-1.5 py-0.5 text-[10px] font-normal text-neutral">
                modelled
              </span>
            </h2>
            <p className="text-xs text-text-tertiary">
              Last four weeks, intensity 0.6 and above
            </p>
          </div>
          {competitor.length === 0 ? (
            <p className="py-4 text-sm text-text-tertiary">
              No high-intensity competitor activity recorded in the last four weeks.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {competitor.map((c, i) => (
                <li key={`${c.COMPETITOR}-${c.WEEK_ID}-${i}`} className="flex items-baseline justify-between gap-2 text-xs">
                  <span>
                    <span className="font-medium">{c.COMPETITOR}</span>
                    <span className="text-text-tertiary">
                      {" · "}{c.ACTIVITY_TYPE.toLowerCase().replace(/_/g, " ")}
                      {" · "}{c.CUSTOMER_NAME}{" · "}{c.CATEGORY_NAME}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-text-tertiary">
                    {Number(c.INTENSITY).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
