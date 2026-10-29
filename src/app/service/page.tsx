"use client";

import * as React from "react";
import { AlertTriangle, Wrench } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
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
import { formatSignedPercent, formatUnits, formatWeekShort } from "@/lib/format";

type ServiceData = {
  context: { HISTORY_END_WEEK: string };
  series: string | null;
  classes: Array<{ demandClass: string; channel: string; n: number }>;
  models: Array<{ model: string; series: number; medianMase: number | null; bias: number | null; coverage: number | null }>;
  wins: { sba: number; of: number };
  scatter: Array<{ seriesId: string; adi: number; cv2: number; demandClass: string }>;
  table: Array<{
    seriesId: string; label: string; channel: string; demandClass: string;
    sbaMase: number | null; statMase: number | null; sbaBias: number | null; statBias: number | null;
  }>;
  weeks: Array<{ week: string; actual: number; sba?: number; stat?: number }>;
};

const MODEL_LABEL: Record<string, string> = {
  SBA: "SBA (Syntetos-Boylan)",
  CROSTON: "Croston",
  VECTRON_STAT: "Vectron statistical",
  NAIVE_SEASONAL: "Naive seasonal",
};
const CLASS_COLOUR: Record<string, string> = {
  smooth: "var(--chart-1)",
  erratic: "var(--chart-2)",
  intermittent: "var(--chart-3)",
  lumpy: "var(--chart-4)",
};
const num = (v: number | null | undefined, dp = 2) => (v == null ? "—" : v.toFixed(dp));
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const tooltipStyle = { background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 };

