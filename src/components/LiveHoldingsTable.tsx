"use client";

import { useMemo } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import { useIntradayPrices } from "@/hooks/useIntradayPrices";
import { computeDailyChange, computeUnrealisedPnL } from "@/lib/derived";

interface HoldingsTableProps {
  fundSlug: string;
  fundBaseCurrency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
  /** NAV from the server-side initial render — used until live data arrives. */
  initialNavBase: string;
  positions: Array<{
    securityId: string;
    ticker: string;
    name: string;
    exchange: string;
    currency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
    gicsSector: string | null;
    /** Signed: positive long, negative short. */
    quantity: string;
    avgCostNative: string;
    latestPriceNative: string | null;
    latestFxToBase: string;
    /** Server-computed previous close (from prices table — for Δ Today). */
    previousCloseNative: string | null;
    marketValueBase: string | null;
  }>;
}

const numericStyle: React.CSSProperties = {
  fontFamily:
    "'Inter', system-ui, -apple-system, sans-serif",
  fontVariantNumeric: "tabular-nums lining-nums",
  fontFeatureSettings: "'tnum' 1, 'lnum' 1, 'cv11' 1",
};

const SERIF: React.CSSProperties = {
  fontFamily: "'Source Serif 4', Georgia, serif",
};

function symbolOf(ccy: string) {
  const m: Record<string, string> = { GBP: "£", EUR: "€", USD: "$", JPY: "¥", HKD: "HK$", CNY: "¥", KRW: "₩", SGD: "S$", INR: "₹" };
  return m[ccy] ?? "$";
}

