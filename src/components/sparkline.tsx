"use client";

/**
 * Sparkline — history in word-sized space, no axes.
 *
 * Called for by the chart-selection guide ("compact inline trend") and by the
 * data-table component spec ("inline sparklines"). Neither existed in the app.
 *
 * Deliberately hand-rolled SVG rather than a Recharts chart: at 20-32px tall a
 * Recharts instance carries a ResponsiveContainer, tooltip layer and axis
 * machinery that costs far more than the mark is worth, and at this size none of
 * it is usable anyway. Colour comes from tokens so it re-tints with the theme.
 */

import React from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** Series values in display order. Nulls are treated as gaps, not zeros. */
  data: Array<number | null | undefined>;
  width?: number;
  height?: number;
  /** Token-backed stroke colour. Defaults to the accent. */
  stroke?: string;
  /** Fill the area under the line at low opacity. */
  area?: boolean;
  /** Mark the final point, which is usually the one being read. */
  showLast?: boolean;
  /** Accessible description. Without this the mark is decorative to a screen reader. */
  label?: string;
  className?: string;
}

export function Sparkline({
  data,
  width = 72,
  height = 20,
  stroke = "var(--accent)",
  area = false,
  showLast = true,
  label,
  className,
}: Props) {
  const points = data.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const present = points.filter((v): v is number => v != null);

  // A single point cannot describe a trend, so render nothing rather than a
  // misleading flat line.
  if (present.length < 2) {
    return (
      <span
        className={cn("inline-block align-middle text-[10px] text-muted-foreground", className)}
        style={{ width, height }}
        aria-hidden={!label}
      >
        —
      </span>
    );
  }

  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  const pad = 1.5; // keep the stroke inside the viewBox
  const stepX = (width - pad * 2) / (points.length - 1);

  const xy = points.map((v, i) => {
    if (v == null) return null;
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  // Break the path at gaps rather than interpolating across missing data.
  const segments: string[] = [];
  let current: string[] = [];
  for (const p of xy) {
    if (p == null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
    } else {
      current.push(`${current.length === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`);
    }
  }
  if (current.length > 1) segments.push(current.join(" "));

  const lastPoint = [...xy].reverse().find((p) => p != null) ?? null;

  const areaPath =
    area && segments.length === 1
      ? `${segments[0]} L${(width - pad).toFixed(2)},${(height - pad).toFixed(2)} L${pad.toFixed(2)},${(height - pad).toFixed(2)} Z`
      : null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("inline-block align-middle overflow-visible", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {areaPath && <path d={areaPath} fill="var(--chart-band)" stroke="none" />}
      {segments.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {showLast && lastPoint && (
        <circle cx={lastPoint[0]} cy={lastPoint[1]} r={1.75} fill={stroke} stroke="none" />
      )}
    </svg>
  );
}
