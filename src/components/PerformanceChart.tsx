"use client";

import { useRef, useState } from "react";

export interface PerfPoint {
  date: string; // ISO yyyy-mm-dd
  fund: number; // cumulative % (e.g. 0.8 = +0.8%)
  benchmark: number | null;
}

const FUND_COLOR = "#00183A";
const BENCH_COLOR = "#8A6D1F";
const GRID = "#ECECE4";
const AXIS_TEXT = "#9A9A8E";

function niceTicks(min: number, max: number, count = 5): number[] {
  const range = max - min || 1;
  const rawStep = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function fmtDateLong(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function PerformanceChart({
  points,
  benchmarkName,
  bare = false,
}: {
  points: PerfPoint[];
  benchmarkName: string | null;
  bare?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const W = 920;
  const H = 280;
  const pad = { top: 18, right: 14, bottom: 34, left: 46 };

  if (points.length < 2) {
    return (
      <div
        style={{
          border: "1px solid #E5E5DE",
          background: "white",
          padding: "28px 22px",
          fontSize: 13,
          color: "#6B6B66",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        The performance chart will appear as daily data accumulates.
      </div>
    );
  }

  const hasBench = points.some((p) => p.benchmark != null);
  const vals: number[] = [0];
  for (const p of points) {
    vals.push(p.fund);
    if (p.benchmark != null) vals.push(p.benchmark);
  }
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const ticks = niceTicks(min, max, 5);
  const axisMin = Math.min(min, ticks[0]);
  const axisMax = Math.max(max, ticks[ticks.length - 1]);

  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const n = points.length;
  const x = (i: number) => pad.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number) => pad.top + (1 - (v - axisMin) / (axisMax - axisMin)) * plotH;

  const linePoints = (key: "fund" | "benchmark") =>
    points
      .map((p, i) => (key === "benchmark" && p.benchmark == null ? null : `${x(i).toFixed(1)},${y((p[key] as number)).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");

  // X date ticks: ~6 evenly spaced indices.
  const xTickCount = Math.min(6, n);
  const xTickIdx = Array.from({ length: xTickCount }, (_, k) =>
    Math.round((k / (xTickCount - 1)) * (n - 1))
  );

  const onMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fx = (e.clientX - rect.left) / rect.width; // 0..1 across full W
    const plotFracStart = pad.left / W;
    const plotFracEnd = (W - pad.right) / W;
    const t = (fx - plotFracStart) / (plotFracEnd - plotFracStart);
    const idx = Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    setHoverIdx(idx);
  };

  const hp = hoverIdx != null ? points[hoverIdx] : null;
  const hx = hoverIdx != null ? x(hoverIdx) : 0;

  // Tooltip box geometry (flip side near right edge).
  const tipW = 150;
  const tipRight = hx > W - tipW - 20;
  const tipX = tipRight ? hx - tipW - 10 : hx + 10;
  const excess = hp && hp.benchmark != null ? hp.fund - hp.benchmark : null;

  return (
    <div
      ref={wrapRef}
      onMouseMove={onMove}
      onMouseLeave={() => setHoverIdx(null)}
      style={{ position: "relative", border: bare ? "none" : "1px solid #E5E5DE", background: bare ? "transparent" : "white" }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Cumulative return since inception">
        {/* Y gridlines + labels */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} y1={y(t)} x2={W - pad.right} y2={y(t)} stroke={t === 0 ? "#D9D9D2" : GRID} strokeWidth="1" />
            <text x={pad.left - 6} y={y(t) + 3} fontSize="11" fill={AXIS_TEXT} fontFamily="system-ui" textAnchor="end">
              {fmtPct(t)}
            </text>
          </g>
        ))}

        {/* X date labels */}
        {xTickIdx.map((i) => (
          <text key={i} x={x(i)} y={H - pad.bottom + 18} fontSize="11" fill={AXIS_TEXT} fontFamily="system-ui" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
            {fmtDate(points[i].date)}
          </text>
        ))}

        {/* Benchmark + fund lines */}
        {hasBench ? <polyline fill="none" stroke={BENCH_COLOR} strokeWidth="1.5" points={linePoints("benchmark")} /> : null}
        <polyline fill="none" stroke={FUND_COLOR} strokeWidth="2" points={linePoints("fund")} />

        {/* Hover crosshair + markers + tooltip */}
        {hp && (
          <g>
            <line x1={hx} y1={pad.top} x2={hx} y2={H - pad.bottom} stroke="#C9C9C0" strokeWidth="1" strokeDasharray="3 3" />
            {hp.benchmark != null && <circle cx={hx} cy={y(hp.benchmark)} r="3.5" fill={BENCH_COLOR} />}
            <circle cx={hx} cy={y(hp.fund)} r="3.5" fill={FUND_COLOR} />

            <g transform={`translate(${tipX}, ${pad.top})`}>
              <rect width={tipW} height={excess != null ? 76 : 44} rx="4" fill="white" stroke="#E5E5DE" strokeWidth="1" />
              <text x="10" y="16" fontSize="10" fill="#6B6B66" fontFamily="system-ui">{fmtDateLong(hp.date)}</text>
              <text x="10" y="33" fontSize="11" fill={FUND_COLOR} fontFamily="system-ui" fontWeight="600">Fund {fmtPct(hp.fund)}</text>
              {hp.benchmark != null && (
                <text x="10" y="50" fontSize="11" fill={BENCH_COLOR} fontFamily="system-ui">{benchmarkName ?? "Benchmark"} {fmtPct(hp.benchmark)}</text>
              )}
              {excess != null && (
                <text x="10" y="67" fontSize="11" fill={excess >= 0 ? "#1F5C3A" : "#7A1F1F"} fontFamily="system-ui">Excess {fmtPct(excess)}</text>
              )}
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}