function fmtMoney(n: number, decimals = 2) {
  return new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

export default function LiveHoldingsTable({
  fundSlug,
  fundBaseCurrency,
  initialNavBase,
  positions,
}: HoldingsTableProps) {
  const securityIds = useMemo(
    () => positions.map((p) => p.securityId),
    [positions]
  );

  const { quotes, lastUpdated, providerLabel, loading, error } =
    useIntradayPrices(securityIds, { intervalMs: 30_000 });

  const baseSym = symbolOf(fundBaseCurrency);

  // Sort positions by market value descending — use live price when available
  const sortedPositions = useMemo(() => {
    const enriched = positions.map((p) => {
      const live = quotes.get(p.securityId);
      const livePrice = live?.price != null ? new Decimal(live.price) : null;
      const effectivePrice =
        livePrice ?? (p.latestPriceNative ? new Decimal(p.latestPriceNative) : null);
      const qty = new Decimal(p.quantity);
      const fx = new Decimal(p.latestFxToBase);
      const mktBase = effectivePrice
        ? qty.abs().times(effectivePrice).times(fx)
        : null;
      return { ...p, mktBase };
    });
    return enriched.sort((a, b) => {
      const av = a.mktBase?.toNumber() ?? 0;
      const bv = b.mktBase?.toNumber() ?? 0;
      return bv - av;
    });
  }, [positions, quotes]);

  // Live total NAV based on current quotes (cash unchanged; positions revalued)
  const liveNav = useMemo(() => {
    let total = new Decimal(initialNavBase);
    // Subtract the server-computed market value (already in NAV), add the live one
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

  // Update tab title with live NAV — this is the "alive" feel
  if (typeof document !== "undefined" && lastUpdated) {
    document.title = `${baseSym}${fmtMoney(liveNav.toNumber())} · BIG Capital`;
  }

  // Portfolio-level P&L: sum unrealised P/L and today's £ move across positions.
  const pnlSummary = useMemo(() => {
    let unrealised = new Decimal(0);
    let costBasis = new Decimal(0);
    let dayPnl = new Decimal(0);
    for (const p of positions) {
      const live = quotes.get(p.securityId);
      const price = live?.price != null ? new Decimal(live.price) : p.latestPriceNative ? new Decimal(p.latestPriceNative) : null;
      if (!price) continue;
      const qty = new Decimal(p.quantity); // signed
      const fx = new Decimal(p.latestFxToBase);
      const avg = new Decimal(p.avgCostNative);
      // Unrealised: (price - avg) * qty * fx  (signed qty makes shorts work)
      unrealised = unrealised.plus(price.minus(avg).times(qty).times(fx));
      costBasis = costBasis.plus(avg.times(qty.abs()).times(fx));
      // Day: (price - prevClose) * qty * fx
      const prev = live?.previousClose ?? (p.previousCloseNative ? Number(p.previousCloseNative) : null);
      if (prev != null && prev > 0) {
        dayPnl = dayPnl.plus(price.minus(prev).times(qty).times(fx));
      }
    }
    const returnPct = costBasis.isZero() ? new Decimal(0) : unrealised.dividedBy(costBasis).times(100);
    return { unrealised, returnPct, dayPnl };
  }, [positions, quotes]);

  return (
    <div
      style={{
        background: "white",
        border: "1px solid #D9D9D2",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      <div
        style={{
          padding: "12px 20px",
          borderBottom: "1px solid #E5E5DE",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <div style={{ ...SERIF, fontSize: 16, color: "#00183A" }}>
          Holdings
        </div>
        <LiveStatusChip
          lastUpdated={lastUpdated}
          loading={loading}
          providerLabel={providerLabel}
          error={error}
        />
      </div>

      {/* Portfolio P&L summary */}
      {(() => {
        const u = pnlSummary.unrealised;
        const d = pnlSummary.dayPnl;
        const pill = (label: string, amount: Decimal, pct?: Decimal) => {
          const up = amount.gt(0);
          const down = amount.lt(0);
          const color = up ? "#1F5C3A" : down ? "#7A1F1F" : "#6B6B66";
          const sign = up ? "+" : down ? "−" : "";
          return (
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "#6B6B66" }}>{label}</span>
              <span style={{ ...numericStyle, fontSize: 14, color, fontWeight: 600 }}>
                {sign}{baseSym}{fmtMoney(amount.abs().toNumber())}
                {pct !== undefined && (
                  <span style={{ fontSize: 11, fontWeight: 500, marginLeft: 5 }}>
                    ({sign}{pct.abs().toFixed(2)}%)
                  </span>
                )}
              </span>
            </div>
          );
        };
        return (
          <div
            style={{
              display: "flex",
              gap: 32,
              padding: "10px 20px",
              borderBottom: "1px solid #F0EFEA",
              background: "#FCFCFA",
              flexWrap: "wrap",
            }}
          >
            {pill("Unrealised P/L", u, pnlSummary.returnPct)}
            {pill("Day P/L", d)}
          </div>
        );
      })()}

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {[
              "Ticker",
              "Side",
              "Qty",
              "Avg cost",
              "Price",
              "Δ Today",
              "Mkt value",
              "Unrealised P/L",
              "Weight",
              "",
            ].map((h) => (
              <th
                key={h}
                style={{
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#6B6B66",
                  borderBottom: "1px solid #E5E5DE",
                  padding: "10px 14px",
                  fontWeight: 500,
                  textAlign: h === "Ticker" || h === "Side" ? "left" : "right",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedPositions.map((p) => {
            const sym = symbolOf(p.currency);
            const live = quotes.get(p.securityId);
            const effectivePrice =
              live?.price ??
              (p.latestPriceNative ? Number(p.latestPriceNative) : null);
            // Prefer live previous close (Yahoo's previousClose field) over
            // our seeded yesterday-price for accuracy
            const effectivePrev =
              live?.previousClose ??
              (p.previousCloseNative ? Number(p.previousCloseNative) : null);

            const dc =
              effectivePrice != null
                ? computeDailyChange(effectivePrice, effectivePrev)
                : null;
            const pnl = computeUnrealisedPnL(
              p.quantity,
              p.avgCostNative,
              effectivePrice,
              p.latestFxToBase
            );

            const qty = new Decimal(p.quantity);
            const fx = new Decimal(p.latestFxToBase);
            const mktBase =
              effectivePrice != null
                ? qty.abs().times(effectivePrice).times(fx).toNumber()
                : null;
            const weight =
              mktBase != null && !liveNav.isZero()
                ? (mktBase / liveNav.toNumber()) * 100
                : 0;

            return (
              <tr key={p.securityId}>
                <td
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #F0EFEA",
                  }}
                >
                  <Link
                    href={`/dashboard/funds/${fundSlug}/securities/${p.ticker}-${p.exchange.replace(/ /g, "_")}`}
                    style={{
                      color: "#00183A",
                      textDecoration: "none",
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {p.ticker}
                  </Link>
                  <div
                    style={{
                      fontSize: 10,
                      color: "#6B6B66",
                      marginTop: 1,
                    }}
                  >
                    {p.name}
                  </div>
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #F0EFEA",
                    fontSize: 11,
                    color: qty.lt(0) ? "#7A1F1F" : "#1F5C3A",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    fontWeight: 600,
                  }}
                >
                  {qty.lt(0) ? "Short" : "Long"}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #F0EFEA",
                    textAlign: "right",
                    ...numericStyle,
                    color: qty.lt(0) ? "#7A1F1F" : "#00183A",
                  }}
                >
                  {qty.toFixed(0)}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #F0EFEA",
                    textAlign: "right",
                    ...numericStyle,
                    color: "#6B6B66",
                  }}
                >
                  {sym}
                  {new Decimal(p.avgCostNative).toFixed(2)}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #F0EFEA",
                    textAlign: "right",
                    ...numericStyle,
                    color: "#0A0A0A",
                  }}
                >
                  {effectivePrice != null ? `${sym}${effectivePrice.toFixed(2)}` : "—"}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #F0EFEA",
                    textAlign: "right",
                    ...numericStyle,
                    fontSize: 11,
                  }}
                >
                  {dc ? (
                    <span
                      style={{
                        color:
                          dc.direction === "up"
                            ? "#1F5C3A"
                            : dc.direction === "down"
                              ? "#7A1F1F"
                              : "#6B6B66",
                      }}
                    >
                      {dc.direction === "up"
                        ? "▲"
                        : dc.direction === "down"
                          ? "▼"
                          : "·"}{" "}
                      {dc.percentage.times(100).abs().toFixed(2)}%
                    </span>
                  ) : (
                    <span style={{ color: "#9A9A8E" }}>—</span>
                  )}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #F0EFEA",
                    textAlign: "right",
                    ...numericStyle,
                    color: "#0A0A0A",
                  }}
                >
                  {mktBase != null ? `${baseSym}${fmtMoney(mktBase)}` : "—"}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #F0EFEA",
                    textAlign: "right",
                    ...numericStyle,
                  }}
                >
                  {pnl ? (
                    (() => {
                      const isUp = pnl.amountBase.isPositive() && !pnl.amountBase.isZero();
                      const isDown = pnl.amountBase.isNegative();
                      const color = isUp ? "#1F5C3A" : isDown ? "#7A1F1F" : "#6B6B66";
                      const sign = isUp ? "+" : isDown ? "−" : "";
                      return (
                        <div style={{ color, fontWeight: 500 }}>
                          <div>
                            {sign}
                            {baseSym}
                            {fmtMoney(pnl.amountBase.abs().toNumber())}
                          </div>
                          <div style={{ fontSize: 10, opacity: 0.9 }}>
                            {sign}
                            {pnl.returnPct.times(100).abs().toFixed(2)}%
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <span style={{ color: "#9A9A8E" }}>—</span>
                  )}
                </td>
                <td
                  style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid #F0EFEA",
                    textAlign: "right",
                    ...numericStyle,
                    color: "#0A0A0A",
                  }}
                >
                  {weight.toFixed(2)}%
                </td>
                {(() => {
                  const qtyNum = new Decimal(p.quantity);
                  const isLong = qtyNum.gt(0);
                  const absQty = qtyNum.abs().toString();
                  const base = `/dashboard/funds/${fundSlug}/securities/${p.ticker}-${p.exchange.replace(/ /g, "_")}`;
                  const addSide = isLong ? "buy" : "short";
                  const reduceSide = isLong ? "sell" : "cover";
                  const linkStyle: React.CSSProperties = {
                    fontFamily: "system-ui, sans-serif",
                    fontSize: 11,
                    textDecoration: "none",
                    padding: "2px 6px",
                  };
                  return (
                    <td
                      style={{
                        padding: "10px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <Link href={`${base}?side=${addSide}`} style={{ ...linkStyle, color: "#1F5C3A" }} title="Add to position">
                        Add
                      </Link>
                      <span style={{ color: "#D9D9D2" }}>·</span>
                      <Link href={`${base}?side=${reduceSide}`} style={{ ...linkStyle, color: "#6B6B66" }} title="Trim position">
                        Trim
                      </Link>
                      <span style={{ color: "#D9D9D2" }}>·</span>
                      <Link
                        href={`${base}?side=${reduceSide}&qty=${absQty}`}
                        style={{ ...linkStyle, color: "#7A1F1F", fontWeight: 600 }}
                        title="Close entire position (pre-fills a full exit to review)"
                      >
                        Close
                      </Link>
                    </td>
                  );
                })()}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LiveStatusChip({
  lastUpdated,
  loading,
  providerLabel,
  error,
}: {
  lastUpdated: Date | null;
  loading: boolean;
  providerLabel: string | null;
  error: string | null;
}) {
  const ageStr = useAgo(lastUpdated);

  if (error) {
    return (
      <div
        style={{
          fontSize: 11,
          color: "#7A1F1F",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        title={error}
      >
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#7A1F1F",
          }}
        />
        Data unavailable
      </div>
    );
  }

  if (!lastUpdated && loading) {
    return (
      <div
        style={{
          fontSize: 11,
          color: "#6B6B66",
        }}
      >
        Loading live prices…
      </div>
    );
  }

  return (
    <div
      style={{
        fontSize: 11,
        color: "#6B6B66",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
      title={providerLabel ?? ""}
    >
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: loading ? "#9A9A8E" : "#1F5C3A",
          transition: "background 200ms",
        }}
      />
      Live · updated {ageStr} ago
    </div>
  );
}

function useAgo(date: Date | null): string {
  // Re-render every 5s for accurate "Updated Xs ago" while no new data arrives
  // (achieved by reading from a hook below)
  const [, setTick] = useTick(5000);
  void setTick;
  if (!date) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
}

// Tiny hook to force re-render on a timer
function useTick(ms: number): [number, (n: number) => void] {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [t, setT] = useStateImpl(0);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffectImpl(() => {
    const h = setInterval(() => setT((n) => n + 1), ms);
    return () => clearInterval(h);
  }, [ms]);
  return [t, setT];
}

// Import shims so we don't expand React imports up top
import { useState as useStateImpl, useEffect as useEffectImpl } from "react";
