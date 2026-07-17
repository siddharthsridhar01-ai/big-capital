"use client";

import { useState } from "react";
import NavChart, { type NavPoint } from "./NavChart";
import PerformanceChart, { type PerfPoint } from "./PerformanceChart";

interface Props {
  fundName: string;
  fundBaseCurrency: "GBP" | "USD" | "EUR";
  startingNav: number;
  inceptionDate: string;
  points: NavPoint[];
  liveNav?: number;
  benchmarkPoints: PerfPoint[];
  benchmarkName: string | null;
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        padding: "5px 12px",
        borderRadius: 4,
        cursor: "pointer",
        border: active ? "1px solid #00183A" : "1px solid #D9D9D2",
        background: active ? "#00183A" : "white",
        color: active ? "white" : "#6B6B66",
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

export default function FundChartTabs(props: Props) {
  const [mode, setMode] = useState<"nav" | "benchmark">("nav");

  const navChart = (
    <NavChart
      fundName={props.fundName}
      fundBaseCurrency={props.fundBaseCurrency}
      startingNav={props.startingNav}
      inceptionDate={props.inceptionDate}
      points={props.points}
      liveNav={props.liveNav}
    />
  );

  const hasBench = props.benchmarkPoints.filter((p) => p.benchmark != null).length >= 2;
  // No benchmark history yet → just the NAV chart, no toggle.
  if (!hasBench) return navChart;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 8 }}>
        <ToggleBtn active={mode === "nav"} onClick={() => setMode("nav")}>
          £ NAV
        </ToggleBtn>
        <ToggleBtn active={mode === "benchmark"} onClick={() => setMode("benchmark")}>
          % vs benchmark
        </ToggleBtn>
      </div>

      {mode === "nav" ? (
        navChart
      ) : (
        <div style={{ background: "white", border: "1px solid #D9D9D2", padding: "20px 24px 12px", fontFamily: "system-ui, sans-serif" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
            <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B6B66", fontWeight: 500 }}>
              Cumulative return since inception
            </div>
            <div style={{ fontSize: 11, color: "#9A9A8E" }}>
              <span style={{ color: "#00183A" }}>■</span> Fund &nbsp;
              <span style={{ color: "#8A6D1F" }}>■</span> {props.benchmarkName ?? "Benchmark"}
            </div>
          </div>
          <PerformanceChart points={props.benchmarkPoints} benchmarkName={props.benchmarkName} bare />
        </div>
      )}
    </div>
  );
}
