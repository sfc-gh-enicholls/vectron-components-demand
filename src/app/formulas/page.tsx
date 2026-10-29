"use client";

import * as React from "react";
import Link from "next/link";
import { Sigma, CheckCircle2, AlertTriangle } from "lucide-react";
import { PageBanner } from "@/components/page-banner";
import { PageSkeleton } from "@/components/page-skeleton";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface MeasureRow {
  code: string;
  label: string;
  unit: string;
  group: string;
  calcType: "INPUT" | "FORMULA";
  visible: boolean;
  editable: boolean;
  source: string | null;
  description: string | null;
  version: number | null;
  expression: string | null;
  aggExpression: string | null;
  additive: boolean;
  dependsOn: string[];
  usedBy: string[];
}

interface ReconcileRow {
  measure: string;
  engine: number;
  reference: number;
  difference: number;
  ok: boolean;
  source: string;
}

const GROUP_ORDER = ["volume", "driver", "value", "rate", "assumption"];
const GROUP_LABEL: Record<string, string> = {
  volume: "Volume",
  driver: "Drivers",
  value: "Value",
  rate: "Per-case rates",
  assumption: "Assumptions",
};

function Expr({ text }: { text: string | null }) {
  if (!text) return <span className="text-text-tertiary">—</span>;
  return <code className="whitespace-pre-wrap break-words font-mono text-[12px]">{text}</code>;
}

function nodeRule(measure: MeasureRow): string {
  if (measure.aggExpression) return measure.aggExpression;
  if (measure.additive) return "Sum of children";
  return "Not defined above a series";
}

export default function FormulasPage() {
  const [measures, setMeasures] = React.useState<MeasureRow[] | null>(null);
  const [reconcile, setReconcile] = React.useState<{ ok: boolean; checks: ReconcileRow[]; worstLeafPlanError: number; leaves: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/measures")
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) setError(json.error);
        else setMeasures(json.measures);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    fetch("/api/measures?reconcile=1")
      .then((res) => res.json())
      .then((json) => !cancelled && !json.error && setReconcile(json))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="p-6"><Card className="p-4 text-sm text-negative" role="alert">{error}</Card></div>;
  if (!measures) return <div className="p-6"><PageSkeleton kpis={0} chart={false} rows={10} /></div>;

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <PageBanner
        eyebrow="Calculation"
        headline="Formula library"
        subtitle="Every derived number in the planning grid is computed from these formulas, stored as data in CORE.DIM_MEASURE_FORMULA and evaluated in dependency order. The leaf rule applies to one series in one week; the node rule applies to any total above it."
        icon={<Sigma size={18} aria-hidden="true" />}
        metadata={<Link href="/plan" className="text-[13px] underline-offset-4 hover:underline">Back to the consensus plan</Link>}
      />

      <Card className="space-y-2 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          {reconcile?.ok ? (
            <CheckCircle2 size={15} className="text-positive" aria-hidden="true" />
          ) : (
            <AlertTriangle size={15} className="text-warning" aria-hidden="true" />
          )}
          Reconciliation with the published views
        </div>
        {!reconcile ? (
          <p className="text-xs text-text-tertiary">Checking…</p>
        ) : (
          <>
            <p className="text-xs text-neutral">
              Evaluated across {reconcile.leaves.toLocaleString("en-GB")} series-weeks of the committed plan. The largest gap
              between the formula plan and the committed plan in any single cell is{" "}
              <span className="num">{reconcile.worstLeafPlanError.toExponential(1)}</span> units.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Measure</TableHead>
                  <TableHead className="num">Formulas</TableHead>
                  <TableHead className="num">Published</TableHead>
                  <TableHead className="num">Difference</TableHead>
                  <TableHead>Compared with</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reconcile.checks.map((check) => (
                  <TableRow key={check.measure}>
                    <TableCell className="font-mono text-xs">{check.measure}</TableCell>
                    <TableCell className="num">{check.engine.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className="num">{check.reference.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</TableCell>
                    <TableCell className={cn("num", check.ok ? "text-positive" : "text-negative")}>
                      {check.difference.toExponential(1)}
                    </TableCell>
                    <TableCell className="text-xs text-text-tertiary">{check.source}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>

      <Card className="p-3 text-xs text-neutral">
        The driver factors are an ordered decomposition (events, then promotions, then stream inputs, then the planner),
        so they multiply back to the plan exactly. Like the driver waterfall, a different order would split the same total
        differently: they explain the plan, they are not independent causes.
      </Card>

      {GROUP_ORDER.map((group) => {
        const rows = measures.filter((measure) => measure.group === group);
        if (rows.length === 0) return null;
        return (
          <Card key={group} className="overflow-hidden">
            <div className="border-b border-border px-4 py-2 text-[11px] uppercase text-text-tertiary">
              {GROUP_LABEL[group] ?? group}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[220px]">Measure</TableHead>
                  <TableHead>Leaf rule (series × week)</TableHead>
                  <TableHead>Node rule (any total)</TableHead>
                  <TableHead className="w-[200px]">Used by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((measure) => (
                  <TableRow key={measure.code} className="align-top">
                    <TableCell>
                      <div className="font-medium">{measure.label}</div>
                      <div className="font-mono text-[11px] text-text-tertiary">
                        [{measure.code}] · {measure.unit}
                        {measure.version ? ` · v${measure.version}` : ""}
                        {measure.editable ? " · editable" : ""}
                      </div>
                      {measure.description && <div className="mt-1 text-[11px] text-neutral">{measure.description}</div>}
                    </TableCell>
                    <TableCell>
                      {measure.calcType === "INPUT" ? (
                        <span className="text-xs text-neutral">Input: {measure.source ?? "—"}</span>
                      ) : (
                        <Expr text={measure.expression} />
                      )}
                    </TableCell>
                    <TableCell>
                      {measure.aggExpression ? <Expr text={measure.aggExpression} /> : <span className="text-xs text-neutral">{nodeRule(measure)}</span>}
                    </TableCell>
                    <TableCell className="text-[11px] text-text-tertiary">
                      {measure.usedBy.length ? measure.usedBy.join(", ") : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        );
      })}
    </div>
  );
}