export default function ServicePage() {
  const [data, setData] = React.useState<ServiceData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [series, setSeries] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (series) params.set("series", series);
      const response = await fetch(`/api/service?${params.toString()}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to load service parts");
      setData(json as ServiceData);
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [series]);

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
              <p className="font-medium text-negative">Could not load service parts.</p>
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

  const m = (id: string) => data.models.find((x) => x.model === id);
  const sba = m("SBA");
  const stat = m("VECTRON_STAT");
  const nonOe = data.classes.filter((c) => c.channel !== "CH-OE");
  const nonOeTotal = nonOe.reduce((s, c) => s + c.n, 0);
  const inScope = nonOe.filter((c) => c.demandClass === "intermittent" || c.demandClass === "lumpy").reduce((s, c) => s + c.n, 0);
  const selected = data.table.find((t) => t.seriesId === data.series);

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Forecast"
        headline="Service parts"
        subtitle={`Spare and aftermarket demand for low-runner part families is intermittent: most weeks nothing, then an order. Those series get Croston and SBA, scored on MASE over lags 1–8 to ${data.context.HISTORY_END_WEEK}. Demand is synthetic.`}
        icon={<Wrench size={18} aria-hidden="true" />}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Intermittent service series"
          value={`${inScope} of ${nonOeTotal}`}
          detail={`Classed intermittent or lumpy (ADI ≥ 1.32) on the two years before the backtest. ${data.wins.of} had orders in the backtest and are scored; the rest are delisted.`}
        />
        <Kpi
          label="SBA error (median MASE)"
          value={num(sba?.medianMase)}
          valueClassName="text-positive"
          detail={`Statistical model ${num(stat?.medianMase)}. Below 1 beats last week's value.`}
        />
        <Kpi
          label="SBA wins"
          value={`${data.wins.sba} of ${data.wins.of}`}
          detail="Series where SBA has lower MASE than the statistical model."
        />
        <Kpi
          label="Statistical model over-forecast"
          value={formatSignedPercent(stat?.bias)}
          valueClassName="text-negative"
          detail={`SBA ${formatSignedPercent(sba?.bias)}. A small number every zero week adds up to stock.`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">Which series are intermittent</h2>
          <p className="mb-3 text-xs text-text-tertiary">
            Service and aftermarket series by average interval between orders (ADI) and variability of order size (CV²).
            Lines are the Syntetos-Boylan cut-offs. Right of the vertical line: Croston territory.
          </p>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
              <CartesianGrid stroke="var(--chart-grid)" strokeWidth={0.5} />
              <XAxis type="number" dataKey="adi" name="ADI" scale="log" domain={[1, 12]} ticks={[1, 1.32, 2, 4, 8, 12]} allowDataOverflow tickFormatter={(v) => Number(v).toFixed(1)} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" label={{ value: "ADI (weeks per order, log)", fontSize: 10, position: "insideBottom", offset: -4, fill: "var(--text-tertiary)" }} />
              <YAxis type="number" dataKey="cv2" name="CV²" tickFormatter={(v) => Number(v).toFixed(1)} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" width={40} />
              <ZAxis range={[28, 28]} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => Number(v).toFixed(2)} />
              <ReferenceLine x={1.32} stroke="var(--border-strong)" strokeDasharray="4 3" />
              <ReferenceLine y={0.49} stroke="var(--border-strong)" strokeDasharray="4 3" />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {["smooth", "erratic", "intermittent", "lumpy"].map((c) => (
                <Scatter key={c} name={c} data={data.scatter.filter((s) => s.demandClass === c)} fill={CLASS_COLOUR[c]} isAnimationActive={false} />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">Model comparison, intermittent series</h2>
          <p className="mb-2 text-xs text-text-tertiary">
            MASE: mean absolute error scaled by the series&apos; own week-to-week change. Bias: total forecast minus
            total orders, as a share of orders. Coverage: weeks at or under the 95% upper bound (for Croston and SBA,
            the 95th percentile of the last two years&apos; weekly demand).
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Median MASE</TableHead>
                <TableHead className="text-right">Bias (%)</TableHead>
                <TableHead className="text-right">Coverage (%)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.models.map((r) => (
                <TableRow key={r.model}>
                  <TableCell className={r.model === "SBA" ? "font-semibold" : ""}>{MODEL_LABEL[r.model]}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.medianMase)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatSignedPercent(r.bias)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.coverage)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-3 text-xs text-text-tertiary">
            SBA is Croston deflated by (1 − α/2) to remove Croston&apos;s known upward bias; α = 0.1. Neither model
            forecasts timing, only the rate: the point is the right total, not the right week.
          </p>
        </Card>
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">One series, week by week</h2>
            <p className="text-xs text-text-tertiary">
              One-week-ahead forecast against orders. The statistical model chases each order; SBA holds a steady rate.
            </p>
          </div>
          <Select value={data.series ?? ""} onValueChange={(v) => setSeries(v ?? "")}>
            <SelectTrigger className="w-96"><SelectValue /></SelectTrigger>
            <SelectContent>
              {data.table.map((t) => (
                <SelectItem key={t.seriesId} value={t.seriesId}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data.weeks} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
            <XAxis dataKey="week" tickFormatter={(w) => formatWeekShort(String(w))} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" />
            <YAxis tickFormatter={(v) => formatUnits(Number(v)).replace(" pcs", "")} tick={{ fontSize: 10, fill: "var(--text-tertiary)" }} stroke="var(--chart-grid)" width={48} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [formatUnits(Number(v)), name]} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="stepAfter" dataKey="actual" name="Orders (pcs)" stroke="var(--chart-1)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line dataKey="stat" name="Statistical (pcs)" stroke="var(--chart-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="sba" name="SBA (pcs)" stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
        {selected ? (
          <p className="mt-2 text-xs text-text-tertiary">
            MASE: SBA {num(selected.sbaMase)}, statistical {num(selected.statMase)}. Bias: SBA {formatSignedPercent(selected.sbaBias)},
            statistical {formatSignedPercent(selected.statBias)}.
          </p>
        ) : null}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">Every intermittent series</h2>
        <p className="mb-2 text-xs text-text-tertiary">Sorted by how much SBA improves on the statistical model.</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Series</TableHead>
              <TableHead>Class</TableHead>
              <TableHead className="text-right">SBA MASE</TableHead>
              <TableHead className="text-right">Statistical MASE</TableHead>
              <TableHead className="text-right">SBA bias (%)</TableHead>
              <TableHead className="text-right">Statistical bias (%)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.table.map((t) => (
              <TableRow key={t.seriesId}>
                <TableCell>{t.label} <span className="text-text-tertiary">({t.channel.replace("CH-", "")})</span></TableCell>
                <TableCell className="capitalize">{t.demandClass}</TableCell>
                <TableCell className={`text-right tabular-nums ${(t.sbaMase ?? 9) < (t.statMase ?? 9) ? "font-semibold text-positive" : ""}`}>{num(t.sbaMase)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(t.statMase)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatSignedPercent(t.sbaBias)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatSignedPercent(t.statBias)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
