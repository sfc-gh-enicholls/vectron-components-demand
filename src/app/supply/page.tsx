"use client";

import * as React from "react";
import { AlertTriangle, Factory, Play } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { HierarchyFilter, pathToParams, type HierarchyOptions, type HierarchyPath } from "@/components/hierarchy-filter";
import { Kpi } from "@/components/kpi";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CHART_COLORS, formatUnits, formatWeekShort } from "@/lib/format";
import { cn } from "@/lib/utils";

type Line = {
  lineId: string; siteId: string; siteName: string; lineName: string;
  capacity: number; effectiveCapacity: number; lotSize: number;
};
type Job = { status: "running" | "done" | "failed"; startedAt: string; error?: string; trigger: string };
type SupplyData = {
  source: string;
  sources: { id: string; name: string }[];
  weeks: { weekNo: number; weekId: string; start: string }[];
  hierarchyOptions: HierarchyOptions;
  lines: Line[];
  liveLineLoad: { lineId: string; weekNo: number; load: number; pastDue: number }[];
  liveByCustomer: { customer: string; orderUnits: number; pastDueUnits: number; orders: number }[];
  dryGoods: {
    itemId: string; name: string; type: string; leadWeeks: number; supplyPerWeek: number;
    projected: number[]; need: number[]; firstShortWeek: number | null;
  }[];
  solvedLineLoad: { lineId: string; weekNo: number; produced: number; requested: number }[];
  allocation: {
    customer: string; tier: number; requested: number; onTime: number; late: number;
    liquidShort: number; unmet: number;
  }[];
  binding: { kind: string; item: string | null; units: number }[];
  liquidFill: { product: string; year: number; fillRatio: number; family: string }[];
  solve: {
    solvedAt: string; trigger: string | null; isStale: boolean; requested: number;
    produced: number; onTime: number; liquidShort: number; unmet: number;
  } | null;
  job: Job | null;
};

function pct(value: number, of: number): string {
  if (!of) return "—";
  return `${((value / of) * 100).toFixed(1)}%`;
}

/** A bar whose LENGTH carries the magnitude, with the number written beside it. */
function MeterBar({ ratio, label, over, compact }: { ratio: number; label: string; over?: boolean; compact?: boolean }) {
  const width = Math.max(0, Math.min(1, ratio / 2)) * 100; // scale: full bar = 200%
  return (
    <div className="flex items-center gap-2">
      <div className={cn("relative h-2 shrink-0 rounded-full bg-neutral-subtle", compact ? "w-8 sm:w-12" : "w-10 sm:w-28")} aria-hidden="true">
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", over ? "bg-negative" : "bg-accent")}
          style={{ width: `${width}%` }}
        />
        <div className="absolute inset-y-[-2px] left-1/2 w-px bg-foreground/40" />
      </div>
      <span className="tabular-nums">{label}</span>
    </div>
  );
}

