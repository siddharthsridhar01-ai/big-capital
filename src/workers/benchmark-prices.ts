/**
 * Benchmark price refresh — records daily closes for the priceable benchmark
 * proxies (e.g. FTAL.L, IWDA.L) via Yahoo's historical chart endpoint.
 *
 * These securities are `isBenchmark=true` with a real exchange (not the
 * synthetic "INDEX" cash hurdle). They are deliberately NOT picked up by the
 * ordinary nightly EOD quote ingest, so this is the one path that keeps their
 * price series current. Run nightly over a short trailing window (self-heals a
 * missed run or holiday gap) and, for history, over a long range from inception.
 * Idempotent — upserts by (security, date).
 */
import { db } from "@/db/client";
import { prices, securities } from "@/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance();

type StoreCurrency =
  | "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD";

export interface BenchmarkRefreshReport {
  from: string;
  to: string;
  report: Array<Record<string, unknown>>;
}

export async function refreshBenchmarkPrices(
  from: string,
  to?: string
): Promise<BenchmarkRefreshReport> {
  const toDate = to ?? new Date().toISOString().slice(0, 10);

  const benchSecs = await db
    .select({
      id: securities.id,
      ticker: securities.ticker,
      exchange: securities.exchange,
      currency: securities.currency,
    })
    .from(securities)
    .where(and(eq(securities.isBenchmark, true), ne(securities.exchange, "INDEX")));

  const report: Array<Record<string, unknown>> = [];

  for (const sec of benchSecs) {
    const sym = toYahooSymbol(sec.ticker, sec.exchange);
    try {
      // Yahoo's period2 is EXCLUSIVE, so passing today omits today's bar.
      // Request through tomorrow to include the latest session.
      const chart = await yf.chart(sym, {
        period1: from,
        period2: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
        interval: "1d",
      });
      const meta = (chart.meta?.currency as string | undefined) ?? "";
      const isPence = meta === "GBp" || meta === "GBX";
      const storeCurrency = (isPence ? "GBP" : sec.currency) as StoreCurrency;

      if (storeCurrency !== "GBP" && storeCurrency !== "USD" && storeCurrency !== "EUR") {
        report.push({ symbol: sym, status: "unsupported_currency", metaCurrency: meta });
        continue;
      }

      const rows: Array<{
        securityId: string;
        date: string;
        closePrice: string;
        currency: StoreCurrency;
        source: string;
      }> = [];
      for (const q of chart.quotes ?? []) {
        const close = q.close;
        if (close == null || !Number.isFinite(close) || !q.date) continue;
        const d = new Date(q.date).toISOString().slice(0, 10);
        const price = isPence ? close / 100 : close;
        rows.push({
          securityId: sec.id,
          date: d,
          closePrice: price.toString(),
          currency: storeCurrency,
          source: "yahoo-backfill",
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
      }

      report.push({
        symbol: sym,
        status: "ok",
        currency: storeCurrency,
        metaCurrency: meta,
        daysStored: rows.length,
        firstDate: rows[0]?.date ?? null,
        lastDate: rows[rows.length - 1]?.date ?? null,
        lastClose: rows[rows.length - 1]?.closePrice ?? null,
      });
    } catch (err) {
      report.push({
        symbol: sym,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { from, to: toDate, report };
}
