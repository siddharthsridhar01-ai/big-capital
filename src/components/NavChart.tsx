"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { useMemo, useState } from "react";
import { serif, numeric } from "@/lib/typography";

export interface NavPoint {
  date: string; // YYYY-MM-DD
  nav: number;
  /** Benchmark rebased to the same starting capital (£ growth-of-100k). */
  benchmarkNav?: number | null;
  /** Optional label for tooltip (e.g. "Buy 5 SHEL", "Inception"). */
  event?: string;
}

interface NavChartProps {
  fundName: string;
  fundBaseCurrency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD";
  startingNav: number;
  /** YYYY-MM-DD format. */
  inceptionDate: string;
  points: NavPoint[];
  /** Current live NAV (will be added as the latest point). */
  liveNav?: number;
  /** Short benchmark label for the legend/tooltip; null hides the benchmark line. */
  benchmarkName?: string | null;
}

type RangeKey = "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "ALL";

interface RangeOption {
  key: RangeKey;
  label: string;
  /** Number of days back from today. ALL = full inception range. */
  days: number | "ALL" | "YTD";
}

const RANGES: RangeOption[] = [
  { key: "5D", label: "5D", days: 5 },
  { key: "1M", label: "1M", days: 30 },
  { key: "3M", label: "3M", days: 90 },
  { key: "6M", label: "6M", days: 180 },
  { key: "YTD", label: "YTD", days: "YTD" },
  { key: "1Y", label: "1Y", days: 365 },
  { key: "ALL", label: "Since inception", days: "ALL" },
];

function fundAgeDays(inceptionDate: string): number {
  const inception = new Date(inceptionDate);
  return Math.floor((Date.now() - inception.getTime()) / 86400000);
}

const baseSyms: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", HKD: "HK$", CNY: "¥", KRW: "₩", SGD: "S$", INR: "₹", TWD: "NT$" };

function fmtMoney(n: number, currency: string) {
  return `${baseSyms[currency] ?? "$"}${new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)}`;
}

function fmtShortDate(d: string) {
  const date = new Date(d);
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });
}

function fmtMonthYear(d: string) {
  const date = new Date(d);
  const mon = date.toLocaleDateString("en-GB", { month: "short" });
  return `${mon} '${String(date.getFullYear()).slice(2)}`;
}