export default function SupplyPage() {
  const [source, setSource] = React.useState("COMMITTED");
  const [path, setPath] = React.useState<HierarchyPath>({});
  const [data, setData] = React.useState<SupplyData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedLine, setSelectedLine] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<Job | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ source, ...pathToParams(path) });
      const response = await fetch(`/api/supply?${params.toString()}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Failed to load supply");
      setData(json as SupplyData);
      setJob((json as SupplyData).job);
    } catch (err) {
      setData(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [source, path]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Poll while a solve is running, then reload once it lands.
  React.useEffect(() => {
    if (job?.status !== "running") return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/supply/solve?source=${encodeURIComponent(source)}`);
      const json = await response.json();
      if (json.job?.status !== "running") {
        window.clearInterval(timer);
        setJob(json.job);
        void load();
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job?.status, source, load]);

  async function runSolve() {
    const response = await fetch("/api/supply/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const json = await response.json();
    if (!response.ok) {
      setError(json.error ?? "Could not start the solve");
      return;
    }
    setJob(json.job);
  }

  const view = React.useMemo(() => (data ? deriveView(data) : null), [data]);

  if (error) {
    return (
      <div className="p-6">
        <Card className="bg-negative-subtle p-4">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 text-negative" aria-hidden="true" />
            <div>
              <p className="font-medium text-negative">Could not load the supply review.</p>
              <p className="mt-1 text-text-tertiary">{error}</p>
              <Button className="mt-3" size="sm" variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (loading || !data || !view) {
    return (
      <div className="p-6">
        <PageSkeleton kpis={4} chart rows={8} />
      </div>
    );
  }

  const lineId = selectedLine ?? view.lineRows[0]?.lineId ?? null;
  const chartRows = lineId ? view.lineChart(lineId) : [];
  const chartLine = data.lines.find((l) => l.lineId === lineId) ?? null;
  const solve = data.solve;
  const running = job?.status === "running";

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Supply review"
        headline="Supply against the plan"
        subtitle="What the plan asks of Vectron's lines, bought components and allocated semiconductors and magnets, recomputed from the plan on every view, and what a constrained solve says supply can actually deliver. Network, capacities and lead times are illustrative."
        icon={<Factory size={18} aria-hidden="true" />}
      />

      <Card className="p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
          <div>
            <h2 className="card-title">Scope</h2>
            <HierarchyFilter
              className="mt-3"
              path={path}
              options={data.hierarchyOptions}
              onChange={setPath}
              enabledLevels={["CATEGORY_NAME", "PRODUCT_NAME", "CUSTOMER_NAME"]}
              unsupportedNote="channel does not apply, because supply is planned by delivery variant and customer, not by channel. Bought components are shared across the portfolio and are never scoped"
            />
          </div>
          <div className="space-y-3 text-sm">
            <label className="block text-xs">
              <span className="label">Plan</span>
              <Select value={source} onValueChange={(value) => value && setSource(value)}>
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={() => void runSolve()} disabled={running}>
                {running ? null : <Play size={14} className="mr-1" aria-hidden="true" />}
                {running ? "Solving (about 30 seconds)\u2026" : "Solve supply"}
              </Button>
              {solve ? (
                <span className="text-xs text-text-tertiary">
                  Last solved {new Date(solve.solvedAt).toLocaleString("en-GB")}
                  {solve.trigger ? ` (${solve.trigger.replace(":", " by ")})` : ""}.{" "}
                  {solve.isStale ? (
                    <Badge className="bg-warning-subtle text-warning">Plan changed since: solve again</Badge>
                  ) : (
                    <Badge className="bg-positive-subtle text-positive">Current with the plan</Badge>
                  )}
                </span>
              ) : (
                <span className="text-xs text-text-tertiary">Not solved yet for this plan.</span>
              )}
            </div>
            {job?.status === "failed" && (
              <p className="text-xs text-negative">The last solve failed: {job.error}</p>
            )}
            <p className="text-xs text-text-tertiary">
              Live figures recompute from the plan every time this page loads. The constrained
              solve applies line capacity, bought components, component allocations and lot sizes week by week, and
              runs automatically when a scenario promotion is approved.
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="On time (solved)"
          value={solve ? pct(view.alloc.onTime, view.alloc.requested) : "—"}
          detail={solve ? `${formatUnits(view.alloc.onTime)} of ${formatUnits(view.alloc.requested)} requested` : "Run a solve"}
        />
        <Kpi
          label="Late (solved)"
          value={solve ? formatUnits(view.alloc.late) : "—"}
          detail="made, but after the week the customer needed it"
        />
        <Kpi
          label="Lost to component allocation"
          value={solve ? formatUnits(view.alloc.liquidShort) : "—"}
          detail="the supplier allocation for that year is exhausted"
        />
        <Kpi
          label="Lines short of capacity (live)"
          value={`${view.linesShort} of ${data.lines.length}`}
          detail={`${view.linesPeaking} more peak above capacity in some weeks but can pre-build`}
        />
      </div>

      <Card className="p-4">
        <h2 className="card-title">Production lines</h2>
        <p className="mt-1 text-xs text-text-tertiary">
          Required load is the unconstrained planned production from the live plan. The bar shows
          peak required load as a share of effective capacity (capacity less changeover); the
          centre mark is 100%. A line that only peaks can be smoothed by building ahead; a line
          whose cumulative requirement outruns its cumulative capacity needs more capacity or a
          lower plan. Select a line to see it week by week.
        </p>
        <Table className="mt-3 [&_td]:whitespace-normal [&_th]:whitespace-normal">
          <TableCaption className="sr-only">Production lines with capacity, peak required load and weeks over capacity</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>LINE</TableHead>
              <TableHead className="hidden lg:table-cell">SITE</TableHead>
              <TableHead className="hidden text-right sm:table-cell">CAPACITY (PCS / WK)</TableHead>
              <TableHead>PEAK REQUIRED / CAPACITY</TableHead>
              <TableHead className="hidden text-right md:table-cell">WEEKS OVER</TableHead>
              <TableHead>VERDICT</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.lineRows.map((row) => (
              <TableRow
                key={row.lineId}
                className={cn("cursor-pointer", row.lineId === lineId && "bg-accent-subtle")}
                onClick={() => setSelectedLine(row.lineId)}
              >
                <TableCell className="font-medium">{row.lineName}</TableCell>
                <TableCell className="hidden text-text-tertiary lg:table-cell">{row.siteName}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{Math.round(row.effectiveCapacity).toLocaleString("en-GB")}</TableCell>
                <TableCell>
                  <MeterBar
                    ratio={row.peakRatio}
                    over={row.peakRatio > 1}
                    label={`${(row.peakRatio * 100).toFixed(0)}%`}
                  />
                </TableCell>
                <TableCell className="hidden text-right tabular-nums md:table-cell">{row.weeksOver}</TableCell>
                <TableCell>
                  {row.cumulativeShortfall > 0 ? (
                    <Badge className="h-auto whitespace-normal bg-negative-subtle text-negative">Needs capacity</Badge>
                  ) : row.weeksOver > 0 ? (
                    <Badge className="h-auto whitespace-normal bg-warning-subtle text-warning">Peaks: pre-build</Badge>
                  ) : (
                    <Badge className="h-auto whitespace-normal bg-positive-subtle text-positive">Within capacity</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {chartLine && (
        <Card className="p-4">
          <h2 className="card-title">{chartLine.lineName}: required vs produced</h2>
          <p className="mt-1 text-xs text-text-tertiary">
            Required (live, unconstrained) against produced (constrained solve), in pieces per
            week, with effective capacity as the reference line. Where required runs above the
            line, the solve carries the excess into later weeks and it arrives late.
          </p>
          <div
            className="mt-3 h-72"
            role="img"
            aria-label={`${chartLine.lineName}: weekly required load from the live plan and produced volume from the constrained solve, against effective capacity of ${Math.round(chartLine.effectiveCapacity).toLocaleString("en-GB")} units per week.`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="week" tickLine={false} interval={5} />
                <YAxis tickLine={false} width={64} domain={[0, "auto"]}
                  tickFormatter={(v: number) => formatUnits(v).replace(" pcs", "")} />
                <Tooltip formatter={(v) => formatUnits(Number(v))} />
                <Bar dataKey="required" name="Required (live)" fill={CHART_COLORS[0]} isAnimationActive={false} />
                <Bar dataKey="produced" name="Produced (solved)" fill={CHART_COLORS[1]} isAnimationActive={false} />
                <ReferenceLine y={chartLine.effectiveCapacity} stroke="var(--negative)" strokeDasharray="4 3"
                  label={{ value: "Capacity", position: "insideTopRight", fill: "var(--negative)" }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="p-4">
          <h2 className="card-title">Bought components coverage</h2>
          <p className="mt-1 text-xs text-text-tertiary">
            Opening stock plus supplier deliveries against what the live plan consumes. Inside an
            item's lead time only what is already on order arrives; the supplier can flex up from
            the week after. The first short week is when that item would stop the plan if nothing
            changes.
          </p>
          <Table className="mt-3 [&_td]:whitespace-normal [&_th]:whitespace-normal">
            <TableCaption className="sr-only">Bought components with lead time and first week of shortfall</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>ITEM</TableHead>
                <TableHead className="hidden text-right sm:table-cell">LEAD (WKS)</TableHead>
                <TableHead className="hidden sm:table-cell">FIRST SHORT WEEK</TableHead>
                <TableHead>STATUS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.dryGoods.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-text-tertiary">No dry-goods need in this plan.</TableCell></TableRow>
              )}
              {[...data.dryGoods]
                .sort((a, b) => (a.firstShortWeek ?? 99) - (b.firstShortWeek ?? 99))
                .map((item) => {
                  const week = item.firstShortWeek ? data.weeks[item.firstShortWeek - 1] : null;
                  const actNow = item.firstShortWeek !== null && item.firstShortWeek <= item.leadWeeks;
                  return (
                    <TableRow key={item.itemId}>
                      <TableCell className="font-medium">{item.name}</TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">{item.leadWeeks}</TableCell>
                      <TableCell className="hidden tabular-nums sm:table-cell">{week ? `${formatWeekShort(week.weekId)} (week ${item.firstShortWeek})` : "Covered"}</TableCell>
                      <TableCell>
                        {item.firstShortWeek === null ? (
                          <Badge className="bg-positive-subtle text-positive">Covered</Badge>
                        ) : actNow ? (
                          <Badge className="bg-negative-subtle text-negative">Inside lead time</Badge>
                        ) : (
                          <Badge className="bg-warning-subtle text-warning">Order ahead</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-4">
          <h2 className="card-title">Component allocation fill</h2>
          <p className="mt-1 text-xs text-text-tertiary">
            The share of each part family&apos;s plan its tightest allocated component can cover:
            microcontrollers, SiC power modules and rare-earth magnets. Allocations are agreed yearly,
            so a shortfall cannot be fixed this year by building more.
          </p>
          <Table className="mt-3 [&_td]:whitespace-normal [&_th]:whitespace-normal">
            <TableCaption className="sr-only">Part families and the share of plan their allocated components can cover in 2026 and 2027</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>PART FAMILY</TableHead>
                <TableHead className="hidden md:table-cell">COMPONENT</TableHead>
                <TableHead>2026 FILL</TableHead>
                <TableHead>2027 FILL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.liquidRows.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-text-tertiary">No part families on allocated components in this scope.</TableCell></TableRow>
              )}
              {view.liquidRows.map((row) => (
                <TableRow key={row.product}>
                  <TableCell className="font-medium">{row.product}</TableCell>
                  <TableCell className="hidden text-text-tertiary md:table-cell">{row.family}</TableCell>
                  {[row.y2026, row.y2027].map((f, i) => (
                    <TableCell key={i}>
                      <MeterBar compact ratio={(f ?? 1) * 2} over={(f ?? 1) < 1}
                        label={f === null ? "—" : `${(f * 100).toFixed(0)}%${f < 1 ? " short" : ""}`} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card className="p-4">
        <h2 className="card-title">Constrained allocation by customer</h2>
        <p className="mt-1 text-xs text-text-tertiary">
          From the last solve. Scarce capacity and components go to line-stop-critical parts first, then
          pro-rata within each tier. Late units are made after the week the customer needed them;
          unmet units are not made inside the 52-week horizon.
        </p>
        <Table className="mt-3 [&_td]:whitespace-normal [&_th]:whitespace-normal">
          <TableCaption className="sr-only">Requested, on-time, late, allocation-short and unmet units by customer from the constrained solve</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>CUSTOMER</TableHead>
              <TableHead className="text-right">REQUESTED (PCS)</TableHead>
              <TableHead>ON TIME</TableHead>
              <TableHead className="hidden text-right md:table-cell">LATE (PCS)</TableHead>
              <TableHead className="hidden text-right lg:table-cell">ALLOCATION SHORT (PCS)</TableHead>
              <TableHead className="hidden text-right lg:table-cell">UNMET (PCS)</TableHead>
              <TableHead className="hidden text-right sm:table-cell">LINE-STOP CRITICAL ON TIME</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.customerRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-text-tertiary">
                  {solve ? "Nothing to allocate in this scope." : "No solve yet for this plan. Run one to see allocation."}
                </TableCell>
              </TableRow>
            )}
            {view.customerRows.map((row) => (
              <TableRow key={row.customer}>
                <TableCell className="font-medium">{row.customer}</TableCell>
                <TableCell className="text-right tabular-nums">{Math.round(row.requested).toLocaleString("en-GB")}</TableCell>
                <TableCell>
                  <MeterBar ratio={(row.onTime / (row.requested || 1)) * 2} over={row.onTime / (row.requested || 1) < 0.95}
                    label={pct(row.onTime, row.requested)} />
                </TableCell>
                <TableCell className="hidden text-right tabular-nums md:table-cell">{Math.round(row.late).toLocaleString("en-GB")}</TableCell>
                <TableCell className="hidden text-right tabular-nums lg:table-cell">{Math.round(row.liquidShort).toLocaleString("en-GB")}</TableCell>
                <TableCell className="hidden text-right tabular-nums lg:table-cell">{Math.round(row.unmet).toLocaleString("en-GB")}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{pct(row.strategicOnTime, row.strategicRequested)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-4">
        <h2 className="card-title">What binds</h2>
        <p className="mt-1 text-xs text-text-tertiary">
          Units that arrive late, are lost to a component allocation or go unmet, by the constraint that first
          held them back in the solve.
        </p>
        <Table className="mt-3 [&_td]:whitespace-normal [&_th]:whitespace-normal">
          <TableCaption className="sr-only">Constraints ranked by the units they held back</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>CONSTRAINT</TableHead>
              <TableHead className="text-right">UNITS AFFECTED (PCS)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.binding.length === 0 && (
              <TableRow><TableCell colSpan={2} className="text-text-tertiary">{solve ? "Nothing binds in this scope." : "No solve yet."}</TableCell></TableRow>
            )}
            {data.binding.map((b) => (
              <TableRow key={`${b.kind}-${b.item ?? ""}`}>
                <TableCell>{bindingLabel(b.kind, b.item, data.dryGoods)}</TableCell>
                <TableCell className="text-right tabular-nums">{Math.round(b.units).toLocaleString("en-GB")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <p className="text-xs text-text-tertiary">
        Illustrative network: five Vectron plants (Regensburg, Plzeň, Wrocław, Debrecen, San Luis
        Potosí), fourteen lines and contract manufacturers for commodity aftermarket parts. Capacities are sized from 2025 shipments; lot-size excess
        is held as line stock and not charged against capacity.
      </p>
    </div>
  );
}

function bindingLabel(kind: string, item: string | null, dry: SupplyData["dryGoods"]): string {
  if (kind === "capacity") return "Production line capacity";
  if (kind === "liquid") return "Component allocation";
  if (kind === "dry") return `Bought component: ${dry.find((d) => d.itemId === item)?.name ?? item ?? "unknown"}`;
  return kind;
}

function deriveView(data: SupplyData) {
  const liveByLine = new Map<string, Map<number, number>>();
  for (const r of data.liveLineLoad) {
    const m = liveByLine.get(r.lineId) ?? new Map<number, number>();
    m.set(r.weekNo, (m.get(r.weekNo) ?? 0) + r.load);
    liveByLine.set(r.lineId, m);
  }
  const solvedByLine = new Map<string, Map<number, number>>();
  for (const r of data.solvedLineLoad) {
    const m = solvedByLine.get(r.lineId) ?? new Map<number, number>();
    m.set(r.weekNo, r.produced);
    solvedByLine.set(r.lineId, m);
  }

  let linesShort = 0;
  let linesPeaking = 0;
  const lineRows = data.lines.map((line) => {
    const weeks = liveByLine.get(line.lineId) ?? new Map<number, number>();
    let peak = 0;
    let weeksOver = 0;
    // Worst point at which cumulative requirement exceeds cumulative capacity:
    // if it never does, every peak could have been built ahead of time.
    let cumGap = 0;
    let cumulativeShortfall = 0;
    for (const w of data.weeks) {
      const load = weeks.get(w.weekNo) ?? 0;
      peak = Math.max(peak, load);
      if (load > line.effectiveCapacity + 1e-6) weeksOver += 1;
      cumGap += load - line.effectiveCapacity;
      cumulativeShortfall = Math.max(cumulativeShortfall, cumGap);
    }
    if (cumulativeShortfall > 0) linesShort += 1;
    else if (weeksOver > 0) linesPeaking += 1;
    return {
      ...line,
      peakRatio: line.effectiveCapacity > 0 ? peak / line.effectiveCapacity : 0,
      weeksOver,
      cumulativeShortfall,
    };
  }).sort((a, b) => b.cumulativeShortfall - a.cumulativeShortfall || b.peakRatio - a.peakRatio);

  const lineChart = (lineId: string) =>
    data.weeks.map((w) => ({
      week: formatWeekShort(w.weekId),
      required: liveByLine.get(lineId)?.get(w.weekNo) ?? 0,
      produced: solvedByLine.get(lineId)?.get(w.weekNo) ?? 0,
    }));

  const customers = new Map<string, {
    customer: string; requested: number; onTime: number; late: number; liquidShort: number;
    unmet: number; strategicRequested: number; strategicOnTime: number;
  }>();
  const alloc = { requested: 0, onTime: 0, late: 0, liquidShort: 0, unmet: 0 };
  for (const r of data.allocation) {
    const m = customers.get(r.customer) ?? {
      customer: r.customer, requested: 0, onTime: 0, late: 0, liquidShort: 0, unmet: 0,
      strategicRequested: 0, strategicOnTime: 0,
    };
    m.requested += r.requested; m.onTime += r.onTime; m.late += r.late;
    m.liquidShort += r.liquidShort; m.unmet += r.unmet;
    if (r.tier === 1) { m.strategicRequested += r.requested; m.strategicOnTime += r.onTime; }
    customers.set(r.customer, m);
    alloc.requested += r.requested; alloc.onTime += r.onTime; alloc.late += r.late;
    alloc.liquidShort += r.liquidShort; alloc.unmet += r.unmet;
  }
  const customerRows = [...customers.values()].sort((a, b) => b.requested - a.requested);

  const liquid = new Map<string, { product: string; family: string; y2026: number | null; y2027: number | null }>();
  for (const r of data.liquidFill) {
    const row = liquid.get(r.product) ?? { product: r.product, family: r.family, y2026: null, y2027: null };
    if (r.year === 2026) row.y2026 = r.fillRatio;
    if (r.year === 2027) row.y2027 = r.fillRatio;
    liquid.set(r.product, row);
  }
  const liquidRows = [...liquid.values()].sort(
    (a, b) => Math.min(a.y2026 ?? 1, a.y2027 ?? 1) - Math.min(b.y2026 ?? 1, b.y2027 ?? 1),
  );

  return { lineRows, linesShort, linesPeaking, lineChart, customerRows, alloc, liquidRows };
}
