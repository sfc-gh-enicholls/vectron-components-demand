"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_COLORS, formatUnits, formatWeekShort } from "@/lib/format";

interface AgentWeekChartProps {
  weeks: Array<{
    weekId: string;
    currentUnits: number;
    proposedUnits: number;
  }>;
  height?: number;
}

export function AgentWeekChart({ weeks, height = 196 }: AgentWeekChartProps) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={weeks} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={0.5} />
          <XAxis
            dataKey="weekId"
            tickFormatter={formatWeekShort}
            tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            stroke="var(--chart-grid)"
          />
          <YAxis
            tickFormatter={(value) => formatUnits(Number(value)).replace(" pcs", "")}
            tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            stroke="var(--chart-grid)"
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value, name) => [formatUnits(Number(value)), name]}
            labelFormatter={(value) => String(value)}
          />
          <Line
            dataKey="currentUnits"
            name="Current plan"
            stroke={CHART_COLORS[1]}
            strokeDasharray="4 3"
            strokeWidth={1.75}
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
          <Line
            dataKey="proposedUnits"
            name="Proposed scenario edit"
            stroke={CHART_COLORS[0]}
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}