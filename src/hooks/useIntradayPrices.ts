"use client";

import { useEffect, useRef, useState } from "react";

export interface LiveQuote {
  securityId: string;
  symbol: string;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  currency: string | null;
  marketState: "REGULAR" | "PRE" | "POST" | "CLOSED" | "UNKNOWN";
  stale: boolean;
  asOf: string | null;
}

export interface UseIntradayPricesState {
  quotes: Map<string, LiveQuote>;
  lastUpdated: Date | null;
  providerLabel: string | null;
  /** True between polls — useful for "Updating…" indicators. */
  loading: boolean;
  /** True if the last poll failed for any reason. */
  error: string | null;
}

interface Options {
  /** Polling interval in milliseconds. Default 30000 (30s). */
  intervalMs?: number;
  /** Pause polling when the tab is hidden (default true). */
  pauseWhenHidden?: boolean;
}

/**
 * Poll /api/prices/intraday every `intervalMs` for the supplied securityIds.
 * Pauses when the tab is hidden to avoid burning API quota on background tabs.
 */
export function useIntradayPrices(
  securityIds: string[],
  options: Options = {}
): UseIntradayPricesState {
  const { intervalMs = 30_000, pauseWhenHidden = true } = options;

  const [quotes, setQuotes] = useState<Map<string, LiveQuote>>(new Map());
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [providerLabel, setProviderLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable key — only re-poll when the actual set of IDs changes
  const idsKey = securityIds.slice().sort().join(",");

  // Use a ref for the current ids so the interval callback always sees latest
  const idsRef = useRef(securityIds);
  idsRef.current = securityIds;

  useEffect(() => {
    if (securityIds.length === 0) {
      setQuotes(new Map());
      setLastUpdated(null);
      return;
    }

    let cancelled = false;

    async function poll() {
      const ids = idsRef.current;
      if (ids.length === 0) return;
      // Skip when tab hidden (saves quota)
      if (pauseWhenHidden && typeof document !== "undefined" && document.hidden) {
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(
          `/api/prices/intraday?securityIds=${encodeURIComponent(ids.join(","))}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setError(data.error ?? `Request failed (${res.status})`);
          return;
        }
        setError(null);
        const map = new Map<string, LiveQuote>();
        for (const q of data.quotes as LiveQuote[]) {
          map.set(q.securityId, q);
        }
        setQuotes(map);
        setLastUpdated(new Date(data.fetchedAt));
        setProviderLabel(data.providerLabel);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    // Kick off an initial poll right away
    poll();
    const handle = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, intervalMs, pauseWhenHidden]);

  return { quotes, lastUpdated, providerLabel, loading, error };
}
