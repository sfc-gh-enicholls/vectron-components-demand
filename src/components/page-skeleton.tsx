/**
 * Page-level loading skeleton.
 *
 * The design system is explicit that loading states are skeleton screens, never
 * spinners: a skeleton communicates the shape of what is arriving, so the layout
 * does not jump when it does. Two routes were still using a bare spinner div;
 * this replaces both with a structure that mirrors their real content.
 */

import React from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  /** Number of KPI tiles to outline. */
  kpis?: number;
  /** Render a wide chart placeholder below the KPI row. */
  chart?: boolean;
  /** Number of list/table rows to outline. */
  rows?: number;
  className?: string;
}

export function PageSkeleton({ kpis = 4, chart = true, rows = 5, className }: Props) {
  return (
    <div
      className={className ?? "p-6 space-y-4 max-w-[1600px] mx-auto"}
      aria-busy="true"
      aria-live="polite"
    >
      {/* Banner */}
      <Skeleton className="h-[152px] w-full rounded-xl" />

      {kpis > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: kpis }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-7 w-24" />
              <Skeleton className="mt-1.5 h-2.5 w-16" />
            </Card>
          ))}
        </div>
      )}

      {chart && (
        <Card className="p-4">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-3 h-[220px] w-full" />
        </Card>
      )}

      {rows > 0 && (
        <Card className="p-4 space-y-2">
          <Skeleton className="h-3 w-32" />
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-8 flex-1" />
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-16" />
            </div>
          ))}
        </Card>
      )}

      <span className="sr-only">Loading</span>
    </div>
  );
}
