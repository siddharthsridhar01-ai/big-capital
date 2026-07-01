/**
 * Lagged public-holdings reconstruction worker.
 *
 * For each active fund, reconstructs the portfolio as at the most recent
 * eligible month-end (top-10) and quarter-end (full) from the immutable
 * transaction ledger, values it in base currency, computes weights against
 * the as-of NAV, and upserts public_holdings_snapshots.
 *
 * Privacy boundary: this is the ONLY job that reads live positions. The public
 * pages read public_holdings_snapshots and never touch the live book.
 */

import { db } from "../db/client";
import {
  funds,
  transactions as transactionsTable,
  prices,
  fxRates,
  securities,
  navSnapshots,
  publicHoldingsSnapshots,
} from "../db/schema";
import { buildLedgerState, type Transaction, type Currency } from "../lib/performance";
import {
  buildHoldings,
  packageSnapshot,
  resolvePositionPrice,
  seedOpeningCash,
  mostRecentEligibleMonthEnd,
  mostRecentEligibleQuarterEnd,
  firstDayOfMonthOf,
  type SecurityMeta,
} from "../lib/holdings-reconstruction";
import { and, eq, lte, sql } from "drizzle-orm";

interface RunOptions {
  fundSlug?: string; // limit to one fund
  today?: Date; // override "now" (testing/backfill)
}

interface RunResult {
  asOf: { top10: string; full: string };
  fundsProcessed: number;
  snapshotsWritten: number;
  skipped: { fund: string; type: string; asOf: string; reason: string }[];
  valuedAtCost: { fund: string; type: string; asOf: string; ticker: string }[];
  errors: { fund: string; type: string; message: string }[];
}

