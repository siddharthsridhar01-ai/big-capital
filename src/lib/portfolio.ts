/**
 * Portfolio state computation.
 *
 * Single source of truth for "what does this fund hold right now."
 *
 * Reads the immutable transactions ledger and aggregates into:
 *   - Live position quantities per security (signed: + long, − short)
 *   - Live cash balance per currency
 *   - Sector exposures
 *   - Total NAV (cash + sum of position values at latest prices)
 *
 * Called by:
 *   - The check-trade endpoint (to evaluate constraints against real state)
 *   - The submit-trade endpoint (to validate the trade is consistent)
 *   - The fund detail page and security pages (for displaying live numbers)
 *   - Future: holdings table, performance engine
 *
 * Conventions:
 *   - All amounts in major units (pounds not pence)
 *   - All cash sums in base currency, converted via fxRateToBase stored on each txn
 *   - Position quantity is signed: shorts are negative
 */

import Decimal from "decimal.js";
import { eq, and, desc, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import {
  funds as fundsTable,
  transactions as transactionsTable,
  securities as securitiesTable,
  prices as pricesTable,
} from "@/db/schema";

export type Currency = "GBP" | "USD" | "EUR";

export interface LivePosition {
  securityId: string;
  ticker: string;
  name: string;
  exchange: string;
  currency: Currency;
  gicsSector: string | null;
  /** Signed: positive for long, negative for short. */
  quantity: Decimal;
  /** Average cost in security's native currency. Long positions only — undefined for shorts where the concept differs. */
  avgCostNative: Decimal;
  /** Realised P&L from any partial closes (in fund base currency). */
  realisedPnlBase: Decimal;
  /** Latest known close price, native currency. Null if no price available. */
  latestPriceNative: Decimal | null;
  /** FX rate applied to convert latest price to base. Defaults to 1 if same ccy. */
  latestFxToBase: Decimal;
  /** Current mark-to-market value in fund base currency. Null if no price. */
  marketValueBase: Decimal | null;
}

export interface PortfolioState {
  fundId: string;
  fundSlug: string;
  baseCurrency: Currency;
  /** Live cash balance in base currency. */
  cashBase: Decimal;
  /** Live cash by native currency (for funds that may hold multiple ccys, e.g. Global). */
  cashByCurrency: Map<Currency, Decimal>;
  /** All open (non-zero quantity) positions, keyed by securityId. */
  positions: Map<string, LivePosition>;
  /** Sector exposures (sum of abs(marketValueBase) per sector / NAV). */
  sectorExposures: Map<string, Decimal>;
  /** Total NAV: cash + sum of |position values|. */
  navBase: Decimal;
  /** Long exposure as fraction of NAV (positions × current price, longs only). */
  longExposure: Decimal;
  /** Short exposure as fraction of NAV (abs value of shorts). */
  shortExposure: Decimal;
  /** Gross = long + short. Net = long − short. Both as fraction of NAV. */
  grossExposure: Decimal;
  netExposure: Decimal;
}

/**
 * Pure aggregation function. Takes raw transactions + security metadata + prices
 * and produces the portfolio state. Separated from DB I/O so it can be tested
 * directly without mocking the database.
 */
export interface RawTransaction {
  securityId: string | null;
  quantity: string; // signed
  price: string;
  currency: Currency;
  cashImpact: string;
  fxRateToBase: string;
  executedAt: Date;
}

export interface SecurityMeta {
  id: string;
  ticker: string;
  name: string;
  exchange: string;
  currency: Currency;
  gicsSector: string | null;
}

export function aggregatePortfolioFromTransactions(
  baseCurrency: Currency,
  startingNav: string,
  transactions: RawTransaction[],
  securityMetaList: SecurityMeta[],
  latestPriceMap: Map<string, { close: string; date: string }>,
  asOfDate?: Date
): Omit<PortfolioState, "fundId" | "fundSlug"> {
  const txnsInScope = asOfDate
    ? transactions.filter((t) => t.executedAt <= asOfDate)
    : transactions;

  interface PositionAggregate {
    quantity: Decimal;
    avgCostNative: Decimal;
    realisedPnlBase: Decimal;
    currency: Currency;
  }
  const aggregates = new Map<string, PositionAggregate>();
  const cashByCurrency = new Map<Currency, Decimal>();
  cashByCurrency.set(baseCurrency, new Decimal(startingNav));

  for (const t of txnsInScope) {
    const currCash = cashByCurrency.get(t.currency) ?? new Decimal(0);
    cashByCurrency.set(t.currency, currCash.plus(t.cashImpact));

    if (!t.securityId) continue;

    const existing = aggregates.get(t.securityId);
    const txnQty = new Decimal(t.quantity);
    const txnPrice = new Decimal(t.price);
    const fxToBase = new Decimal(t.fxRateToBase);

    if (!existing) {
      aggregates.set(t.securityId, {
        quantity: txnQty,
        avgCostNative: txnPrice,
        realisedPnlBase: new Decimal(0),
        currency: t.currency,
      });
    } else {
      const oldQty = existing.quantity;
      const newQty = oldQty.plus(txnQty);
      const isSameDirection =
        (oldQty.gte(0) && txnQty.gte(0)) || (oldQty.lt(0) && txnQty.lt(0));
      const isFullClose = newQty.isZero();

      if (isSameDirection) {
        const oldNotional = oldQty.abs().times(existing.avgCostNative);
        const newNotional = txnQty.abs().times(txnPrice);
        const totalNotional = oldNotional.plus(newNotional);
        const totalQty = oldQty.abs().plus(txnQty.abs());
        existing.avgCostNative = totalQty.isZero()
          ? new Decimal(0)
          : totalNotional.dividedBy(totalQty);
        existing.quantity = newQty;
      } else {
        const closedQty = Decimal.min(oldQty.abs(), txnQty.abs());
        const wasLong = oldQty.gt(0);
        const pnlPerShareNative = wasLong
          ? txnPrice.minus(existing.avgCostNative)
          : existing.avgCostNative.minus(txnPrice);
        const pnlNative = pnlPerShareNative.times(closedQty);
        const pnlBase = pnlNative.times(fxToBase);
        existing.realisedPnlBase = existing.realisedPnlBase.plus(pnlBase);
        existing.quantity = newQty;
        if (!isFullClose && newQty.gt(0) !== oldQty.gt(0)) {
          existing.avgCostNative = txnPrice;
        }
      }
    }
  }

  for (const [secId, agg] of aggregates) {
    if (agg.quantity.isZero()) aggregates.delete(secId);
  }

  const positions = new Map<string, LivePosition>();
  let totalLongValueBase = new Decimal(0);
  let totalShortValueBase = new Decimal(0);
  const sectorExposuresBase = new Map<string, Decimal>();

  for (const [secId, agg] of aggregates) {
    const meta = securityMetaList.find((s) => s.id === secId);
    if (!meta) continue;
    const priceRow = latestPriceMap.get(secId);
    const latestPriceNative = priceRow ? new Decimal(priceRow.close) : null;

    let fxToBase = new Decimal(1);
    if (meta.currency !== baseCurrency) {
      const lastTxn = txnsInScope
        .filter((t) => t.securityId === secId)
        .pop();
      if (lastTxn) fxToBase = new Decimal(lastTxn.fxRateToBase);
      else fxToBase = staticFxFallback(meta.currency, baseCurrency);
    }

    const marketValueNative = latestPriceNative
      ? agg.quantity.times(latestPriceNative)
      : null;
    const marketValueBase = marketValueNative
      ? marketValueNative.times(fxToBase)
      : null;

    positions.set(secId, {
      securityId: secId,
      ticker: meta.ticker,
      name: meta.name,
      exchange: meta.exchange,
      currency: meta.currency,
      gicsSector: meta.gicsSector,
      quantity: agg.quantity,
      avgCostNative: agg.avgCostNative,
      realisedPnlBase: agg.realisedPnlBase,
      latestPriceNative,
      latestFxToBase: fxToBase,
      marketValueBase,
    });

    if (marketValueBase) {
      if (agg.quantity.gt(0))
        totalLongValueBase = totalLongValueBase.plus(marketValueBase);
      else totalShortValueBase = totalShortValueBase.plus(marketValueBase.abs());

      const sector = meta.gicsSector ?? "Other";
      const curr = sectorExposuresBase.get(sector) ?? new Decimal(0);
      sectorExposuresBase.set(sector, curr.plus(marketValueBase.abs()));
    }
  }

  let cashBase = new Decimal(0);
  for (const [ccy, amt] of cashByCurrency) {
    if (ccy === baseCurrency) cashBase = cashBase.plus(amt);
    else {
      const fx = staticFxFallback(ccy, baseCurrency);
      cashBase = cashBase.plus(amt.times(fx));
    }
  }

  const navBase = cashBase.plus(totalLongValueBase).minus(totalShortValueBase);
  const longExposure = navBase.isZero()
    ? new Decimal(0)
    : totalLongValueBase.dividedBy(navBase);
  const shortExposure = navBase.isZero()
    ? new Decimal(0)
    : totalShortValueBase.dividedBy(navBase);
  const grossExposure = longExposure.plus(shortExposure);
  const netExposure = longExposure.minus(shortExposure);

  const sectorExposures = new Map<string, Decimal>();
  for (const [sector, val] of sectorExposuresBase) {
    sectorExposures.set(
      sector,
      navBase.isZero() ? new Decimal(0) : val.dividedBy(navBase)
    );
  }

  return {
    baseCurrency,
    cashBase,
    cashByCurrency,
    positions,
    sectorExposures,
    navBase,
    longExposure,
    shortExposure,
    grossExposure,
    netExposure,
  };
}

/**
 * Compute a fund's live portfolio state from the transactions ledger.
 *
 * If `asOfDate` is provided, only includes transactions up to (and including)
 * that date — used for historical NAV reconstruction. Default = "now",
 * meaning all transactions.
 */
export async function computePortfolioState(
  fundId: string,
  asOfDate?: Date,
  opts?: { skipLivePrices?: boolean }
): Promise<PortfolioState> {
  // 1) Load fund record
  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.id, fundId))
    .limit(1);
  if (fundRows.length === 0) throw new Error(`Fund ${fundId} not found`);
  const fund = fundRows[0];

  // 2) Load transactions, ordered chronologically
  const txns = await db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.fundId, fundId))
    .orderBy(transactionsTable.executedAt);

  // 3) Load security metadata + latest prices for all securities mentioned
  const allSecIds = Array.from(
    new Set(txns.filter((t) => t.securityId).map((t) => t.securityId as string))
  );
  let securityMetaList: SecurityMeta[] = [];
  let latestPriceMap = new Map<string, { close: string; date: string }>();
  if (allSecIds.length > 0) {
    const rows = await loadSecurityMeta(allSecIds);
    securityMetaList = rows.map((r) => ({
      id: r.id,
      ticker: r.ticker,
      name: r.name,
      exchange: r.exchange,
      currency: r.currency as Currency,
      gicsSector: r.gicsSector,
    }));
    latestPriceMap = await loadLatestPrices(allSecIds);

    // 3b) Override DB prices with live Yahoo quotes where available.
    // Only applies when asOfDate is null (i.e. computing "now") — for
    // historical reconstruction we still want DB prices.
    // Skipped when skipLivePrices is set: callers running inside a DB
    // transaction/lock use this to avoid a network call while holding the lock
    // (the trade is valued at a live price fetched before the lock instead).
    if (!asOfDate && !opts?.skipLivePrices) {
      try {
        const { getQuotes } = await import("./intraday/cache");
        const { activeProvider } = await import("./intraday/provider");
        const { toYahooSymbol } = await import("./intraday/yahoo");
        const live = await getQuotes(
          activeProvider,
          securityMetaList.map((s) => ({
            securityId: s.id,
            symbol: toYahooSymbol(s.ticker, s.exchange),
          }))
        );
        const today = new Date().toISOString().slice(0, 10);
        for (const r of live) {
          if (r.quote?.price != null) {
            latestPriceMap.set(r.securityId, {
              close: String(r.quote.price),
              date: today,
            });
          }
        }
      } catch (err) {
        // Live overlay failed — fall back to DB prices silently.
        // (Logged but not surfaced; DB prices are still correct historical data.)
        console.error("[portfolio] live price overlay failed:", err);
      }
    }
  }

  // 4) Run pure aggregation
  const result = aggregatePortfolioFromTransactions(
    fund.baseCurrency as Currency,
    fund.startingNav,
    txns.map((t) => ({
      securityId: t.securityId,
      quantity: t.quantity,
      price: t.price,
      currency: t.currency as Currency,
      cashImpact: t.cashImpact,
      fxRateToBase: t.fxRateToBase,
      executedAt: t.executedAt,
    })),
    securityMetaList,
    latestPriceMap,
    asOfDate
  );

  return {
    fundId: fund.id,
    fundSlug: fund.slug,
    ...result,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadSecurityMeta(securityIds: string[]) {
  if (securityIds.length === 0) return [];
  // Drizzle's inArray is the safe pattern here
  const { inArray } = await import("drizzle-orm");
  return db
    .select({
      id: securitiesTable.id,
      ticker: securitiesTable.ticker,
      name: securitiesTable.name,
      exchange: securitiesTable.exchange,
      currency: securitiesTable.currency,
      gicsSector: securitiesTable.gicsSector,
    })
    .from(securitiesTable)
    .where(inArray(securitiesTable.id, securityIds));
}

async function loadLatestPrices(
  securityIds: string[]
): Promise<Map<string, { close: string; date: string }>> {
  if (securityIds.length === 0) return new Map();
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select({
      securityId: pricesTable.securityId,
      closePrice: pricesTable.closePrice,
      date: pricesTable.date,
    })
    .from(pricesTable)
    .where(inArray(pricesTable.securityId, securityIds))
    .orderBy(desc(pricesTable.date));
  const map = new Map<string, { close: string; date: string }>();
  for (const r of rows) {
    if (!map.has(r.securityId)) {
      map.set(r.securityId, { close: r.closePrice, date: r.date });
    }
  }
  return map;
}

/**
 * Load the second-most-recent close price per security (the "previous close")
 * for daily-change comparison. Returns null per security when no previous row
 * exists (single-row history).
 */
export async function loadPreviousClosePrices(
  securityIds: string[]
): Promise<Map<string, { close: string; date: string } | null>> {
  if (securityIds.length === 0) return new Map();
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select({
      securityId: pricesTable.securityId,
      closePrice: pricesTable.closePrice,
      date: pricesTable.date,
    })
    .from(pricesTable)
    .where(inArray(pricesTable.securityId, securityIds))
    .orderBy(desc(pricesTable.date));
  // Group by security, take 2nd element of each group
  const grouped = new Map<string, { close: string; date: string }[]>();
  for (const r of rows) {
    const list = grouped.get(r.securityId) ?? [];
    list.push({ close: r.closePrice, date: r.date });
    grouped.set(r.securityId, list);
  }
  const result = new Map<string, { close: string; date: string } | null>();
  for (const [id, list] of grouped) {
    result.set(id, list.length >= 2 ? list[1] : null);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Static FX fallback rates (Option B for v1; replaced by ECB ingestion later)
// ---------------------------------------------------------------------------

/**
 * Static FX fallback rates for v1. Marked as FALLBACK in any submission's
 * audit trail. Mid-2026 approximate values. Will be replaced by live ECB
 * rates when Phase 4 wires the FX ingestion job.
 *
 * Returns the rate to convert `from` -> `to` (multiply native amount).
 */
export const FALLBACK_FX_SOURCE = "FALLBACK_FX_RATE_v1";

const FALLBACK_RATES: Record<string, number> = {
  "GBP/USD": 1.27,
  "USD/GBP": 1 / 1.27,
  "EUR/USD": 1.09,
  "USD/EUR": 1 / 1.09,
  "GBP/EUR": 1.165,
  "EUR/GBP": 1 / 1.165,
  // Self-conversions
  "GBP/GBP": 1,
  "USD/USD": 1,
  "EUR/EUR": 1,
};

export function staticFxFallback(from: Currency, to: Currency): Decimal {
  const key = `${from}/${to}`;
  const rate = FALLBACK_RATES[key];
  if (rate === undefined) {
    throw new Error(`No fallback FX rate for ${from}/${to}`);
  }
  return new Decimal(rate);
}
