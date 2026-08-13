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
 * Schedule: weekdays at 22:40 UTC via GitHub Actions (after price + FX ingest).
 * The vercel.json crons were removed — GitHub Actions is the only scheduler.
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
import { sql, eq, and, lte, gte, lt, desc } from "drizzle-orm";
import Decimal from "decimal.js";

// Synthetic cash-hurdle benchmarks for absolute-return funds (market-neutral,
// net-long L/S): accrue a flat daily rate instead of ratioing a market price.
// ~USD SOFR / GBP SONIA cash level; a simplification, tunable here.
const CASH_HURDLE_TICKERS = new Set(["SOFR_CASH", "SONIA_CASH"]);
const CASH_HURDLE_ANNUAL_RATE = 0.043;
const CASH_HURDLE_DAILY_RATE = new Decimal(CASH_HURDLE_ANNUAL_RATE).dividedBy(252);

/** Drizzle returns `date` columns as either a string or a Date depending on driver. */
function ymdOf(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

export interface NavSnapshotResult {
  fundsProcessed: number;
  daysComputed: number;
  errors: Array<{ fundId: string; date: string; message: string }>;
  /**
   * Dates skipped because that trading day's closes had not been ingested yet.
   * Expected when the job runs mid-session; the next run picks them up.
   */
  skippedAwaitingCloses: Array<{ fundId: string; date: string }>;
  /**
   * Funds with a backlog larger than one run can safely compute. The next run
   * picks up where this one stopped.
   */
  truncated: Array<{ fundId: string; pending: number }>;
}

export async function runNavSnapshot(
  options: { date?: string; fromDate?: string } = {}
): Promise<NavSnapshotResult> {
  const result: NavSnapshotResult = {
    fundsProcessed: 0,
    daysComputed: 0,
    errors: [],
    skippedAwaitingCloses: [],
    truncated: [],
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

  // Default look-back so a delayed or missed run heals itself.
  //
  // Previously fromDate defaulted to targetDate, so the nightly job computed
  // exactly one day. If GitHub ran the job late (it has run up to three hours
  // behind, past midnight UTC) or skipped it, that day simply never got a
  // snapshot and nothing ever filled it in — gaps had to be spotted by eye and
  // backfilled by hand. Snapshots are an idempotent upsert, so recomputing a
  // short trailing window is cheap and closes gaps automatically.
  // The window only bounds how far back a gap can be healed automatically; the
  // per-fund filter below means a normal night still computes a single day. 30
  // covers a missed fortnight comfortably without ever being the work actually
  // done on a healthy night.
  const DEFAULT_LOOKBACK_DAYS = 30;
  const defaultFrom = new Date(`${targetDate}T00:00:00Z`);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - DEFAULT_LOOKBACK_DAYS);
  const fromDate = options.fromDate ?? defaultFrom.toISOString().slice(0, 10);

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

    // Which dates does THIS fund actually need?
    //
    // The window above is deliberately wide so a missed night can heal. But
    // recomputing all of it every night is what killed this job: the nightly
    // route is capped at 60s on Vercel's Hobby plan, and 14 days across six
    // funds returned HTTP 504 mid-run, so NAV silently stopped updating.
    //
    // On an explicit backfill (?from=) honour exactly what was asked. Otherwise
    // compute only what is MISSING: the day after this fund's latest snapshot,
    // through today. A normal night is therefore one day, as it was before, and
    // a gap still heals automatically but costs only the size of the gap.
    let fundDates = dates.filter((d) => d >= ymdOf(fund.inceptionDate));

    if (!options.fromDate) {
      const [latest] = await db
        .select({ date: navSnapshots.date })
        .from(navSnapshots)
        .where(eq(navSnapshots.fundId, fund.id))
        .orderBy(desc(navSnapshots.date))
        .limit(1);
      if (latest) {
        const lastDone = ymdOf(latest.date);

        // Recompute the two most recent days even when a snapshot exists.
        //
        // "Only missing days" is right for settled history but wrong at the
        // front: a closing price is provisional until the auction settles, so a
        // snapshot struck between 16:30 and the LSE auction print uses a
        // pre-auction price. Skipping days that already exist meant that
        // provisional value was frozen permanently — the fund would carry a
        // slightly wrong close for that date forever.
        //
        // Snapshots are an idempotent upsert, so re-striking is cheap and simply
        // overwrites with better prices. Two days covers a late auction print
        // and a next-morning vendor correction without touching settled history.
        const REVISABLE_DAYS = 2;
        const revisableFrom = new Date(`${targetDate}T00:00:00Z`);
        revisableFrom.setUTCDate(revisableFrom.getUTCDate() - (REVISABLE_DAYS - 1));
        const revisableFromYmd = revisableFrom.toISOString().slice(0, 10);

        fundDates = fundDates.filter((d) => d > lastDone || d >= revisableFromYmd);
      }
    }

    // Hard cap per run. If a fund has been unattended for months, computing all
    // of it inside one 60s request would fail outright and heal nothing. Doing
    // the oldest chunk each night converges instead, and an operator wanting it
    // done at once can still pass ?from= and chunk it explicitly.
    const MAX_DAYS_PER_RUN = 7;
    if (!options.fromDate && fundDates.length > MAX_DAYS_PER_RUN) {
      result.truncated.push({ fundId: fund.id, pending: fundDates.length });
      fundDates = fundDates.slice(0, MAX_DAYS_PER_RUN);
    }

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

    // Seed the prior NAV from the most recent snapshot STRICTLY BEFORE the first
    // date we are about to compute.
    //
    // Without this, `previousNav` starts null and the first day of every run has
    // no baseline, so its dailyReturn is stored as null. The nightly cron computes
    // exactly one day (fromDate defaults to targetDate), so EVERY nightly snapshot
    // was landing with dailyReturn = null. timeWeightedReturn() skips nulls
    // silently, so the public factsheet's cumulative return, volatility and Sharpe
    // all under-reported — while the dashboard, which uses a simple
    // (nav / startingNav - 1), showed the true figure. Benchmark returns were
    // unaffected because they derive from benchmark prices, not previousNav, which
    // is why only the fund line disagreed.
    const firstDate = fundDates[0];
    const priorSnapshot = await db
      .select({ nav: navSnapshots.nav })
      .from(navSnapshots)
      .where(and(eq(navSnapshots.fundId, fund.id), lt(navSnapshots.date, firstDate)))
      .orderBy(desc(navSnapshots.date))
      .limit(1);

    let previousNav: Decimal | null =
      priorSnapshot.length > 0 ? new Decimal(priorSnapshot[0].nav) : null;

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

        // A NAV for date D must be struck from D's own CLOSES.
        //
        // Two traps this avoids:
        //
        //  1. The price query below is "latest close on or before D", which is
        //     right for a security that did not trade that day — but it also
        //     means asking for TODAY mid-session silently reuses YESTERDAY's
        //     close and stamps it as today's NAV, fabricating a point on the
        //     public chart that looks like a real close.
        //
        //  2. The legacy quote pass (fetch-prices-yahoo) writes rows dated TODAY
        //     from a LIVE mid-session quote, tagged source "yahoo". Those are not
        //     closes, so merely finding a row dated D proves nothing. Only the
        //     chart-based ingests ("yahoo-eod", "yahoo-backfill") write real
        //     closes.
        //
        // Evidence that D is finished: the fund's benchmark has a close for D.
        // The benchmark tracks the fund's home market, so its close is exactly
        // the "this market has finished trading" signal. Funds benchmarked to a
        // synthetic cash hurdle (SOFR_CASH/SONIA_CASH) have no price rows at
        // all, so fall back to the held securities; a pure-cash fund with no
        // usable benchmark has nothing to wait for and is allowed through.
        const CLOSE_SOURCES = new Set(["yahoo-eod", "yahoo-backfill"]);
        const benchmarkIsSynthetic =
          !fund.benchmarkTicker || CASH_HURDLE_TICKERS.has(fund.benchmarkTicker);

        // HOLDINGS FIRST, benchmark only as a fallback.
        //
        // This was the other way round, and it cost four funds their 12 Aug
        // snapshot. Yahoo simply has no 12 Aug bar for FTAL.L, IWDA.L or CSPX.L
        // — not late, absent — while every held security had one. Treating the
        // benchmark as proof that the trading day finished meant a gap in a
        // COMPARISON index blocked the VALUATION of the portfolio.
        //
        // NAV is a valuation of what the fund owns. If the things it owns have
        // closes for D, D is finished and the fund can be valued. A missing
        // benchmark price is handled gracefully downstream: the benchmark lookup
        // takes the latest close on or before D, so that day's benchmark return
        // is 0 and the next day's spans both. The cumulative benchmark line
        // stays correct; only the daily attribution is lumpy for one day.
        const evidenceIds =
          securityIds.length > 0
            ? securityIds
            : !benchmarkIsSynthetic && fund.benchmarkSecurityId
              ? [fund.benchmarkSecurityId]
              : [];

        // A NAV must be struck at the SAME valuation point every day: every
        // holding at its own official close for that date.
        //
        // Requiring only ONE holding to have closed was safe while NAV ran once
        // nightly, after every market had shut. It is not safe now that the
        // catch-up runs hourly: a global fund could be struck mid-afternoon with
        // Asian closes in and US ones not, valuing the US names at the previous
        // close. Same date, different valuation point depending on the hour it
        // happened to run — which makes the daily return series incomparable.
        //
        // So for a RECENT date, wait until every holding has a close for it. For
        // an OLDER date, accept what exists: by then a missing close means the
        // security genuinely did not trade (market holiday, suspension), and
        // carrying the previous close forward is the correct treatment rather
        // than a reason to never value the fund at all.
        const closedForDate = new Set(
          priceRows
            .filter((r) => r.date === date && CLOSE_SOURCES.has(r.source ?? ""))
            .map((r) => r.securityId)
        );

        const SETTLED_AFTER_DAYS = 2;
        const ageDays = Math.floor(
          (Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000
        );
        const dateIsSettled = ageDays >= SETTLED_AFTER_DAYS;

        const missing = evidenceIds.filter((id) => !closedForDate.has(id));
        const waiting = dateIsSettled
          ? evidenceIds.length > 0 && missing.length === evidenceIds.length // nothing closed at all
          : missing.length > 0; // recent date: every holding must have closed

        if (evidenceIds.length > 0 && waiting) {
          result.skippedAwaitingCloses.push({ fundId: fund.id, date });
          continue;
        }

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
        // Latest rate ON OR BEFORE the date, not an exact-date match.
        //
        // convertToBase() throws when a pair has no rate, so an exact match meant
        // one missing fxRates row cost a fund its entire NAV for that day. ECB
        // publishes on TARGET days, which do not align with market holidays, so
        // there are dates where the LSE and NYSE trade normally and no reference
        // rate exists — precisely the failure that lost 12 Aug to a benchmark
        // gap, waiting to happen again in FX.
        //
        // Carrying the last published rate forward is also the correct treatment
        // rather than a workaround: if no fixing occurred, the rate did not
        // change. Consistency holds because a normal day still uses that day's
        // own rate; only a non-publication day reuses the prior one.
        const fxRows = await db
          .select()
          .from(fxRates)
          .where(lte(fxRates.date, date))
          .orderBy(desc(fxRates.date));

        const fxMap = new Map<string, string>();
        for (const row of fxRows) {
          // Rows arrive newest-first, so the first sighting of a pair is the most
          // recent rate for it. Key it under the REQUESTED date, which is what
          // convertToBase() looks up.
          const pair = `${row.fromCurrency}/${row.toCurrency}`;
          const key = `${pair}/${date}`;
          if (!fxMap.has(key)) fxMap.set(key, row.rate);
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
        // On the inception date there is no prior day inside the fund's life, so
        // no return has been earned yet — by anyone. The fund's own dailyReturn
        // is already null here (previousNav is null). The benchmark was not:
        // it ratioed against the last close BEFORE inception, so the rebased
        // benchmark line started a day's move away from startingNav while the
        // fund line started exactly on it. Suppressing it makes both lines begin
        // together at the fund's opening capital, which is what "rebased to
        // £100,000" should mean.
        const isInceptionDate = date === ymdOf(fund.inceptionDate);
        if (fund.benchmarkSecurityId && !isInceptionDate) {
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
