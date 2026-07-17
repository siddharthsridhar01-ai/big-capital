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

export type Currency = "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
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
}

export async function runYahooEodIngest(dateOverride?: string): Promise<YahooPriceResult> {
  const result: YahooPriceResult = {
    securitiesRequested: 0,
    pricesUpserted: 0,
    skipped: { noQuote: 0, unsupportedCurrency: 0 },
    errors: [],
    sample: [],
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

  const symbols: string[] = [];
  const symbolToSec = new Map<string, (typeof targets)[number]>();
  for (const s of targets) {
    const sym = toYahooSymbol(s.ticker, s.exchange);
    symbols.push(sym);
    symbolToSec.set(sym, s);
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
    const sec = symbolToSec.get(sym);
    if (!sec) return;
    if (!q || q.price == null || !Number.isFinite(q.price)) {
      result.skipped.noQuote += 1;
      return;
    }
    const ccy = resolvePriceCurrency(q.currency, sec.currency);
    if (!ccy) {
      result.skipped.unsupportedCurrency += 1;
      return;
    }
    toUpsert.push({ securityId: sec.id, date, closePrice: q.price.toString(), currency: ccy, source: "yahoo" });
    if (result.sample.length < 8) {
      result.sample.push({ ticker: sec.ticker, close: q.price.toString(), currency: ccy });
    }
  });

  if (toUpsert.length > 0) {
    await db
      .insert(prices)
      .values(toUpsert)
      .onConflictDoUpdate({
        target: [prices.securityId, prices.date],
        set: {
          closePrice: sql`excluded.close_price`,
          currency: sql`excluded.currency`,
          source: sql`excluded.source`,
        },
      });
    result.pricesUpserted = toUpsert.length;
  }

  return result;
}
