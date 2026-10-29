"use client";

/**
 * Bullet chart — actual vs target vs tolerance in one mark.
 *
 * The chart-selection guide names this as the correct mark for "variance from
 * target", which is the single most common thing this app displays: working
 * revenue vs AOP, plan vs finance target, GM vs floor. Those were all rendered
 * as paired bars or bare numbers, which forces the reader to do the comparison
 * themselves.
 *
 * Anatomy (Few's design, simplified):
 *   - a quiet qualitative range band (the tolerance zone)
 *   - a thick measure bar (the actual)
 *   - a perpendicular tick (the target)
 *
 * Hand-rolled SVG for the same reason as Sparkline: Recharts has no bullet mark,
 * and composing one from stacked bars would be more code and less legible.
 */

import React from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** The measured value. */
  actual: number;
  /** The value being measured against. Rendered as the target tick. */
  target: number;
  /**
   * Tolerance around the target, as a fraction (0.1 = ±10%). Shaded as the
   * acceptable band. Omit for no band.
   */
  tolerance?: number;
  /** Scale maximum. Defaults to a sensible headroom above the larger of the two. */
  max?: number;
  /** Row label. */
  label?: string;
  /** Pre-formatted value text shown on the right. */
  valueLabel?: string;
  /** Whether being under target is the bad direction. Defaults to true. */
  lowerIsWorse?: boolean;
  height?: number;
  className?: string;
}

export function BulletChart({
  actual,
  target,
  tolerance,
  max,
  label,
  valueLabel,
  lowerIsWorse = true,
  height = 10,
  className,
}: Props) {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const safeActual = Number.isFinite(actual) ? actual : 0;
  const scaleMax = max ?? (Math.max(safeActual, safeTarget) * 1.15 || 1);

  const pct = (v: number) => Math.max(0, Math.min(100, (v / scaleMax) * 100));

  // Is the actual inside tolerance? Drives the measure-bar colour. Colour is
  // paired with the target tick and the text label, never used alone.
  const withinTolerance =
    tolerance == null
      ? safeActual >= safeTarget
      : lowerIsWorse
        ? safeActual >= safeTarget * (1 - tolerance)
        : Math.abs(safeActual - safeTarget) <= safeTarget * tolerance;

  const barColour = withinTolerance ? "var(--positive)" : "var(--negative)";

  const bandLow = tolerance != null ? Math.max(0, safeTarget * (1 - tolerance)) : null;
  const bandHigh = tolerance != null ? safeTarget * (1 + tolerance) : null;

  return (
    <div className={cn("w-full", className)}>
      {(label || valueLabel) && (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          {label && (
            <span className="text-[10px] font-medium uppercase text-muted-foreground">
              {label}
            </span>
          )}
          {valueLabel && (
            <span
              className="font-mono text-[11px] tabular-nums"
              style={{ color: barColour }}
            >
              {valueLabel}
            </span>
          )}
        </div>
      )}
      <div
        className="relative w-full rounded-full bg-muted"
        style={{ height }}
        role="img"
        aria-label={
          label
            ? `${label}: ${safeActual.toLocaleString()} against target ${safeTarget.toLocaleString()}${
                withinTolerance ? ", within tolerance" : ", outside tolerance"
              }`
            : undefined
        }
      >
        {/* Tolerance band */}
        {bandLow != null && bandHigh != null && (
          <div
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${pct(bandLow)}%`,
              width: `${Math.max(0, pct(bandHigh) - pct(bandLow))}%`,
              backgroundColor: "var(--chart-band)",
            }}
            aria-hidden
          />
        )}
        {/* Measure bar — inset so the band stays readable behind it */}
        <div
          className="absolute rounded-full"
          style={{
            top: height * 0.25,
            height: height * 0.5,
            left: 0,
            width: `${pct(safeActual)}%`,
            backgroundColor: barColour,
          }}
          aria-hidden
        />
        {/* Target tick */}
        <div
          className="absolute w-[2px] rounded-full bg-foreground"
          style={{ top: -2, bottom: -2, left: `calc(${pct(safeTarget)}% - 1px)` }}
          aria-hidden
        />
      </div>
    </div>
  );
}
