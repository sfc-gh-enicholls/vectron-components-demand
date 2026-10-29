"use client";

/**
 * Kpi: the one headline-number tile, in the product's `.kpi` pattern.
 *
 * Every KPI row used to hand-build its tiles, and they drifted: tiles wrapped
 * in WhyThis inherited the popover trigger's centring and muted colour, while
 * plain tiles picked up the shadcn Card's 16px gap between lines, so one row
 * mixed centred and left-aligned numbers at different heights. One component
 * fixes the anatomy: caps label, value, one detail line, then any extra
 * content, all top-left aligned, with the explanation popover (when given)
 * wrapping the whole body without changing its layout.
 */

import * as React from "react";
import { WhyThis, type WhyThisProps } from "@/components/why-this";
import { cn } from "@/lib/utils";

export function Kpi({
  label,
  value,
  detail,
  why,
  valueClassName,
  bare = false,
  className,
  children,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  /** The single line under the value: a delta, a count, a caveat. */
  detail?: React.ReactNode;
  /** When set, the tile body opens the "why this number" popover. */
  why?: Omit<WhyThisProps, "children" | "className">;
  /** Colour or emphasis on the value only, e.g. a signed saving. */
  valueClassName?: string;
  /** A stat inside a larger card: same anatomy, no border or padding of its own. */
  bare?: boolean;
  className?: string;
  /** Anything below the detail line: chips, a sparkline, a bullet chart. */
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className={cn("v tabular-nums", valueClassName)}>{value}</div>
      {detail != null && detail !== false && <div className="d">{detail}</div>}
      {children != null && children !== false && <div className="mt-2">{children}</div>}
    </>
  );
  return (
    <div className={cn("kpi flex min-w-0 flex-col", !bare && "card", className)}>
      {why ? (
        <WhyThis {...why} className="flex w-full cursor-help flex-col items-stretch justify-start text-left text-foreground hover:text-foreground">
          {body}
        </WhyThis>
      ) : (
        body
      )}
    </div>
  );
}

/** The row of tiles: four across on wide screens, two on tablets. */
export function KpiRow({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}>{children}</div>;
}