export default function NavChart({
  fundBaseCurrency,
  startingNav,
  inceptionDate,
  points,
  benchmarkName = null,
}: NavChartProps) {
  const ageDays = fundAgeDays(inceptionDate);

  // Default range: "Since inception" for funds < 1 year old (institutional
  // convention — new funds emphasise full track record).
  const defaultRange: RangeKey = ageDays < 365 ? "ALL" : "1Y";
  const [activeRange, setActiveRange] = useState<RangeKey>(defaultRange);

  // Full NAV series — official struck closes only. The headline figure and the
  // chart line both reflect the last close (the fund's valuation point); live
  // intraday marks are for monitoring elsewhere, not the official NAV.
  const fullData = useMemo(() => [...points], [points]);

  // Filter by selected range
  const data = useMemo(() => {
    const range = RANGES.find((r) => r.key === activeRange);
    if (!range || range.days === "ALL") return fullData;
    let cutoffMs: number;
    if (range.days === "YTD") {
      cutoffMs = new Date(new Date().getFullYear(), 0, 1).getTime();
    } else {
      cutoffMs = Date.now() - range.days * 86400000;
    }
    // Keep points >= cutoff. Always include the live (last) point.
    const filtered = fullData.filter(
      (p) => new Date(p.date).getTime() >= cutoffMs
    );
    // If filter has < 2 points within the cutoff, prepend the most recent
    // earlier point so the chart still shows a meaningful "from X to today"
    // line. This is honest about sparse data: if you click 1D and there's
    // no snapshot from yesterday, you see "from the most recent known NAV
    // (whenever that was) to today" — not "from inception to today" which
    // would be misleading.
    if (filtered.length < 2 && fullData.length > 0) {
      // Find the latest point strictly before the cutoff
      const cutoffMs = (() => {
        if (range.days === "YTD") {
          return new Date(new Date().getFullYear(), 0, 1).getTime();
        }
        return Date.now() - (range.days as number) * 86400000;
      })();
      const beforeCutoff = fullData.filter(
        (p) => new Date(p.date).getTime() < cutoffMs
      );
      const anchorPoint =
        beforeCutoff.length > 0
          ? beforeCutoff[beforeCutoff.length - 1]
          : fullData[0];
      const livePoint = fullData[fullData.length - 1];
      if (anchorPoint && livePoint && anchorPoint !== livePoint) {
        return [anchorPoint, livePoint];
      }
      // Nothing else to show — just return whatever we have
      return filtered.length > 0 ? filtered : [livePoint].filter(Boolean);
    }
    return filtered;
  }, [fullData, activeRange]);

  const sym = baseSyms[fundBaseCurrency] ?? "$";

  // Current NAV is the last point in fullData
  const currentNav = fullData[fullData.length - 1]?.nav ?? startingNav;

  // Domain padding so the line doesn't kiss the edges (calculated on the
  // filtered data, not the full data — chart auto-zooms to the selected range)
  const hasBench = benchmarkName != null && data.some((d) => d.benchmarkNav != null);
  const navVals = data.map((d) => d.nav);
  const benchVals = hasBench ? data.filter((d) => d.benchmarkNav != null).map((d) => d.benchmarkNav as number) : [];
  const min = Math.min(...navVals, ...benchVals);
  const max = Math.max(...navVals, ...benchVals);
  const pad = Math.max((max - min) * 0.15, startingNav * 0.001);
  const yDomain: [number, number] = [min - pad, max + pad];

  // Show the year on the axis only when the visible window crosses a calendar year.
  const spansYears =
    data.length > 1 &&
    new Date(data[0].date).getFullYear() !== new Date(data[data.length - 1].date).getFullYear();

  // Range-specific return: NAV at the START of the visible window vs current
  const rangeStartNav = data[0]?.nav ?? startingNav;
  const rangeReturnPct =
    rangeStartNav === 0
      ? 0
      : ((currentNav - rangeStartNav) / rangeStartNav) * 100;
  const rangeIsUp = rangeReturnPct >= 0;

  // Label describing the period for the return header
  const activeRangeOption = RANGES.find((r) => r.key === activeRange);
  const periodLabel =
    activeRange === "ALL"
      ? "since inception"
      : activeRange === "YTD"
        ? "year to date"
        : `over ${activeRangeOption?.label}`;
  // The headline number is the fund's last official close — a fixed label, not
  // tied to the chart range toggle (the toggle only reframes the period return
  // and the chart window below).
  const periodHeaderLabel = "NAV · last close";

  const renderTooltip = (o: { active?: boolean; payload?: Array<{ dataKey?: string; value?: number }>; label?: string }) => {
    if (!o.active || !o.payload || o.payload.length === 0) return null;
    const navV = o.payload.find((p) => p.dataKey === "nav")?.value;
    const benchV = o.payload.find((p) => p.dataKey === "benchmarkNav")?.value;
    const dateLabel = o.label
      ? new Date(o.label).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : "";
    const gapPct = navV != null && benchV != null && benchV !== 0 ? ((navV - benchV) / benchV) * 100 : null;
    return (
      <div style={{ background: "white", border: "1px solid #D9D9D2", padding: "8px 10px", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6B6B66", marginBottom: 4 }}>{dateLabel}</div>
        {navV != null && (
          <div style={{ fontSize: 12, color: rangeIsUp ? "#1F5C3A" : "#7A1F1F", fontWeight: 600 }}>Fund {fmtMoney(navV, fundBaseCurrency)}</div>
        )}
        {benchV != null && (
          <div style={{ fontSize: 12, color: "#8A6D1F" }}>{benchmarkName ?? "Benchmark"} {fmtMoney(benchV, fundBaseCurrency)}</div>
        )}
        {gapPct != null && (
          <div style={{ fontSize: 11, color: gapPct >= 0 ? "#1F5C3A" : "#7A1F1F", marginTop: 2 }}>
            {gapPct >= 0 ? "+" : ""}{gapPct.toFixed(2)}% vs benchmark
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        background: "white",
        border: "1px solid #D9D9D2",
        padding: "20px 24px 12px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 18,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#6B6B66",
              fontWeight: 500,
              marginBottom: 4,
            }}
          >
            {periodHeaderLabel}
          </div>
          <div style={{ ...serif, fontSize: 22, color: "#00183A" }}>
            {fmtMoney(currentNav, fundBaseCurrency)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              ...numeric,
              fontSize: 18,
              color: rangeIsUp ? "#1F5C3A" : "#7A1F1F",
              fontWeight: 500,
            }}
          >
            {rangeIsUp ? "+" : "−"}
            {Math.abs(rangeReturnPct).toFixed(2)}%
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#6B6B66",
              marginTop: 2,
            }}
          >
            {periodLabel} ·{" "}
            {activeRange === "ALL"
              ? `vs ${fmtMoney(startingNav, fundBaseCurrency)}`
              : `vs ${fmtMoney(rangeStartNav, fundBaseCurrency)}`}
          </div>
        </div>
      </div>

      {/* Time-range toggle bar */}
      <div
        style={{
          display: "flex",
          gap: 2,
          marginBottom: 14,
          fontSize: 11,
        }}
      >
        {RANGES.map((r) => {
          const isActive = r.key === activeRange;
          // Disable logic per range:
          //  - Numeric days: disable if longer than fund's age
          //  - YTD: disable if inception was after Jan 1 of the current year
          //  - ALL: never disabled
          let isDisabled = false;
          if (r.days === "YTD") {
            const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
            const inceptionMs = new Date(inceptionDate).getTime();
            isDisabled = inceptionMs > jan1;
          } else if (typeof r.days === "number") {
            isDisabled = r.days > ageDays;
          }
          return (
            <button
              key={r.key}
              onClick={() => !isDisabled && setActiveRange(r.key)}
              disabled={isDisabled}
              style={{
                padding: "4px 10px",
                background: isActive ? "#00183A" : "transparent",
                color: isActive
                  ? "white"
                  : isDisabled
                    ? "#C8C8C0"
                    : "#6B6B66",
                border: "1px solid",
                borderColor: isActive ? "#00183A" : "transparent",
                borderRadius: 3,
                fontFamily: "system-ui, sans-serif",
                fontSize: 11,
                fontWeight: isActive ? 500 : 400,
                cursor: isDisabled ? "not-allowed" : "pointer",
                letterSpacing: "0.02em",
                transition: "all 0.15s ease",
              }}
              title={
                isDisabled
                  ? `Fund is ${ageDays} days old — not enough history for this range`
                  : undefined
              }
            >
              {r.label}
            </button>
          );
        })}
      </div>

      {hasBench && (
        <div style={{ display: "flex", gap: 16, marginBottom: 8, fontSize: 11, color: "#6B6B66", fontFamily: "system-ui, sans-serif" }}>
          <span><span style={{ color: rangeIsUp ? "#1F5C3A" : "#7A1F1F" }}>■</span> Fund</span>
          <span><span style={{ color: "#8A6D1F" }}>■</span> {benchmarkName} <span style={{ color: "#9A9A8E" }}>· rebased to {fmtMoney(startingNav, fundBaseCurrency)}</span></span>
        </div>
      )}

      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 6, right: 8, bottom: 0, left: 8 }}
          >
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#9A9A8E" }}
              tickFormatter={spansYears ? fmtMonthYear : fmtShortDate}
              axisLine={{ stroke: "#E5E5DE" }}
              tickLine={false}
              minTickGap={32}
            />
            <YAxis
              domain={yDomain}
              tick={{ fontSize: 10, fill: "#9A9A8E" }}
              tickFormatter={(v) =>
                `${sym}${(v / 1000).toFixed(1)}k`
              }
              axisLine={false}
              tickLine={false}
              width={48}
            />
            <Tooltip content={renderTooltip as never} />
            <ReferenceLine
              y={startingNav}
              stroke="#9A9A8E"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            {hasBench && (
              <Line
                type="monotone"
                dataKey="benchmarkNav"
                stroke="#8A6D1F"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
                connectNulls
              />
            )}
            <Line
              type="monotone"
              dataKey="nav"
              stroke={rangeIsUp ? "#1F5C3A" : "#7A1F1F"}
              strokeWidth={2}
              dot={{ r: 3, fill: rangeIsUp ? "#1F5C3A" : "#7A1F1F", strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
