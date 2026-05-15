"use client";

import { useEffect, useState } from "react";
import { useIntradayPrices } from "@/hooks/useIntradayPrices";
import { computeDailyChange } from "@/lib/derived";
import { numeric } from "@/lib/typography";

interface LivePriceHeadlineProps {
  securityId: string;
  /** Server-rendered snapshot used as the initial value and as a fallback if live data fails. */
  snapshotClosePrice: string;
  /** Server-rendered previous close (e.g. yesterday's close from prices table). */
  snapshotPreviousClose: string | null;
  snapshotDate: string;
  currency: "GBP" | "USD" | "EUR";
}

export default function LivePriceHeadline({
  securityId,
  snapshotClosePrice,
  snapshotPreviousClose,
  snapshotDate,
  currency,
}: LivePriceHeadlineProps) {
  const sym = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";

  const securityIds = [securityId];
  const { quotes, lastUpdated } = useIntradayPrices(securityIds, {
    intervalMs: 30_000,
  });
  const live = quotes.get(securityId) ?? null;

  // Tick once a second for "Xs ago"
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);

  const effectivePrice = live?.price ?? Number(snapshotClosePrice);
  const effectivePrev =
    live?.previousClose ??
    (snapshotPreviousClose ? Number(snapshotPreviousClose) : null);
  const dc = computeDailyChange(effectivePrice, effectivePrev);

  const isLive = !!live?.price;
  const ago = lastUpdated
    ? Math.max(0, Math.floor((Date.now() - lastUpdated.getTime()) / 1000))
    : null;

  return (
    <>
      <div
        style={{
          ...numeric,
          fontSize: 30,
          color: "#00183A",
        }}
      >
        {sym}
        {effectivePrice.toFixed(2)}
      </div>
      {dc ? (
        <div
          style={{
            ...numeric,
            fontSize: 13,
            color:
              dc.direction === "up"
                ? "#1F5C3A"
                : dc.direction === "down"
                  ? "#7A1F1F"
                  : "#6B6B66",
            marginTop: 4,
            fontWeight: 500,
          }}
        >
          {dc.direction === "up" ? "↑" : dc.direction === "down" ? "↓" : "·"}{" "}
          {dc.absoluteNative.isNegative() ? "−" : "+"}
          {sym}
          {dc.absoluteNative.abs().toFixed(2)} ({dc.absoluteNative.isNegative() ? "−" : "+"}
          {dc.percentage.times(100).abs().toFixed(2)}%)
        </div>
      ) : null}
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          color: "#6B6B66",
          marginTop: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
          justifyContent: "flex-end",
        }}
      >
        {isLive ? (
          <>
            <span
              style={{
                display: "inline-block",
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: "#1F5C3A",
              }}
            />
            Live · updated {ago ?? "—"}s ago
          </>
        ) : (
          <>Close · {snapshotDate}</>
        )}
      </div>
    </>
  );
}
