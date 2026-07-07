"use client";

import { useState, useEffect } from "react";

/**
 * Presentational metric row. Receives an already-computed live NAV + lastUpdated
 * from LiveFundHeader (a single shared poll), so the headline here and the NAV
 * chart's "since inception" headline always show the identical value — no penny
 * gap from two independent polls.
 */

interface Props {
  currencySymbol: string;
  liveNav: number;
  lastUpdated: Date | null;
  startingNav: number;
  cashBase: number;
  holdingsCount: number;
  holdingsSub: string;
  constraintsCount: number;
  constraintsSub: string;
  snapshotDate: string | null;
}

const numeric: React.CSSProperties = {
  fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
  fontVariantNumeric: "tabular-nums lining-nums",
  fontFeatureSettings: "'tnum' 1, 'lnum' 1, 'cv11' 1",
};

function fmt(n: number) {
  return new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function ageLabel(lastUpdated: Date | null): string {
  if (!lastUpdated) return "";
  const s = Math.max(0, Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function Card({ label, value, sub, valueColor = "#00183A" }: { label: string; value: string; sub: string; valueColor?: string }) {
  return (
    <div style={{ background: "white", padding: "14px 18px" }}>
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B6B66", fontWeight: 500 }}>
        {label}
      </div>
      <div style={{ ...numeric, fontSize: 22, color: valueColor, marginTop: 4 }}>{value}</div>
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#6B6B66", marginTop: 2 }}>{sub}</div>
    </div>
  );
}

export default function LiveNavCards({
  currencySymbol,
  liveNav,
  lastUpdated,
  startingNav,
  cashBase,
  holdingsCount,
  holdingsSub,
  constraintsCount,
  constraintsSub,
  snapshotDate,
}: Props) {
  // Tick each second so the "updated Ns ago" label counts up between polls.
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);

  const sinceInceptionPct = startingNav > 0 ? ((liveNav - startingNav) / startingNav) * 100 : 0;
  const cashPct = liveNav > 0 ? (cashBase / liveNav) * 100 : 0;
  const isLive = lastUpdated != null;

  return (
    <>
      <Card label="Fund value" value={`${currencySymbol}${fmt(liveNav)}`} sub={`Started ${currencySymbol}${fmt(startingNav)}`} />
      <Card
        label="Since inception"
        value={`${sinceInceptionPct >= 0 ? "+" : ""}${sinceInceptionPct.toFixed(2)}%`}
        sub="vs benchmark TBD"
        valueColor={sinceInceptionPct >= 0 ? "#1F5C3A" : "#7A1F1F"}
      />
      <Card label="Holdings" value={String(holdingsCount)} sub={holdingsSub} />
      <Card label="Cash" value={`${currencySymbol}${fmt(cashBase)}`} sub={liveNav > 0 ? `${cashPct.toFixed(1)}% of NAV` : ""} />
      <Card label="Constraints" value={String(constraintsCount)} sub={constraintsSub} />
      <Card
        label="Fund value as of"
        value={isLive ? "Live" : snapshotDate ?? "Today"}
        sub={isLive ? `updated ${ageLabel(lastUpdated)}` : snapshotDate ? "last close" : "computed live"}
        valueColor={isLive ? "#1F5C3A" : "#00183A"}
      />
    </>
  );
}
