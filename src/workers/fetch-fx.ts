/**
 * Worker: Daily FX rate ingest
 *
 * Fetches the last 90 days of ECB euro reference rates, expands to all
 * currency pairs we support, and upserts into `fx_rates`. Idempotent —
 * safe to run multiple times per day.
 *
 * Schedule: nightly at 17:00 UTC (after ECB publishes ~16:00 CET).
 * Vercel cron: 0 17 * * 1-5
 *
 * Why 90 days every run, not just today?
 *   - ECB occasionally publishes corrections
 *   - If a cron run fails, the next one self-heals without manual intervention
 *   - 90 days × 6 pairs = ~540 rows; tiny upsert
 */

import { db } from "../db/client";
import { fxRates } from "../db/schema";
import { EcbFxClient } from "../lib/ecb-fx";
import { sql } from "drizzle-orm";

export async function runFxIngest(): Promise<{
  daysFetched: number;
  rowsUpserted: number;
}> {
  const ecb = new EcbFxClient("big-capital-fx-worker/0.1");
  const days = await ecb.getLast90Days();
  const rows = EcbFxClient.expandToFxRows(days, ["GBP", "USD", "EUR", "JPY", "HKD", "CNY", "KRW", "SGD", "INR"]);

  if (rows.length === 0) {
    console.warn("FX ingest: ECB returned no rows");
    return { daysFetched: 0, rowsUpserted: 0 };
  }

  // Batch upsert in chunks of 200 to keep query size sane
  const CHUNK = 200;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK).map((r) => ({
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      date: r.date,
      rate: r.rate.toString(),
      source: "ECB",
    }));

    await db
      .insert(fxRates)
      .values(batch)
      .onConflictDoUpdate({
        target: [fxRates.fromCurrency, fxRates.toCurrency, fxRates.date],
        set: {
          rate: sql`excluded.rate`,
          source: sql`excluded.source`,
        },
      });
    upserted += batch.length;
  }

  return { daysFetched: days.length, rowsUpserted: upserted };
}

// CLI entrypoint for `pnpm worker:fx`
if (import.meta.url === `file://${process.argv[1]}`) {
  runFxIngest()
    .then((r) => {
      console.log(
        `FX ingest complete: ${r.daysFetched} days, ${r.rowsUpserted} rows upserted`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("FX ingest failed:", err);
      process.exit(1);
    });
}
