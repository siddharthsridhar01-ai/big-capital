/**
 * Worker: Daily NAV snapshot
 *
 * For each active fund:
 *   1. Replay transactions to get ledger state (positions + cash) as-of date
 *   2. Look up prices and FX rates for that date
 *   3. Compute NAV in the fund's base currency
 *   4. Compute daily return vs previous NAV
 *   5. Compute benchmark daily return for the same period
 *   6. Upsert into nav_snapshots
 *
 * Schedule: weekdays at 23:00 UTC (after price + FX ingest).
 * Vercel cron: 0 23 * * 1-5
 *
 * Idempotency: ON CONFLICT updates allow re-running for any date.
 * Backfill: pass a `from` date to recompute a range.
 */

import { db } from "../db/client";
import {
  funds,
  prices,
  fxRates,
  navSnapshots,
  securities,
  transactions as transactionsTable,
} from "../db/schema";
import {
  buildLedgerState,
  computeNav,
  type Transaction,
  type Currency,
} from "../lib/performance";
import { seedOpeningCash } from "../lib/holdings-reconstruction";
import { sql, eq, and, lte, gte } from "drizzle-orm";
import Decimal from "decimal.js";

// Synthetic cash-hurdle benchmarks for absolute-return funds (market-neutral,
// net-long L/S): accrue a flat daily rate instead of ratioing a market price.
// ~USD SOFR / GBP SONIA cash level; a simplification, tunable here.
const CASH_HURDLE_TICKERS = new Set(["SOFR_CASH", "SONIA_CASH"]);
const CASH_HURDLE_ANNUAL_RATE = 0.043;
const CASH_HURDLE_DAILY_RATE = new Decimal(CASH_HURDLE_ANNUAL_RATE).dividedBy(252);

export interface NavSnapshotResult {
  fundsProcessed: number;
  daysComputed: number;
  errors: Array<{ fundId: string; date: string; message: string }>;
}

