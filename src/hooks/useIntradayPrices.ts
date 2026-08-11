"use client";

import { useEffect, useState } from "react";

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

const EMPTY: UseIntradayPricesState = {
  quotes: new Map(),
  lastUpdated: null,
  providerLabel: null,
  loading: false,
  error: null,
};

/**
 * One poll per distinct set of securities, shared across every component that
 * asks for it.
 *
 * Each hook instance used to own its own interval and its own fetch. A fund page
 * renders the header, the holdings table and the exposures panel, all wanting
 * live prices for the same holdings, so a single page produced four identical
 * requests every thirty seconds — four times the Yahoo calls, the database reads
 * and the egress it actually needed. Invisible with one user; not with six PMs
 * refreshing through the trading day.
 *
 * Subscribers are grouped by the sorted list of security IDs. The first
 * subscriber for a group starts the interval; the last one to leave stops it.
 * Late arrivals get the current snapshot immediately rather than triggering a
 * fetch of their own, so mounting a fourth component costs nothing.
 */
type Listener = (state: UseIntradayPricesState) => void;

interface Group {
  ids: string[];
  intervalMs: number;
  pauseWhenHidden: boolean;
  listeners: Set<Listener>;
  timer: ReturnType<typeof setInterval> | null;
  /** Guards against overlapping polls when a request outlives the interval. */
  inFlight: boolean;
  state: UseIntradayPricesState;
}

const groups = new Map<string, Group>();

function publish(g: Group) {
  for (const l of g.listeners) l(g.state);
}

async function poll(key: string) {
  const g = groups.get(key);
  if (!g || g.ids.length === 0 || g.inFlight) return;
  if (g.pauseWhenHidden && typeof document !== "undefined" && document.hidden) return;

  g.inFlight = true;
  g.state = { ...g.state, loading: true };
  publish(g);

  try {
    const res = await fetch(
      `/api/prices/intraday?securityIds=${encodeURIComponent(g.ids.join(","))}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (!groups.has(key)) return; // everyone unsubscribed mid-flight

    if (!res.ok || !data.ok) {
      g.state = { ...g.state, loading: false, error: data.error ?? `Request failed (${res.status})` };
    } else {
      const map = new Map<string, LiveQuote>();
      for (const q of data.quotes as LiveQuote[]) map.set(q.securityId, q);
      g.state = {
        quotes: map,
        lastUpdated: new Date(data.fetchedAt),
        providerLabel: data.providerLabel,
        loading: false,
        error: null,
      };
    }
  } catch (err) {
    if (!groups.has(key)) return;
    g.state = {
      ...g.state,
      loading: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  } finally {
    g.inFlight = false;
    const still = groups.get(key);
    if (still) publish(still);
  }
}

function subscribe(
  key: string,
  ids: string[],
  intervalMs: number,
  pauseWhenHidden: boolean,
  listener: Listener
): () => void {
  let g = groups.get(key);
  if (!g) {
    g = {
      ids,
      intervalMs,
      pauseWhenHidden,
      listeners: new Set(),
      timer: null,
      inFlight: false,
      state: EMPTY,
    };
    groups.set(key, g);
  }
  g.listeners.add(listener);

  // Hand the newcomer whatever we already have, so a late mount renders
  // immediately instead of waiting for the next tick.
  listener(g.state);

  if (!g.timer) {
    void poll(key);
    g.timer = setInterval(() => void poll(key), g.intervalMs);
  }

  return () => {
    const cur = groups.get(key);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0) {
      if (cur.timer) clearInterval(cur.timer);
      groups.delete(key);
    }
  };
}

/**
 * Poll /api/prices/intraday for the supplied securityIds. Components asking for
 * the same set share a single request. Pauses when the tab is hidden.
 */
export function useIntradayPrices(
  securityIds: string[],
  options: Options = {}
): UseIntradayPricesState {
  const { intervalMs = 30_000, pauseWhenHidden = true } = options;
  const [state, setState] = useState<UseIntradayPricesState>(EMPTY);

  // Sorted so that two components listing the same securities in a different
  // order still share one poll.
  const idsKey = securityIds.slice().sort().join(",");

  useEffect(() => {
    if (idsKey === "") {
      setState(EMPTY);
      return;
    }
    const ids = idsKey.split(",");
    const groupKey = `${idsKey}|${intervalMs}|${pauseWhenHidden}`;
    return subscribe(groupKey, ids, intervalMs, pauseWhenHidden, setState);
  }, [idsKey, intervalMs, pauseWhenHidden]);

  return state;
}
