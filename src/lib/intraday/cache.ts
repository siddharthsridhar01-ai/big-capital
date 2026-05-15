/**
 * In-memory intraday quote cache.
 *
 * Lives in the Node.js process. Caches quotes keyed by securityId for fresh
 * lookups; refreshes from the provider when entries are stale. Single-flight
 * pattern prevents thundering-herd refetches when many requests arrive in the
 * same instant.
 *
 * Stays in-process for v1 (single dev server, single Vercel function instance).
 * If we ever scale to multiple instances, swap this for Upstash Redis with
 * the same interface.
 */

import type { IntradayQuote, IntradayProvider } from "./types";

interface CachedQuote {
  securityId: string;
  symbol: string;
  quote: IntradayQuote | null;
  fetchedAt: Date;
}

/** How long a quote is considered fresh before we refetch. */
const TTL_MS = 30_000;

/** How long we'll keep serving a stale quote if the provider is down. */
const STALE_TOLERATED_MS = 5 * 60_000;

/** Cache, keyed by securityId. */
const cache = new Map<string, CachedQuote>();

/** In-flight fetches, keyed by symbol — prevents duplicate concurrent calls. */
const inflight = new Map<string, Promise<IntradayQuote | null>>();

export interface SecurityToQuote {
  securityId: string;
  symbol: string; // provider-specific symbol (e.g. Yahoo's "AZN.L")
}

export interface CacheResult {
  securityId: string;
  symbol: string;
  quote: IntradayQuote | null;
  /** Whether the returned quote was served from cache vs freshly fetched. */
  fromCache: boolean;
  /** Whether the cached value is past TTL but within stale tolerance. */
  stale: boolean;
}

/**
 * Get quotes for a list of securities. Fresh entries return immediately
 * from cache; stale entries trigger a single batched provider fetch.
 */
export async function getQuotes(
  provider: IntradayProvider,
  list: SecurityToQuote[]
): Promise<CacheResult[]> {
  if (list.length === 0) return [];

  const now = Date.now();
  const fresh: CacheResult[] = [];
  const toFetch: SecurityToQuote[] = [];
  const staleButHave = new Map<string, CachedQuote>();

  for (const item of list) {
    const cached = cache.get(item.securityId);
    if (cached) {
      const age = now - cached.fetchedAt.getTime();
      if (age < TTL_MS) {
        fresh.push({
          securityId: item.securityId,
          symbol: item.symbol,
          quote: cached.quote,
          fromCache: true,
          stale: false,
        });
        continue;
      } else if (age < STALE_TOLERATED_MS) {
        // Have stale-but-still-tolerable cached entry; will use as fallback
        staleButHave.set(item.securityId, cached);
      }
    }
    toFetch.push(item);
  }

  // Nothing to fetch — all returned from cache
  if (toFetch.length === 0) return fresh;

  // Single-flight: if a fetch for any of these symbols is in progress, wait
  // for it. Otherwise, fire one batched fetch for all required symbols.
  const symbolsToFetch = toFetch.map((s) => s.symbol);
  const symbolsNeedingNewFetch = symbolsToFetch.filter(
    (s) => !inflight.has(s)
  );

  if (symbolsNeedingNewFetch.length > 0) {
    // Fire batch
    const batchPromise = provider.fetchQuotes(symbolsNeedingNewFetch);
    // Pre-register each symbol's individual resolution
    const symbolPromises = new Map<string, Promise<IntradayQuote | null>>();
    for (const sym of symbolsNeedingNewFetch) {
      symbolPromises.set(
        sym,
        batchPromise.then((results) => {
          const idx = symbolsNeedingNewFetch.indexOf(sym);
          return results[idx] ?? null;
        })
      );
      inflight.set(sym, symbolPromises.get(sym)!);
    }
    // Clean up inflight entries when batch completes
    batchPromise.finally(() => {
      for (const sym of symbolsNeedingNewFetch) inflight.delete(sym);
    });
  }

  // Resolve every to-fetch entry
  const fetched: CacheResult[] = await Promise.all(
    toFetch.map(async (item) => {
      try {
        const q = await inflight.get(item.symbol);
        // Write to cache (even if null, to avoid hammering the provider)
        cache.set(item.securityId, {
          securityId: item.securityId,
          symbol: item.symbol,
          quote: q ?? null,
          fetchedAt: new Date(),
        });
        return {
          securityId: item.securityId,
          symbol: item.symbol,
          quote: q ?? null,
          fromCache: false,
          stale: false,
        };
      } catch (err) {
        console.error(`[intraday cache] fetch failed for ${item.symbol}:`, err);
        // Fall back to stale cached entry if we have one
        const stale = staleButHave.get(item.securityId);
        if (stale) {
          return {
            securityId: item.securityId,
            symbol: item.symbol,
            quote: stale.quote,
            fromCache: true,
            stale: true,
          };
        }
        return {
          securityId: item.securityId,
          symbol: item.symbol,
          quote: null,
          fromCache: false,
          stale: false,
        };
      }
    })
  );

  return [...fresh, ...fetched];
}

/** For testing — wipe the cache. */
export function _clearCache() {
  cache.clear();
  inflight.clear();
}
