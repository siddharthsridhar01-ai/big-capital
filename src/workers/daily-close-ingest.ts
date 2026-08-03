/**
 * Daily-close ingest — records real daily CLOSE prices for every priceable
 * security via Yahoo's historical chart endpoint (not the live-quote path).
 *
 * The chart endpoint returns the official close per exchange for each trading
 * day, so it's correct for markets in any timezone and reliable where the batch
 * quote path is flaky. Used two ways:
 *   - Backfill:   long window (e.g. 1 year) to give every name deep history.
 *   - Nightly:    short trailing window (self-heals a missed run / holiday gap).
 * Idempotent — upserts by (security, date). Runs with light concurrency so it
 * stays well within the cron time budget even with dozens of names.
 */
import { db } from "@/db/client";
import { prices, securities } from "@/db/schema";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import { getQuotes } from "@/lib/intraday/cache";
import { activeProvider } from "@/lib/intraday/provider";
import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance();

type StoreCurrency =
  | "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD";
const SUPPORTED: StoreCurrency[] = [
  "GBP", "USD", "EUR", "JPY", "HKD", "CNY", "KRW", "SGD", "INR", "TWD",
];

export interface DailyCloseIngestResult {
  from: string;
  to: string;
  securities: number;
  okCount: number;
  errors: number;
  rowsUpserted: number;
  report: Array<{
    symbol: string;
    status: string;
    daysStored?: number;
    lastDate?: string | null;
    lastClose?: string | null;
    message?: string;
  }>;
}

export async function ingestDailyCloses(
  from: string,
  to?: string,
  opts?: { concurrency?: number; finalisedOnly?: boolean }
): Promise<DailyCloseIngestResult> {
  const toDate = to ?? new Date().toISOString().slice(0, 10);
  const concurrency = opts?.concurrency ?? 5;
  const finalisedOnly = opts?.finalisedOnly ?? false;
  const todayUtc = new Date().toISOString().slice(0, 10);

  // Every priceable security: a real exchange (not the synthetic "INDEX" cash
  // hurdle), and either active (held/watchlist) or a benchmark proxy.
  const secs = await db
    .select({
      id: securities.id,
      ticker: securities.ticker,
      exchange: securities.exchange,
      currency: securities.currency,
    })
    .from(securities)
    .where(
      and(
        ne(securities.exchange, "INDEX"),
        or(eq(securities.isActive, true), eq(securities.isBenchmark, true))
      )
    );

  // When only finalised sessions should be stored, we need each security's
  // market state: a market that is still trading has an IN-PROGRESS bar, and
  // storing that as the day's "close" would be wrong. Batched into one call.
  const stateBySecurity = new Map<string, string>();
  if (finalisedOnly && secs.length > 0) {
    try {
      const quotes = await getQuotes(
        activeProvider,
        secs.map((s2) => ({
          securityId: s2.id,
          symbol: toYahooSymbol(s2.ticker, s2.exchange),
        }))
      );
      for (const q of quotes) {
        if (q.quote?.marketState) stateBySecurity.set(q.securityId, q.quote.marketState);
      }
    } catch (err) {
      console.error("[daily-close-ingest] market-state batch failed:", err);
    }
  }

  const result: DailyCloseIngestResult = {
    from,
    to: toDate,
    securities: secs.length,
    okCount: 0,
    errors: 0,
    rowsUpserted: 0,
    report: [],
  };

  const handle = async (sec: (typeof secs)[number]) => {
    const sym = toYahooSymbol(sec.ticker, sec.exchange);
    try {
      const chart = await yf.chart(sym, {
        period1: from,
        period2: toDate,
        interval: "1d",
      });
      const meta = (chart.meta?.currency as string | undefined) ?? "";
      const isPence = meta === "GBp" || meta === "GBX";
      const storeCurrency = (isPence ? "GBP" : sec.currency) as StoreCurrency;
      if (!SUPPORTED.includes(storeCurrency)) {
        result.report.push({ symbol: sym, status: "unsupported_currency" });
        return;
      }

      const rows: Array<{
        securityId: string;
        date: string;
        closePrice: string;
        currency: StoreCurrency;
        source: string;
      }> = [];
      // If this market is still in its session, today's bar is in progress —
      // exclude it so a mid-session price never gets recorded as the close.
      const st = stateBySecurity.get(sec.id);
      const skipToday = finalisedOnly && (st === "REGULAR" || st === "PRE");

      for (const q of chart.quotes ?? []) {
        const close = q.close;
        if (close == null || !Number.isFinite(close) || !q.date) continue;
        const d = new Date(q.date).toISOString().slice(0, 10);
        if (skipToday && d === todayUtc) continue;
        const price = isPence ? close / 100 : close;
        rows.push({
          securityId: sec.id,
          date: d,
          closePrice: price.toString(),
          currency: storeCurrency,
          source: "yahoo-eod",
        });
      }

      if (rows.length > 0) {
        const CHUNK = 200;
        for (let i = 0; i < rows.length; i += CHUNK) {
          await db
            .insert(prices)
            .values(rows.slice(i, i + CHUNK))
            .onConflictDoUpdate({
              target: [prices.securityId, prices.date],
              set: {
                closePrice: sql`excluded.close_price`,
                currency: sql`excluded.currency`,
                source: sql`excluded.source`,
              },
            });
        }
        result.rowsUpserted += rows.length;
      }

      result.okCount += 1;
      result.report.push({
        symbol: sym,
        status: "ok",
        daysStored: rows.length,
        lastDate: rows[rows.length - 1]?.date ?? null,
        lastClose: rows[rows.length - 1]?.closePrice ?? null,
      });
    } catch (err) {
      result.errors += 1;
      result.report.push({
        symbol: sym,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Bounded-concurrency pool over the securities list.
  let idx = 0;
  const worker = async () => {
    while (idx < secs.length) {
      const i = idx++;
      await handle(secs[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, secs.length) }, () => worker())
  );

  return result;
}
