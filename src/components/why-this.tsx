"use client";

/**
 * WhyThis — the explainability affordance.
 *
 * Design-system principle: "never show a number without explaining why". Any
 * figure that came out of a model, a rule, or an aggregation can be wrapped in
 * this component to expose its provenance on demand — top contributing drivers,
 * the model that produced it, its confidence, and the prediction interval.
 *
 * Deliberately a popover rather than a tooltip: the content is interactive and
 * needs to survive a mouse leave so a planner can read the driver list and
 * click through to the lever. Progressive disclosure — the summary stays
 * inline, the reasoning is one click away and never blocks the scan path.
 */

import React from "react";
import { Popover } from "@base-ui/react/popover";
import { HelpCircle, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WhyThisDriver {
  /** Human-readable driver name, e.g. "Promotional uplift" or "Seasonality". */
  label: string;
  /** Signed contribution in the same unit as the explained value. */
  contribution: number;
  /** Optional share of total movement, 0-1. Rendered as a proportion bar. */
  share?: number;
}

export interface WhyThisProps {
  /** Short description of what is being explained, e.g. "Sep 26 demand plan". */
  subject: string;
  /** Ranked drivers, highest absolute contribution first. */
  drivers?: WhyThisDriver[];
  /** Model or rule that produced the number. */
  source?: string;
  /** Model confidence, 0-1. Rendered as a percentage with a qualitative band. */
  confidence?: number;
  /** 95% prediction interval, if the number came from a statistical forecast. */
  interval?: { lower: number; upper: number };
  /** Formatter for every numeric value shown. Defaults to locale integer. */
  formatValue?: (v: number) => string;
  /** Optional free-text rationale, e.g. an agent's stated reasoning. */
  rationale?: string;
  /** Shown in place of the driver list when `drivers` is empty. Without this, an
   *  empty driver list renders as nothing, which reads as a broken feature rather
   *  than an honest "nothing has moved this number yet". */
  noDriversLabel?: string;
  /** Optional action path — satisfies "insight to action in one click". */
  action?: { label: string; onClick: () => void };
  /** Override the trigger. Defaults to a small muted question-mark icon. */
  children?: React.ReactNode;
  className?: string;
}

function confidenceBand(c: number): { label: string; className: string } {
  if (c >= 0.85) return { label: "High", className: "text-positive" };
  if (c >= 0.6) return { label: "Moderate", className: "text-warning" };
  return { label: "Low", className: "text-negative" };
}

/** Colour is always paired with a shape, per the accessibility rule. */
function DirectionMark({ value }: { value: number }) {
  if (value > 0) return <TrendingUp size={11} className="text-positive shrink-0" aria-hidden />;
  if (value < 0) return <TrendingDown size={11} className="text-negative shrink-0" aria-hidden />;
  return <Minus size={11} className="text-muted-foreground shrink-0" aria-hidden />;
}

export function WhyThis({
  subject,
  drivers = [],
  source,
  confidence,
  interval,
  formatValue = (v) => Math.round(v).toLocaleString(),
  rationale,
  noDriversLabel,
  action,
  children,
  className,
}: WhyThisProps) {
  const ranked = React.useMemo(
    () => [...drivers].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    [drivers],
  );
  const maxAbs = ranked.length > 0 ? Math.abs(ranked[0].contribution) : 0;
  const band = confidence != null ? confidenceBand(confidence) : null;

  const hasContent =
    ranked.length > 0 || source != null || confidence != null || interval != null || rationale != null;

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Why is ${subject} this value?`}
        className={cn(
          "inline-flex items-center justify-center rounded-sm text-muted-foreground",
          "transition-colors duration-200 ease-out hover:text-foreground",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          className,
        )}
      >
        {children ?? <HelpCircle size={12} strokeWidth={1.5} aria-hidden />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            className={cn(
              "z-50 w-80 rounded-xl border border-border bg-popover p-4 text-popover-foreground",
              "shadow-[var(--shadow-dropdown)]",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
              "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            )}
          >
            <Popover.Title className="text-[10px] font-medium uppercase text-muted-foreground">
              Why this number
            </Popover.Title>
            <p className="mt-1 text-[13px] leading-relaxed font-medium">{subject}</p>

            {!hasContent && (
              <p className="mt-3 text-xs text-muted-foreground italic">
                No explanation is recorded for this value.
              </p>
            )}

            {ranked.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <div className="text-[9px] font-medium uppercase text-muted-foreground">
                  Top drivers
                </div>
                {ranked.slice(0, 5).map((d) => (
                  <div key={d.label} className="flex items-center gap-2">
                    <DirectionMark value={d.contribution} />
                    <span className="flex-1 truncate text-xs">{d.label}</span>
                    <span className="font-mono text-xs tabular-nums text-right">
                      {d.contribution > 0 ? "+" : ""}
                      {formatValue(d.contribution)}
                    </span>
                  </div>
                ))}
                {/* Proportion bars, drawn only when we can scale them honestly. */}
                {maxAbs > 0 && (
                  <div className="flex gap-0.5 pt-1" aria-hidden>
                    {ranked.slice(0, 5).map((d) => (
                      <div
                        key={d.label}
                        className="h-0.5 rounded-full bg-accent"
                        style={{ flexGrow: Math.max(Math.abs(d.contribution) / maxAbs, 0.02) }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {ranked.length === 0 && noDriversLabel && (
              <div className="mt-3">
                <div className="text-[9px] font-medium uppercase text-muted-foreground">
                  Top drivers
                </div>
                <p className="mt-1 text-xs text-muted-foreground italic">{noDriversLabel}</p>
              </div>
            )}

            {rationale && (
              <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
                {rationale}
              </p>
            )}

            {(source || confidence != null || interval) && (
              <dl className="mt-3 space-y-1 border-t border-border pt-3 text-[11px]">
                {source && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Source</dt>
                    <dd className="truncate font-medium">{source}</dd>
                  </div>
                )}
                {confidence != null && band && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Confidence</dt>
                    <dd className={cn("font-medium tabular-nums", band.className)}>
                      {(confidence * 100).toFixed(0)}% · {band.label}
                    </dd>
                  </div>
                )}
                {interval && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">95% interval</dt>
                    <dd className="font-mono tabular-nums">
                      {formatValue(interval.lower)} – {formatValue(interval.upper)}
                    </dd>
                  </div>
                )}
              </dl>
            )}

            {action && (
              <button
                onClick={action.onClick}
                className={cn(
                  "mt-3 w-full rounded-lg bg-accent px-3 py-2",
                  "text-[11px] font-semibold uppercase text-accent-on",
                  "transition-opacity duration-200 ease-out hover:opacity-90",
                )}
              >
                {action.label}
              </button>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
