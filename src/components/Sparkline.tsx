"use client";

import { LineChart, Line, ResponsiveContainer } from "recharts";

interface SparklineProps {
  points: Array<{ nav: number }>;
  /** Whether the latest value is above or below the first — drives colour. */
  direction: "up" | "down" | "flat";
  height?: number;
}

export default function Sparkline({ points, direction, height = 36 }: SparklineProps) {
  const color =
    direction === "up" ? "#1F5C3A" : direction === "down" ? "#7A1F1F" : "#9A9A8E";

  if (points.length < 2) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          fontSize: 10,
          color: "#9A9A8E",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Insufficient history
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={points}
          margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
        >
          <Line
            type="monotone"
            dataKey="nav"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
