"use client";

import { useMemo } from "react";
import Decimal from "decimal.js";
import { useIntradayPrices } from "@/hooks/useIntradayPrices";
import LiveNavCards from "@/components/LiveNavCards";
import NavChart, { type NavPoint } from "@/components/NavChart";

/**
 * Owns the SINGLE intraday poll for the fund header, computes the live NAV once,
 * and feeds the same value to both the metric row (LiveNavCards) and the NAV
 * chart's live endpoint/headline — so the two headline figures are always
 * identical to the penny, rather than drifting apart from two separate polls.
 *
 * Revaluation matches LiveHoldingsTable exactly: start from the server's initial
 * NAV (already live at load) and swap each position's server market value for
 * its live one.
 */

interface Position {
  securityId: string;
  quantity: string;
  latestPriceNative: string | null;
  latestFxToBase: string;
}

interface Props {
  currencySymbol: string;
  baseCurrency: "GBP" | "USD" | "EUR";
  initialNavBase: string;
  startingNav: number;
  cashBase: number;
  holdingsCount: number;
  holdingsSub: string;
  snapshotDate: string | null;
  positions: Position[];
  // NavChart props
  fundName: string;
  inceptionDate: string;
  navPoints: NavPoint[];
}

export default function LiveFundHeader(props: Props) {
  const securityIds = useMemo(() => props.positions.map((p) => p.securityId), [props.positions]);
  const { quotes, lastUpdated } = useIntradayPrices(securityIds, { intervalMs: 30_000 });

  const liveNav = useMemo(() => {
    let total = new Decimal(props.initialNavBase);
    for (const p of props.positions) {
      const live = quotes.get(p.securityId);
      if (live?.price == null) continue;
      if (!p.latestPriceNative) continue;
      const qty = new Decimal(p.quantity);
      const fx = new Decimal(p.latestFxToBase);
      const oldMv = qty.times(p.latestPriceNative).times(fx);
      const newMv = qty.times(live.price).times(fx);
      total = total.plus(newMv).minus(oldMv);
    }
    return total.toNumber();
  }, [props.initialNavBase, props.positions, quotes]);

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 1,
          background: "#D9D9D2",
          border: "1px solid #D9D9D2",
          marginTop: 28,
          marginBottom: 28,
        }}
      >
        <LiveNavCards
          currencySymbol={props.currencySymbol}
          liveNav={liveNav}
          lastUpdated={lastUpdated}
          startingNav={props.startingNav}
          cashBase={props.cashBase}
          holdingsCount={props.holdingsCount}
          holdingsSub={props.holdingsSub}
          snapshotDate={props.snapshotDate}
        />
      </div>

      <div style={{ marginBottom: 28 }}>
        <NavChart
          fundName={props.fundName}
          fundBaseCurrency={props.baseCurrency}
          startingNav={props.startingNav}
          inceptionDate={props.inceptionDate}
          points={props.navPoints}
          liveNav={liveNav}
        />
      </div>
    </>
  );
}