export async function runHoldingsReconstruction(options: RunOptions = {}): Promise<RunResult> {
  const today = options.today ?? new Date();
  const monthEnd = mostRecentEligibleMonthEnd(today);
  const quarterEnd = mostRecentEligibleQuarterEnd(today);

  const result: RunResult = {
    asOf: { top10: monthEnd, full: quarterEnd },
    fundsProcessed: 0,
    snapshotsWritten: 0,
    skipped: [],
    valuedAtCost: [],
    errors: [],
  };

  const fundRows = await db
    .select({
      id: funds.id,
      slug: funds.slug,
      baseCurrency: funds.baseCurrency,
      inceptionDate: funds.inceptionDate,
      startingNav: funds.startingNav,
    })
    .from(funds)
    .where(
      options.fundSlug
        ? and(eq(funds.isActive, true), eq(funds.slug, options.fundSlug))
        : eq(funds.isActive, true)
    );

  for (const fund of fundRows) {
    result.fundsProcessed += 1;

    // Load the immutable ledger once per fund.
    const rawTxns = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.fundId, fund.id));
    const txns: Transaction[] = rawTxns.map((t) => ({
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

    for (const job of [
      { type: "top10" as const, asOf: monthEnd },
      { type: "full" as const, asOf: quarterEnd },
    ]) {
      try {
        const wrote = await reconstructAndUpsert(fund, txns, job.asOf, job.type, result);
        if (wrote) result.snapshotsWritten += 1;
      } catch (err) {
        result.errors.push({
          fund: fund.slug,
          type: job.type,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

async function reconstructAndUpsert(
  fund: { id: string; slug: string; baseCurrency: string; inceptionDate: string; startingNav: string },
  txns: Transaction[],
  asOfMonthEnd: string,
  disclosureType: "top10" | "full",
  result: RunResult
): Promise<boolean> {
  // Effective valuation date = latest NAV-snapshot date on or before the
  // target period-end. Using a date where NAV was successfully computed
  // guarantees prices + FX exist for every held security.
  const navRows = await db
    .select({ date: navSnapshots.date })
    .from(navSnapshots)
    .where(and(eq(navSnapshots.fundId, fund.id), lte(navSnapshots.date, asOfMonthEnd)))
    .orderBy(sql`${navSnapshots.date} DESC`)
    .limit(1);

  const effectiveDate = navRows[0]?.date;
  // Require the effective date to fall within the target period's month, else
  // we'd be labelling stale data with a period-end it doesn't represent.
  if (!effectiveDate || effectiveDate < firstDayOfMonthOf(asOfMonthEnd)) {
    result.skipped.push({
      fund: fund.slug,
      type: disclosureType,
      asOf: asOfMonthEnd,
      reason: "no NAV snapshot within the target period",
    });
    return false;
  }

  const state = buildLedgerState(txns, new Date(`${effectiveDate}T23:59:59Z`));
  // Seed opening capital (startingNav) into cash — it is not booked as a ledger
  // transaction in the current data model, so the replay omits it otherwise.
  const hasLedgerDeposit = txns.some((t) => t.transactionType === "cash_deposit");
  seedOpeningCash(state, fund.baseCurrency as Currency, fund.startingNav, hasLedgerDeposit);
  const securityIds = Array.from(state.positions.keys());

  const priceForCompute = new Map<string, string>();
  const priceCurrencies = new Map<string, Currency>();
  const securityMeta = new Map<string, SecurityMeta>();
  const valuedAtCost = new Set<string>();

  if (securityIds.length > 0) {
    // Best market price on or before the effective date, per held security.
    const marketPrice = new Map<string, { price: string; currency: Currency }>();
    const priceRows = await db
      .select()
      .from(prices)
      .where(lte(prices.date, effectiveDate))
      .orderBy(sql`${prices.date} DESC`);
    for (const row of priceRows) {
      if (!securityIds.includes(row.securityId)) continue;
      if (!marketPrice.has(row.securityId)) {
        marketPrice.set(row.securityId, { price: row.closePrice, currency: row.currency as Currency });
      }
    }

    const secRows = await db
      .select({
        id: securities.id,
        ticker: securities.ticker,
        name: securities.name,
        gicsSector: securities.gicsSector,
      })
      .from(securities);
    for (const s of secRows) {
      if (securityIds.includes(s.id)) {
        securityMeta.set(s.id, { ticker: s.ticker, name: s.name, sector: s.gicsSector ?? null });
      }
    }

    // Resolve a price for every position — market price where available, else
    // the position's cost basis, so a name with no in-period price history is
    // still valued rather than failing the whole snapshot.
    for (const secId of securityIds) {
      const pos = state.positions.get(secId)!;
      const resolved = resolvePositionPrice(marketPrice.get(secId) ?? null, pos);
      priceForCompute.set(secId, resolved.price);
      priceCurrencies.set(secId, resolved.currency);
      if (resolved.valuedAtCost) {
        valuedAtCost.add(secId);
        result.valuedAtCost.push({
          fund: fund.slug,
          type: disclosureType,
          asOf: asOfMonthEnd,
          ticker: securityMeta.get(secId)?.ticker ?? secId,
        });
      }
    }
  }

  // FX rates for the effective date.
  const fxRows = await db.select().from(fxRates).where(eq(fxRates.date, effectiveDate));
  const fxMap = new Map<string, string>();
  for (const row of fxRows) {
    fxMap.set(`${row.fromCurrency}/${row.toCurrency}/${effectiveDate}`, row.rate);
  }

  const { cashWeight, holdings } = buildHoldings({
    components: state,
    prices: priceForCompute,
    priceCurrencies,
    fxRates: fxMap,
    baseCurrency: fund.baseCurrency as Currency,
    date: effectiveDate,
    securityMeta,
    valuedAtCost,
  });

  const payload = packageSnapshot(holdings, cashWeight, disclosureType);

  await db
    .insert(publicHoldingsSnapshots)
    .values({
      fundId: fund.id,
      asOfDate: asOfMonthEnd,
      disclosureType,
      holdings: payload,
      publishedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        publicHoldingsSnapshots.fundId,
        publicHoldingsSnapshots.asOfDate,
        publicHoldingsSnapshots.disclosureType,
      ],
      set: {
        holdings: payload,
        publishedAt: new Date(),
      },
    });

  return true;
}
