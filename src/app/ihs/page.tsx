"use client";

import * as React from "react";
import { AlertTriangle, Car, Database } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
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
import { formatEur, formatSignedPercent, formatUnits } from "@/lib/format";

type Opt = { value: string; label: string };
type GapRow = { id: string; name: string; plan: number; ihs: number; gapPct: number | null; gapEur: number };

type IhsData = {
  context: { HISTORY_END_WEEK: string };
  filters: { customer: string; category: string };
  options: { customers: Opt[]; categories: Opt[] };
  window: { first: string; last: string };
  vintage: { first: string | null; last: string | null };
  kpis: {
    gapPct: number | null;
    gapEur: number;
    historyWape: number | null;
    bevRevision: number | null;
    totalRevision: number | null;
  };
  monthly: Array<{ month: string; isActual: boolean; actual: number | null; plan: number | null; ihs: number; ihsOldest: number | null }>;
  years: Array<{ year: number; bev: number; ice: number; revenue: number; bevRevenue: number }>;
  vintages: Array<{ vintage: string; units: number; bev: number; revenue: number }>;
  byCustomer: GapRow[];
  byCategory: GapRow[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string | null) => {
  if (!ym) return "—";
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};
const monthShort = (ym: string) => {
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
};
const pct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(dp)}%`;
const axisUnits = (v: number) => formatUnits(Number(v)).replace(" pcs", "");
const axisEurBn = (v: number) => `€${(Number(v) / 1e9).toFixed(1)}bn`;
const tooltipStyle = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: 12,
};
const ALL = "__all";

function GapTable({ title, rows, firstHeader }: { title: string; rows: GapRow[]; firstHeader: string }) {
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">{title}</h2>
      <p className="mb-2 text-xs text-text-tertiary">
        Positive gap: Vectron plans more than the vehicle market implies. Sorted by gap. Pieces and euros can
        disagree in sign: a small volume shortfall on cheap parts can sit beside an overplan on expensive ones.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{firstHeader}</TableHead>
            <TableHead className="text-right">Plan (k pcs)</TableHead>
            <TableHead className="text-right">IHS-implied (k pcs)</TableHead>
            <TableHead className="text-right">Gap (%)</TableHead>
            <TableHead className="text-right">Gap (€M)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.name}</TableCell>
              <TableCell className="text-right tabular-nums">{(r.plan / 1e3).toFixed(0)}</TableCell>
              <TableCell className="text-right tabular-nums">{(r.ihs / 1e3).toFixed(0)}</TableCell>
              <TableCell className={`text-right tabular-nums ${(r.gapPct ?? 0) > 0.03 ? "font-semibold text-negative" : ""}`}>
                {formatSignedPercent(r.gapPct)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.gapEur >= 0 ? "+" : "−"}
                {Math.abs(r.gapEur / 1e6).toFixed(0)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export default function IhsPage() {
  const [data, setData] = React.useState<IhsData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [customer, setCustomer] = React.useState("");
  const [category, setCategory] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (customer) params.set("customer", customer);
      if (category) params.set("category", category);
      const response = await fetch(`/api/ihs?${params.toString()}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to load the vehicle market view");
      setData(json as IhsData);
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [customer, category]);

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
              <p className="font-medium text-negative">Could not load the vehicle market view.</p>
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

  const { kpis, window: win, vintage } = data;
  const windowLabel = `${monthLabel(win.first)} to ${monthLabel(win.last)}`;
  const lastActual = [...data.monthly].reverse().find((m) => m.isActual)?.month;
  const firstV = data.vintages[0];

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Demand signal"
        headline="Vehicle market"
        subtitle={`Outside in: vehicles the OEMs will build, times Vectron pieces per vehicle, times a calibrated installation rate. Compared with Vectron's plan for ${windowLabel}. Production data is a synthetic stand-in for an S&P Global Mobility (IHS) light-vehicle forecast, not S&P data.`}
        icon={<Car size={18} aria-hidden="true" />}
      />

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="mb-1 text-xs text-text-tertiary">Customer</p>
          <Select value={customer || ALL} onValueChange={(v) => setCustomer(v === ALL || !v ? "" : v)}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All OEMs</SelectItem>
              {data.options.customers.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="mb-1 text-xs text-text-tertiary">Category</p>
          <Select value={category || ALL} onValueChange={(v) => setCategory(v === ALL || !v ? "" : v)}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {data.options.categories.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-text-tertiary">
          <Database size={13} aria-hidden="true" />
          Source: APP.V_LV_PRODUCTION, vintage {monthLabel(vintage.last)}. Repoint one view to use a licensed share.
        </p>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Plan v vehicle market, value"
          value={`${kpis.gapEur >= 0 ? "+" : "−"}${formatEur(Math.abs(kpis.gapEur))}`}
          valueClassName={kpis.gapEur > 0 ? "text-negative" : undefined}
          detail={`${windowLabel}. Volume gap ${formatSignedPercent(kpis.gapPct)}.`}
        />
        <Kpi
          label="BEV view, 2027, revised"
          value={formatSignedPercent(kpis.bevRevision)}
          detail={`Implied 2027 BEV pieces, vintage ${monthLabel(vintage.first)} to ${monthLabel(vintage.last)}.`}
        />
        <Kpi
          label="All parts, 2027, revised"
          value={formatSignedPercent(kpis.totalRevision)}
          detail="Same vintage walk, every OE series."
        />
        <Kpi
          label="History fit"
          value={pct(kpis.historyWape)}
          detail="Monthly WAPE of IHS-implied against realised pull, series grain, since Jan 2024."
        />
      </div>

      <Card className="p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">Vectron&apos;s plan against the vehicle market</h2>
        <p className="mb-3 text-xs text-text-tertiary">
          OE pull by month. History: actual against what IHS actuals imply, which is how far to trust the method.
          Forward: Vectron&apos;s plan against the latest vintage and the oldest one, a year earlier.
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.monthly} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
            <XAxis dataKey="month" tickFormatter={monthShort} interval={2} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" />
            <YAxis tickFormatter={axisUnits} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" width={56} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(m) => monthLabel(String(m))} formatter={(v, name) => [v == null ? "—" : formatUnits(Number(v)), name]} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {lastActual ? <ReferenceLine x={lastActual} stroke="var(--border-strong)" strokeDasharray="3 3" /> : null}
            <Line dataKey="actual" name="Actual pull (pcs)" stroke="var(--chart-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="plan" name="Vectron plan (pcs)" stroke="var(--chart-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="ihs" name={`IHS-implied, ${monthLabel(vintage.last)} (pcs)`} stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
            <Line dataKey="ihsOldest" name={`IHS-implied, ${monthLabel(vintage.first)} (pcs)`} stroke="var(--chart-4)" strokeWidth={1.5} strokeDasharray="2 3" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <GapTable title={`Gap by customer, ${windowLabel}`} rows={data.byCustomer} firstHeader="Customer" />
        <GapTable title={`Gap by category, ${windowLabel}`} rows={data.byCategory} firstHeader="Category" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">Vintage walk: 2027</h2>
          <p className="mb-3 text-xs text-text-tertiary">
            What each monthly publication implied for calendar 2027, in Vectron pieces. BEV is where the view has moved.
            {firstV ? ` Started at ${formatUnits(firstV.bev)} BEV.` : ""}
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.vintages} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
              <XAxis dataKey="vintage" tickFormatter={monthShort} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" />
              <YAxis yAxisId="all" tickFormatter={axisUnits} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" width={56} domain={["auto", "auto"]} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(m) => `Vintage ${monthLabel(String(m))}`} formatter={(v, name) => [formatUnits(Number(v)), name]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="all" dataKey="bev" name="BEV platforms (pcs)" stroke="var(--chart-3)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">The seven-year view</h2>
          <p className="mb-3 text-xs text-text-tertiary">
            Implied value by year, latest vintage, split by platform powertrain. ICE compacts end production in
            2029 and their BEV successors carry more Vectron content per vehicle, so value rises while pieces dip.
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart
              data={data.years.map((y) => ({ year: y.year, ice: y.revenue - y.bevRevenue, bev: y.bevRevenue }))}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
              <XAxis dataKey="year" tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" />
              <YAxis tickFormatter={axisEurBn} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" width={56} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [formatEur(Number(v)), name]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="ice" stackId="v" name="ICE platforms (€)" fill="var(--chart-1)" isAnimationActive={false} />
              <Bar dataKey="bev" stackId="v" name="BEV platforms (€)" fill="var(--chart-3)" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  );
}