export async function runNavSnapshot(
  options: { date?: string; fromDate?: string } = {}
): Promise<NavSnapshotResult> {
  const result: NavSnapshotResult = {
    fundsProcessed: 0,
    daysComputed: 0,
    errors: [],
  };

  // 1. Get all active funds with their benchmark info
  const activeFunds = await db
    .select({
      id: funds.id,
      slug: funds.slug,
      baseCurrency: funds.baseCurrency,
      inceptionDate: funds.inceptionDate,
      startingNav: funds.startingNav,
      benchmarkSecurityId: funds.benchmarkSecurityId,
      benchmarkTicker: securities.ticker,
    })
    .from(funds)
    .leftJoin(securities, eq(securities.id, funds.benchmarkSecurityId))
    .where(eq(funds.isActive, true));

  // 2. Determine date range to compute
  const targetDate = options.date ?? new Date().toISOString().slice(0, 10);
  const fromDate = options.fromDate ?? targetDate;

  // Build list of dates we'll iterate
  const dates: string[] = [];
  for (
    let d = new Date(fromDate);
    d <= new Date(targetDate);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const ds = d.toISOString().slice(0, 10);
    // Skip weekends (no NAV on Sat/Sun)
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    dates.push(ds);
  }

  // 3. Per-fund computation
  for (const fund of activeFunds) {
    result.fundsProcessed += 1;
    // Skip dates before inception
    const fundDates = dates.filter((d) => d >= fund.inceptionDate);
    if (fundDates.length === 0) continue;

    // Pull ALL transactions for this fund once (cheap; ledger is small)
    const fundTransactions = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.fundId, fund.id));

    // Coerce DB rows to the performance-engine Transaction type
    const txns: Transaction[] = fundTransactions.map((t) => ({
      id: t.id,
      fundId: t.fundId,
      securityId: t.securityId,
      transactionType: t.transactionType as Transaction["transactionType"],
      quantity: t.quantity,
      price: t.price,
      currency: t.currency as Currency,
      cashImpact: t.cashImpact,
      fxRateToBase: t.fxRateToBase,
      executedAt: t.executedAt,
    }));

    let previousNav: Decimal | null = null;

    // Opening capital (funds.startingNav) is the fund's initial cash, not a
    // ledger transaction — seed it into base-currency cash unless the ledger
    // already models it as an explicit cash_deposit (then trust the ledger).
    const hasLedgerDeposit = fundTransactions.some((t) => t.transactionType === "cash_deposit");

    for (const date of fundDates) {
      try {
        const asOf = new Date(`${date}T23:59:59Z`);
        const state = buildLedgerState(txns, asOf);
        seedOpeningCash(state, fund.baseCurrency as Currency, fund.startingNav, hasLedgerDeposit);

        // Gather prices and FX needed
        const securityIds = Array.from(state.positions.keys());
        const allSecIds = fund.benchmarkSecurityId
          ? [...securityIds, fund.benchmarkSecurityId]
          : securityIds;

        const priceRows =
          allSecIds.length > 0
            ? await db
                .select()
                .from(prices)
                .where(
                  and(
                    lte(prices.date, date),
                    // We want the latest price on-or-before this date
                  )
                )
                .orderBy(sql`${prices.date} DESC`)
            : [];

        // Build "latest price as-of date" map per security
        const latestPriceMap = new Map<string, { price: string; date: string; currency: Currency }>();
        for (const row of priceRows) {
          if (!allSecIds.includes(row.securityId)) continue;
          if (!latestPriceMap.has(row.securityId)) {
            latestPriceMap.set(row.securityId, {
              price: row.closePrice,
              date: row.date,
              currency: row.currency as Currency,
            });
          }
        }

        const priceForCompute = new Map<string, string>();
        const priceCurrencies = new Map<string, Currency>();
        let missingPrice = false;
        for (const secId of securityIds) {
          const p = latestPriceMap.get(secId);
          if (!p) {
            missingPrice = true;
            break;
          }
          priceForCompute.set(secId, p.price);
          priceCurrencies.set(secId, p.currency);
        }

        if (missingPrice) {
          result.errors.push({
            fundId: fund.id,
            date,
            message: "Missing price for one or more positions",
          });
          continue;
        }

        // FX rates: pull all rates for this date
        const fxRows = await db
          .select()
          .from(fxRates)
          .where(eq(fxRates.date, date));
        const fxMap = new Map<string, string>();
        for (const row of fxRows) {
          fxMap.set(
            `${row.fromCurrency}/${row.toCurrency}/${row.date}`,
            row.rate
          );
        }

        const snap = computeNav({
          fundId: fund.id,
          date,
          baseCurrency: fund.baseCurrency as Currency,
          components: state,
          prices: priceForCompute,
          priceCurrencies,
          fxRates: fxMap,
          previousNav,
        });

        // Benchmark return for the same period
        let benchmarkDailyReturn: string | null = null;
        let benchmarkValue: string | null = null;
        if (fund.benchmarkSecurityId) {
          if (fund.benchmarkTicker && CASH_HURDLE_TICKERS.has(fund.benchmarkTicker)) {
            // Synthetic cash hurdle (e.g. SOFR/SONIA): no market price to ratio,
            // so accrue a flat daily rate. This lets absolute-return funds
            // (market-neutral, net-long L/S) be measured against cash rather than
            // a misleading equity index. Full history is computable from inception
            // since it doesn't depend on fetched prices.
            benchmarkDailyReturn = CASH_HURDLE_DAILY_RATE.toString();
          } else {
            const benchPrice = latestPriceMap.get(fund.benchmarkSecurityId);
            if (benchPrice) {
              benchmarkValue = benchPrice.price;
              // Look up previous day's benchmark price
              const prevBench = priceRows.find(
                (r) =>
                  r.securityId === fund.benchmarkSecurityId &&
                  r.date < date
              );
              if (prevBench) {
                const today = new Decimal(benchPrice.price);
                const yesterday = new Decimal(prevBench.closePrice);
                if (!yesterday.isZero()) {
                  benchmarkDailyReturn = today
                    .minus(yesterday)
                    .dividedBy(yesterday)
                    .toString();
                }
              }
            }
          }
        }

        await db
          .insert(navSnapshots)
          .values({
            fundId: fund.id,
            date,
            nav: snap.nav.toString(),
            cashBalance: snap.cashBalance.toString(),
            positionValue: snap.positionValue.toString(),
            grossExposure: snap.grossExposure.toString(),
            netExposure: snap.netExposure.toString(),
            dailyReturn: snap.dailyReturn?.toString() ?? null,
            benchmarkValue,
            benchmarkDailyReturn,
          })
          .onConflictDoUpdate({
            target: [navSnapshots.fundId, navSnapshots.date],
            set: {
              nav: sql`excluded.nav`,
              cashBalance: sql`excluded.cash_balance`,
              positionValue: sql`excluded.position_value`,
              grossExposure: sql`excluded.gross_exposure`,
              netExposure: sql`excluded.net_exposure`,
              dailyReturn: sql`excluded.daily_return`,
              benchmarkValue: sql`excluded.benchmark_value`,
              benchmarkDailyReturn: sql`excluded.benchmark_daily_return`,
            },
          });

        previousNav = snap.nav;
        result.daysComputed += 1;
      } catch (err) {
        result.errors.push({
          fundId: fund.id,
          date,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const date = process.argv[2];
  const fromDate = process.argv[3];
  runNavSnapshot({ date, fromDate })
    .then((r) => {
      console.log("NAV snapshot complete:", r);
      if (r.errors.length > 0) process.exit(1);
      process.exit(0);
    })
    .catch((err) => {
      console.error("NAV snapshot failed:", err);
      process.exit(1);
    });
}
