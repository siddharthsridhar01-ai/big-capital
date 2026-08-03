/**
 * Worker: Daily EOD price ingest via Yahoo Finance (free, no bulk paywall).
 *
 * Reuses the existing, proven Yahoo adapter (`yahooProvider.fetchQuotes`) which
 * already maps symbols (AZN + LSE -> "AZN.L") and normalises minor-currency
 * units (LSE quotes in pence -> GBP). We store the returned price as the day's
 * close with source "yahoo".
 *
 * One batched request covers all symbols, so there is no per-symbol call cap to
 * worry about (unlike EODHD's free tier). When the society moves to EODHD paid,
 * the cron can be pointed back at runPriceIngest (bulk) — this worker and that
 * one are interchangeable at the route level.
 *
 * Note: `price` is the latest/close price for the session. Run after market
 * close (the weekday cron does) so it reflects the settled close.
 */
import { db } from "../db/client";
import { prices, securities } from "../db/schema";
import { and, eq, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { yahooProvider, toYahooSymbol } from "../lib/intraday/yahoo";

export type Currency = "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD";
const SUPPORTED = new Set<string>(["GBP", "USD", "EUR"]);

/**
 * The price row's currency: trust the (already normalised) quote currency if
 * it's one we support, else fall back to the security's declared currency.
 * Returns null if neither is supported (caller skips).
 */
export function resolvePriceCurrency(quoteCurrency: string | null | undefined, securityCurrency: string): Currency | null {
  const q = (quoteCurrency ?? "").toUpperCase();
  if (SUPPORTED.has(q)) return q as Currency;
  if (SUPPORTED.has(securityCurrency)) return securityCurrency as Currency;
  return null;
}

export interface YahooPriceResult {
  securitiesRequested: number;
  pricesUpserted: number;
  skipped: { noQuote: number; unsupportedCurrency: number };
  errors: Array<{ symbol: string; message: string }>;
  sample: Array<{ ticker: string; close: string; currency: string }>;
  /**
   * Distinct security rows that resolve to the same Yahoo symbol. Not an error
   * (we now price all of them), but it almost always means the same company was
   * added to `securities` twice, so it is surfaced for cleanup.
   */
  duplicateSymbols: Array<{ symbol: string; tickers: string[]; count: number }>;
}

export async function runYahooEodIngest(dateOverride?: string): Promise<YahooPriceResult> {
  const result: YahooPriceResult = {
    securitiesRequested: 0,
    pricesUpserted: 0,
    skipped: { noQuote: 0, unsupportedCurrency: 0 },
    errors: [],
    sample: [],
    duplicateSymbols: [],
  };

  const targets = await db
    .selectDistinct({
      id: securities.id,
      ticker: securities.ticker,
      exchange: securities.exchange,
      currency: securities.currency,
    })
    .from(securities)
    .where(and(eq(securities.isActive, true), ne(securities.exchange, "INDEX")));

  result.securitiesRequested = targets.length;
  if (targets.length === 0) return result;

  // Two different security rows can resolve to the SAME Yahoo symbol (the same
  // company entered twice, or a ticker/exchange pair that normalises
  // identically). The previous version pushed the symbol once per security but
  // kept only the LAST security in the lookup map, so each duplicate produced an
  // extra upsert row carrying the same securityId. `prices` is keyed on
  // (security_id, date), so Postgres rejected the whole statement with
  // "ON CONFLICT DO UPDATE command cannot affect row a second time" — and the
  // other security silently never received a price at all.
  //
  // Group by symbol instead: request each symbol once, then fan its quote out to
  // every security that maps to it.
  const symbolToSecs = new Map<string, Array<(typeof targets)[number]>>();
  for (const s of targets) {
    const sym = toYahooSymbol(s.ticker, s.exchange);
    const existing = symbolToSecs.get(sym);
    if (existing) existing.push(s);
    else symbolToSecs.set(sym, [s]);
  }
  const symbols = [...symbolToSecs.keys()];

  for (const [sym, secs] of symbolToSecs) {
    if (secs.length > 1) {
      result.duplicateSymbols.push({
        symbol: sym,
        tickers: secs.map((s) => s.ticker),
        count: secs.length,
      });
    }
  }

  let quotes: Array<Awaited<ReturnType<typeof yahooProvider.fetchQuotes>>[number]>;
  try {
    quotes = await yahooProvider.fetchQuotes(symbols);
  } catch (err) {
    result.errors.push({ symbol: "(batch)", message: err instanceof Error ? err.message : String(err) });
    return result;
  }

  const date = dateOverride ?? new Date().toISOString().slice(0, 10);
  const toUpsert: Array<{ securityId: string; date: string; closePrice: string; currency: Currency; source: string }> = [];

  quotes.forEach((q, i) => {
    const sym = symbols[i];
    const secs = symbolToSecs.get(sym);
    if (!secs || secs.length === 0) return;
    if (!q || q.price == null || !Number.isFinite(q.price)) {
      // Count every security that was waiting on this symbol, not just one.
      result.skipped.noQuote += secs.length;
      return;
    }
    for (const sec of secs) {
      const ccy = resolvePriceCurrency(q.currency, sec.currency);
      if (!ccy) {
        result.skipped.unsupportedCurrency += 1;
        continue;
      }
      toUpsert.push({ securityId: sec.id, date, closePrice: q.price.toString(), currency: ccy, source: "yahoo" });
      if (result.sample.length < 8) {
        result.sample.push({ ticker: sec.ticker, close: q.price.toString(), currency: ccy });
      }
    }
  });

  // Belt and braces: a single INSERT must never contain two rows sharing the
  // primary key (security_id, date), whatever produced them. Last one wins.
  const deduped = [
    ...new Map(toUpsert.map((r) => [`${r.securityId}|${r.date}`, r])).values(),
  ];

  if (deduped.length > 0) {
    await db
      .insert(prices)
      .values(deduped)
      .onConflictDoUpdate({
        target: [prices.securityId, prices.date],
        set: {
          closePrice: sql`excluded.close_price`,
          currency: sql`excluded.currency`,
          source: sql`excluded.source`,
        },
      });
    result.pricesUpserted = deduped.length;
  }

  return result;
}
