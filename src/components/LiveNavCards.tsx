"use client";

import { useMemo, useState, useEffect } from "react";
import Decimal from "decimal.js";
import { useIntradayPrices } from "@/hooks/useIntradayPrices";

/**
 * The top metric row for a fund, with the NAV-linked cards (Fund value, Since
 * inception, Cash % of NAV, and the "as of" indicator) revalued live from
 * intraday quotes. Uses the SAME revaluation formula as LiveHoldingsTable —
 * start from the server's initial NAV (already live at page load) and, per
 * position with a fresh quote, swap the server market value for the live one —
 * so the headline and the holdings table always agree.
 *
 * The chart and the "since inception" history remain daily-struck elsewhere;
 * this only makes the current headline value move. When the market is closed or
 * no live quote has arrived, it shows the load-time value (still current as of
 * the last close) and labels itself accordingly.
 */

interface Position {
  securityId: string;
  quantity: string; // signed
  latestPriceNative: string | null;
  latestFxToBase: string;
}

interface Props {
  currencySymbol: string;
  initialNavBase: string;
  startingNav: number;
  cashBase: number;
  holdingsCount: number;
  holdingsSub: string;
  constraintsCount: number;
  constraintsSub: string;
  snapshotDate: string | null;
  positions: Position[];
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
  const m = Math.floor(s / 60);
  return `${m}m ago`;
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
  initialNavBase,
  startingNav,
  cashBase,
  holdingsCount,
  holdingsSub,
  constraintsCount,
  constraintsSub,
  snapshotDate,
  positions,
}: Props) {
  const securityIds = useMemo(() => positions.map((p) => p.securityId), [positions]);
  const { quotes, lastUpdated } = useIntradayPrices(securityIds, { intervalMs: 30_000 });

  // Tick each second so the "updated Ns ago" label counts up between polls.
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);

  // Identical formula to LiveHoldingsTable: swap server MV for live MV per position.
  const liveNav = useMemo(() => {
    let total = new Decimal(initialNavBase);
    for (const p of positions) {
      const live = quotes.get(p.securityId);
      if (live?.price == null) continue;
      if (!p.latestPriceNative) continue;
      const qty = new Decimal(p.quantity);
      const fx = new Decimal(p.latestFxToBase);
      const oldMv = qty.times(p.latestPriceNative).times(fx);
      const newMv = qty.times(live.price).times(fx);
      total = total.plus(newMv).minus(oldMv);
    }
    return total;
  }, [initialNavBase, positions, quotes]);

  const navNum = liveNav.toNumber();
  const sinceInceptionPct = startingNav > 0 ? ((navNum - startingNav) / startingNav) * 100 : 0;
  const cashPct = navNum > 0 ? (cashBase / navNum) * 100 : 0;
  const isLive = lastUpdated != null;

  return (
    <>
      <Card label="Fund value" value={`${currencySymbol}${fmt(navNum)}`} sub={`Started ${currencySymbol}${fmt(startingNav)}`} />
      <Card
        label="Since inception"
        value={`${sinceInceptionPct >= 0 ? "+" : ""}${sinceInceptionPct.toFixed(2)}%`}
        sub="vs benchmark TBD"
        valueColor={sinceInceptionPct >= 0 ? "#1F5C3A" : "#7A1F1F"}
      />
      <Card label="Holdings" value={String(holdingsCount)} sub={holdingsSub} />
      <Card label="Cash" value={`${currencySymbol}${fmt(cashBase)}`} sub={navNum > 0 ? `${cashPct.toFixed(1)}% of NAV` : ""} />
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
