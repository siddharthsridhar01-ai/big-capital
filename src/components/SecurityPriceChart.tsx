"use client";

import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";

export interface PricePoint {
  date: string; // YYYY-MM-DD
  close: number;
}

const CCY_SYMBOLS: Record<string, string> = {
  GBP: "£", USD: "$", EUR: "€", JPY: "¥", HKD: "HK$", CNY: "¥",
  KRW: "₩", SGD: "S$", INR: "₹", TWD: "NT$",
};

// No "All" — with ~1y of history it duplicates 1Y.
const RANGES: { key: string; label: string; days: number }[] = [
  { key: "1D", label: "1D", days: 1 },
  { key: "1W", label: "1W", days: 7 },
  { key: "1M", label: "1M", days: 30 },
  { key: "3M", label: "3M", days: 90 },
  { key: "6M", label: "6M", days: 182 },
  { key: "1Y", label: "1Y", days: 365 },
];

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default function SecurityPriceChart({
  points,
  currency,
}: {
  points: PricePoint[];
  currency: string;
}) {
  const sym = CCY_SYMBOLS[currency] ?? "$";
  const [range, setRange] = useState<string>("1M");

  // Age of the series in days (for disabling ranges we can't cover)
  const spanDays = points.length > 0
    ? (Date.now() - new Date(points[0].date).getTime()) / 86400000
    : 0;

  const data = useMemo(() => {
    const r = RANGES.find((x) => x.key === range) ?? RANGES[2];
    const cutoff = Date.now() - r.days * 86400000;
    const inWindow = points.filter((p) => new Date(p.date).getTime() >= cutoff);
    if (inWindow.length >= 2) return inWindow;
    // Anchor: prepend the most recent point before the cutoff so the window
    // still spans "from ~N days ago to now" (matters for 1D/1W on daily data).
    const before = points.filter((p) => new Date(p.date).getTime() < cutoff);
    const anchor = before[before.length - 1] ?? points[0];
    const last = points[points.length - 1];
    return anchor && last && anchor !== last ? [anchor, last] : points.slice(-2);
  }, [points, range]);

  if (points.length < 2) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12.5, color: "#9A9A8E", padding: "8px 2px" }}>
        Not enough price history to chart yet.
      </div>
    );
  }

  const first = data[0]?.close ?? 0;
  const last = data[data.length - 1]?.close ?? 0;
  const up = last >= first;
  const stroke = up ? "#1F5C3A" : "#7A1F1F";
  const retPct = first !== 0 ? ((last - first) / first) * 100 : 0;

  const lo = Math.min(...data.map((d) => d.close));
  const hi = Math.max(...data.map((d) => d.close));
  const pad = Math.max((hi - lo) * 0.12, hi * 0.002);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 2 }}>
          {RANGES.map((r) => {
            // Disable a range if the series doesn't reach back far enough
            // (1D/1W always available; longer ones need ~half the span).
            const disabled = r.days > 7 && spanDays < r.days * 0.5;
            const active = r.key === range;
            return (
              <button
                key={r.key}
                onClick={() => !disabled && setRange(r.key)}
                disabled={disabled}
                style={{
                  padding: "3px 9px",
                  background: active ? "#00183A" : "transparent",
                  color: active ? "white" : disabled ? "#C8C8C0" : "#6B6B66",
                  border: "1px solid",
                  borderColor: active ? "#00183A" : "transparent",
                  borderRadius: 3,
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 11,
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
        <div
          style={{
            fontFamily: "system-ui, sans-serif",
            fontVariantNumeric: "tabular-nums",
            fontSize: 12.5,
            fontWeight: 600,
            color: up ? "#1F5C3A" : "#7A1F1F",
            whiteSpace: "nowrap",
          }}
        >
          {retPct >= 0 ? "▲" : "▼"} {Math.abs(retPct).toFixed(2)}%{" "}
          <span style={{ color: "#9A9A8E", fontWeight: 400 }}>· {range}</span>
        </div>
      </div>
      <div style={{ width: "100%", height: 180 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#9A9A8E" }}
              tickFormatter={fmtDate}
              axisLine={{ stroke: "#E5E5DE" }}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={[lo - pad, hi + pad]}
              tick={{ fontSize: 10, fill: "#9A9A8E" }}
              tickFormatter={(v) => `${sym}${Number(v).toFixed(2)}`}
              axisLine={false}
              tickLine={false}
              width={54}
            />
            <Tooltip
              contentStyle={{ background: "white", border: "1px solid #D9D9D2", fontSize: 12, fontFamily: "system-ui, sans-serif", padding: "6px 9px" }}
              labelStyle={{ color: "#6B6B66", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}
              labelFormatter={(l) => new Date(l).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
              formatter={((v: unknown) => [`${sym}${Number(v).toFixed(2)}`, "Close"]) as never}
            />
            <Line type="monotone" dataKey="close" stroke={stroke} strokeWidth={1.75} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
