"use client";

import * as React from "react";
import { AlertTriangle, CalendarRange, Truck } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
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
import {
  HierarchyFilter,
  pathLabel,
  pathToParams,
  type HierarchyOptions,
  type HierarchyPath,
} from "@/components/hierarchy-filter";
import { formatSignedPercent, formatUnits, formatWeek, formatWeekShort } from "@/lib/format";

type ZoneKpi = { wape: number | null; bias: number | null; corrected: number | null };

type CalloffData = {
  context: { HISTORY_END_WEEK: string };
  filters: { path: HierarchyPath; target: string | null; oem: string };
  options: {
    hierarchy: HierarchyOptions;
    targetWeeks: string[];
    oems: Array<{ value: string; label: string }>;
  };
  kpis: { firm: ZoneKpi; trade: ZoneKpi; forecast: ZoneKpi; tradeNervousness: number | null };
  horizons: Array<{
    horizon: number;
    zone: string;
    oemWape: number | null;
    oemBias: number | null;
    correctedWape: number | null;
    modelWape: number | null;
  }>;
  customers: Array<{
    customerId: string;
    customerName: string;
    oemWape: number | null;
    oemBias: number | null;
    correctedWape: number | null;
    nervousness: number | null;
  }>;
  waterfall: Array<{
    releaseWeek: string;
    horizon: number;
    zone: string;
    releaseUnits: number;
    actualUnits: number | null;
  }>;
  mirage: {
    years: number[];
    year: number;
    pair: number[];
    monthly: Array<Record<string, number | null>>;
    aligned: Array<Record<string, number | string | null>>;
    shutdownWeeks: Record<string, string | null>;
  };
};

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(dp)}%`;
const axisUnits = (v: number) => formatUnits(Number(v)).replace(" pcs", "");
const tooltipStyle = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: 12,
};

export default function CalloffsPage() {
  const [data, setData] = React.useState<CalloffData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [path, setPath] = React.useState<HierarchyPath>({});
  const [target, setTarget] = React.useState<string>("");
  const [oem, setOem] = React.useState<string>("");
  const [year, setYear] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(pathToParams(path));
      if (target) params.set("target", target);
      if (oem) params.set("oem", oem);
      if (year) params.set("year", String(year));
      const response = await fetch(`/api/calloffs?${params.toString()}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to load call-offs");
      setData(json as CalloffData);
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path, target, oem, year]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="p-6">
        <Card className="bg-negative-subtle p-4">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div>
              <p className="font-medium text-negative">Could not load call-offs.</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }
  if (loading || !data) {
    return <div className="p-6"><PageSkeleton kpis={5} chart rows={8} /></div>;
  }

  const { kpis, mirage } = data;
  const [prevYear, curYear] = mirage.pair;
  const oemName = data.options.oems.find((o) => o.value === data.filters.oem)?.label ?? data.filters.oem;
  const shutdownMonthRead = mirage.monthly.find((m) => m.month === 8);
  const tradeBand = { x1: 3, x2: 8 };

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Demand signal"
        headline="OEM call-offs"
        subtitle={`Every week each OEM sends a 12-week delivery schedule. Firm weeks are reliable; beyond them the schedule is noisy and, for most customers, consistently high. Scored against outturn to ${data.context.HISTORY_END_WEEK}. Schedules are synthetic and illustrative, not any named OEM's real behaviour.`}
        icon={<Truck size={18} aria-hidden="true" />}
      />

      <Card className="p-4">
        <p className="text-xs text-text-tertiary">Portfolio scope (OE series production only)</p>
        <HierarchyFilter path={path} options={data.options.hierarchy} onChange={setPath} className="mt-1" />
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi label="Firm zone error" value={pct(kpis.firm.wape)} detail="WAPE, weeks 0–2. What the plants build to." />
        <Kpi
          label="Trade zone error"
          value={pct(kpis.trade.wape)}
          detail={`WAPE, weeks 3–8. Over-call ${formatSignedPercent(kpis.trade.bias)}.`}
        />
        <Kpi
          label="Trade zone, de-biased"
          value={pct(kpis.trade.corrected)}
          valueClassName="text-positive"
          detail="Each OEM's release corrected by its own trailing track record. No look-ahead."
        />
        <Kpi
          label="Forecast zone error"
          value={pct(kpis.forecast.wape)}
          detail={`WAPE, weeks 9–12. Over-call ${formatSignedPercent(kpis.forecast.bias)}.`}
        />
        <Kpi
          label="Schedule nervousness"
          value={pct(kpis.tradeNervousness)}
          detail="Trade-zone quantity moved between consecutive releases, as a share of quantity."
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">Error by horizon</h2>
            <p className="text-xs text-text-tertiary">
              WAPE of the OEM release, the de-biased release and Vectron&apos;s statistical model, at each week ahead.
              The model is shown only for weeks 1–8, the horizons its backtest covers. Shaded band: trade zone.
              Scope: {pathLabel(path)}.
            </p>
          </div>
          <div className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.horizons} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                <ReferenceArea {...tradeBand} fill="var(--shade)" fillOpacity={1} />
                <XAxis
                  dataKey="horizon"
                  tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                  stroke="var(--chart-grid)"
                  label={{ value: "Weeks ahead", position: "insideBottom", offset: -2, fontSize: 10, fill: "var(--text-tertiary)" }}
                />
                <YAxis
                  domain={[0, "auto"]}
                  tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`}
                  tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                  stroke="var(--chart-grid)"
                  width={44}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(v) => `${v} weeks ahead`}
                  formatter={(v, name) => [pct(Number(v)), name]}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line dataKey="oemWape" name="OEM release" stroke="var(--chart-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line dataKey="correctedWape" name="De-biased release" stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
                <Line dataKey="modelWape" name="Vectron model" stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="2 3" dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-text-tertiary">
            Inside the trade zone the OEM&apos;s own schedule beats a statistical model. It knows its build plan. The gain
            comes from learning each OEM&apos;s bias, not from replacing its number.
          </p>
        </Card>

        <Card className="p-4">
          <div className="mb-3">
            <h2 className="card-title">By customer, trade zone</h2>
            <p className="text-xs text-text-tertiary">
              Trade-zone WAPE of the release and the de-biased release. Bias is signed: positive means called more than
              pulled. Moves: quantity changed between consecutive releases.
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Release (%)</TableHead>
                <TableHead className="text-right">Bias (%)</TableHead>
                <TableHead className="text-right">De-biased (%)</TableHead>
                <TableHead className="text-right">Moves (%)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.customers.map((c) => (
                <TableRow key={c.customerId}>
                  <TableCell className="font-medium">{c.customerName}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(c.oemWape)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatSignedPercent(c.oemBias)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(c.correctedWape)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(c.nervousness)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="card-title">How one week&apos;s call converged</h2>
            <p className="text-xs text-text-tertiary">
              The quantity each of the 13 releases asked for, for {data.filters.target ? formatWeek(data.filters.target) : "—"},
              oldest release on the left, against what was actually pulled. A line chart rather than bars, so the
              axis can start above zero honestly and the movement is visible.
            </p>
          </div>
          <label className="text-xs">
            <span className="text-text-tertiary">Delivery week</span>
            <Select value={data.filters.target ?? ""} onValueChange={(v) => setTarget(v ?? "")}>
              <SelectTrigger className="mt-1 w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {data.options.targetWeeks.map((w) => (
                  <SelectItem key={w} value={w}>{formatWeek(w)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
        <div className="h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.waterfall} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
              <XAxis
                dataKey="releaseWeek"
                tickFormatter={(w, i) => `${formatWeekShort(String(w))} (${data.waterfall[i]?.horizon ?? ""})`}
                tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                stroke="var(--chart-grid)"
              />
              <YAxis tickFormatter={axisUnits} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" width={56} domain={["auto", "auto"]} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(w) => `Release ${formatWeek(String(w))}`}
                formatter={(v, name) => [formatUnits(Number(v)), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line dataKey="releaseUnits" name="Called off (pcs)" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              <Line dataKey="actualUnits" name="Pulled (pcs)" stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-xs text-text-tertiary">Axis labels show the release week and, in brackets, how many weeks ahead it was.</p>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-start gap-2">
            <CalendarRange size={16} className="mt-0.5 text-accent" aria-hidden="true" />
            <div>
              <h2 className="card-title">The monthly mirage</h2>
              <p className="text-xs text-text-tertiary">
                {oemName}&apos;s summer shutdown started in {mirage.shutdownWeeks[String(prevYear)] ? formatWeek(mirage.shutdownWeeks[String(prevYear)]) : "—"} in {prevYear} and{" "}
                {mirage.shutdownWeeks[String(curYear)] ? formatWeek(mirage.shutdownWeeks[String(curYear)]) : "—"} in {curYear}.
                Plant calendar dates are illustrative.
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <label className="text-xs">
              <span className="text-text-tertiary">Customer</span>
              <Select value={data.filters.oem} onValueChange={(v) => setOem(v ?? "")}>
                <SelectTrigger className="mt-1 w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {data.options.oems.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="text-xs">
              <span className="text-text-tertiary">Compare</span>
              <Select value={String(curYear)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger className="mt-1 w-[130px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {mirage.years.filter((y) => mirage.years.includes(y - 1)).map((y) => (
                    <SelectItem key={y} value={String(y)}>{y} v {y - 1}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <p className="text-xs font-medium">What a monthly report says</p>
            <p className="text-xs text-text-tertiary">
              OE pull by calendar month. August reads {formatSignedPercent(shutdownMonthRead?.yoy ?? null)} year on year.
            </p>
            <div className="mt-2 h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={mirage.monthly} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                  <XAxis dataKey="month" tickFormatter={(m) => MONTHS[Number(m)]} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" />
                  <YAxis tickFormatter={axisUnits} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" width={56} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(m) => MONTHS[Number(m)]} formatter={(v, name) => [formatUnits(Number(v)), name]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey={`y${prevYear}`} name={`${prevYear} (pcs)`} fill="var(--chart-3)" isAnimationActive={false} />
                  <Bar dataKey={`y${curYear}`} name={`${curYear} (pcs)`} fill="var(--chart-1)" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ul className="mt-1 flex flex-wrap gap-x-4 text-xs text-text-tertiary">
              {mirage.monthly.map((m) => (
                <li key={m.month} className="tabular-nums">{MONTHS[Number(m.month)]} {formatSignedPercent(m.yoy)}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-medium">What actually happened</p>
            <p className="text-xs text-text-tertiary">
              Weekly OE pull counted from the first shutdown week. Aligned this way the two years overlay: only the calendar moved.
            </p>
            <div className="mt-2 h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={mirage.aligned} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
                  <XAxis
                    dataKey="offset"
                    tickFormatter={(o) => (Number(o) > 0 ? `+${o}` : String(o))}
                    tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
                    stroke="var(--chart-grid)"
                    label={{ value: "Weeks from shutdown start", position: "insideBottom", offset: -2, fontSize: 10, fill: "var(--text-tertiary)" }}
                  />
                  <YAxis tickFormatter={axisUnits} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" width={56} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(o) => `Week ${Number(o) > 0 ? "+" : ""}${o}`} formatter={(v, name) => [formatUnits(Number(v)), name]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line dataKey={`y${prevYear}`} name={`${prevYear} (pcs)`} stroke="var(--chart-3)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line dataKey={`y${curYear}`} name={`${curYear} (pcs)`} stroke="var(--chart-1)" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
