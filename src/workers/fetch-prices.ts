/**
 * Worker: Daily price ingest
 *
 * For every active security held by any fund (or used as a benchmark),
 * fetch the latest EOD price from EODHD and upsert into `prices`.
 *
 * Strategy:
 *   1. Build the set of securities we care about: anything with a non-zero
 *      net position across funds, plus all benchmarks, plus anything in any
 *      investable universe (so universe-wide screens can be built).
 *   2. Group by exchange.
 *   3. For each exchange, use the BULK endpoint (1 call per exchange) and
 *      filter to our symbols. This is dramatically cheaper than per-symbol
 *      calls.
 *   4. Upsert into `prices` keyed by (security_id, date).
 *
 * Schedule: weekdays at 22:30 UTC (after major markets close).
 * Vercel cron: 30 22 * * 1-5
 */

import { db } from "../db/client";
import { prices, securities, transactions, investableUniverses } from "../db/schema";
import { EodhdClient, toEodhdExchange } from "../lib/eodhd";
import { sql, and, eq, isNull, isNotNull, ne } from "drizzle-orm";

export interface PriceIngestResult {
  exchangesProcessed: number;
  securitiesPriced: number;
  pricesUpserted: number;
  errors: Array<{ exchange: string; message: string }>;
}

export async function runPriceIngest(date?: string): Promise<PriceIngestResult> {
  const apiToken = process.env.EODHD_API_TOKEN;
  if (!apiToken) throw new Error("EODHD_API_TOKEN not set");
  const client = new EodhdClient({ apiToken });

  // 1. Determine the set of securities we need prices for.
  //    Union of: held positions, benchmarks, investable universes.
  const targetSecurities = await db
    .selectDistinct({
      id: securities.id,
      ticker: securities.ticker,
      exchange: securities.exchange,
      currency: securities.currency,
    })
    .from(securities)
    .where(and(eq(securities.isActive, true), ne(securities.exchange, "INDEX")));

  // Group by EODHD exchange code (US venues collapse into one "US" bulk call).
  const byExchange = new Map<
    string,
    Array<{ id: string; ticker: string; currency: string }>
  >();
  for (const s of targetSecurities) {
    const ex = toEodhdExchange(s.exchange);
    if (!byExchange.has(ex)) byExchange.set(ex, []);
    byExchange.get(ex)!.push({
      id: s.id,
      ticker: s.ticker,
      currency: s.currency,
    });
  }

  const result: PriceIngestResult = {
    exchangesProcessed: 0,
    securitiesPriced: 0,
    pricesUpserted: 0,
    errors: [],
  };

  // 2. For each exchange, pull bulk EOD and upsert
  for (const [exchange, secs] of byExchange) {
    try {
      const symbols = secs.map((s) => s.ticker);
      const rows = await client.getBulkEodForExchange(
        exchange,
        date,
        symbols.length > 0 ? symbols : undefined
      );

      // Map ticker -> security row for the upsert
      const tickerToSec = new Map(secs.map((s) => [s.ticker, s]));

      const toUpsert = rows
        .filter((r) => tickerToSec.has(r.code))
        .map((r) => {
          const sec = tickerToSec.get(r.code)!;
          return {
            securityId: sec.id,
            date: r.date,
            closePrice: r.close.toString(),
            currency: sec.currency as "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD",
            source: "EODHD",
          };
        });

      if (toUpsert.length > 0) {
        await db
          .insert(prices)
          .values(toUpsert)
          .onConflictDoUpdate({
            target: [prices.securityId, prices.date],
            set: {
              closePrice: sql`excluded.close_price`,
              source: sql`excluded.source`,
            },
          });
        result.pricesUpserted += toUpsert.length;
        result.securitiesPriced += toUpsert.length;
      }

      result.exchangesProcessed += 1;
    } catch (err) {
      result.errors.push({
        exchange,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const dateArg = process.argv[2];
  runPriceIngest(dateArg)
    .then((r) => {
      console.log("Price ingest complete:", r);
      if (r.errors.length > 0) {
        console.error(`${r.errors.length} errors:`, r.errors);
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Price ingest failed:", err);
      process.exit(1);
    });
}
