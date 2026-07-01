/**
 * Lagged public-holdings reconstruction.
 *
 * Pure, testable core for the public holdings-disclosure feature. The DB
 * orchestration lives in src/workers/reconstruct-holdings.ts; everything here
 * is side-effect-free so it can be unit-tested.
 *
 * Disclosure policy (see runbook / fund page footnote):
 *   - Top-10 holdings, refreshed monthly, showing the most recent COMPLETED
 *     month-end that is at least HOLDINGS_LAG_DAYS old.
 *   - Full holdings, refreshed quarterly, showing the most recent COMPLETED
 *     quarter-end that is at least HOLDINGS_LAG_DAYS old.
 *
 * The lag is the protection: the public never sees the live book, only a
 * period-end snapshot reconstructed from the immutable transaction ledger.
 */

import Decimal from "decimal.js";
import {
  computeNav,
  convertCurrency,
  type Currency,
  type NavComponents,
} from "./performance";

/** Minimum age (days) before a period-end becomes publishable. */
export const HOLDINGS_LAG_DAYS = 14;

export interface SecurityMeta {
  ticker: string;
  name: string;
  sector: string | null;
}

export interface HoldingRow {
  securityId: string;
  ticker: string;
  name: string;
  weight: number; // signed fraction of NAV (negative = short)
  sector: string | null;
  valuedAtCost?: boolean; // true when no market price existed and cost basis was used
}

/**
 * Stored jsonb shape for a public_holdings_snapshots row.
 *
 * For top-10 snapshots, `holdings` contains ONLY the disclosed rows; the
 * undisclosed remainder is summarised by otherCount / otherWeight so the
 * public page can show "Other holdings (N) — X%" and cash WITHOUT revealing
 * the individual undisclosed positions.
 */
export interface HoldingsSnapshotPayload {
  holdings: HoldingRow[];
  cashWeight: number; // fraction of NAV held in cash
  otherCount: number; // number of holdings not individually disclosed
  otherWeight: number; // their combined weight
  totalHoldings: number; // total number of positions in the book
}

// ---------------------------------------------------------------------------
// Date / lag helpers (all UTC, all returning/consuming YYYY-MM-DD strings)
// ---------------------------------------------------------------------------

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonthUTC(year: number, monthIndex0: number): Date {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0));
}

/** First day of the month that `dateYmd` falls in, e.g. "2026-05-31" -> "2026-05-01". */
export function firstDayOfMonthOf(dateYmd: string): string {
  return `${dateYmd.slice(0, 7)}-01`;
}

/** Most recent completed month-end at least `lagDays` before `today`. */
export function mostRecentEligibleMonthEnd(
  today: Date,
  lagDays: number = HOLDINGS_LAG_DAYS
): string {
  const cutoff = new Date(today.getTime() - lagDays * 86_400_000);
  const cutoffYmd = ymd(cutoff);
  let y = cutoff.getUTCFullYear();
  let m = cutoff.getUTCMonth();
  let monthEnd = lastDayOfMonthUTC(y, m);
  if (ymd(monthEnd) > cutoffYmd) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
    monthEnd = lastDayOfMonthUTC(y, m);
  }
  return ymd(monthEnd);
}

/** Most recent completed quarter-end at least `lagDays` before `today`. */
export function mostRecentEligibleQuarterEnd(
  today: Date,
  lagDays: number = HOLDINGS_LAG_DAYS
): string {
  const cutoff = new Date(today.getTime() - lagDays * 86_400_000);
  const cutoffYmd = ymd(cutoff);
  const quarterEndMonths = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec (0-indexed)
  const y = cutoff.getUTCFullYear();
  const candidates: string[] = [];
  for (const yr of [y, y - 1]) {
    for (const qm of quarterEndMonths) {
      candidates.push(ymd(lastDayOfMonthUTC(yr, qm)));
    }
  }
  const eligible = candidates
    .filter((d) => d <= cutoffYmd)
    .sort((a, b) => (a < b ? 1 : -1)); // descending
  return eligible[0];
}

// ---------------------------------------------------------------------------
// Holdings + weights from a reconstructed ledger state
// ---------------------------------------------------------------------------

function round6(d: Decimal): number {
  return Number(d.toFixed(6));
}

/**
 * Given a reconstructed portfolio state at a date, plus the prices/FX needed
 * to value it, return NAV, the cash weight, and every holding with its signed
 * weight (fraction of NAV). Holdings are sorted by weight descending (largest
 * longs first, shorts last).
 */
export function buildHoldings(args: {
  components: NavComponents;
  prices: Map<string, string>;
  priceCurrencies: Map<string, Currency>;
  fxRates: Map<string, string>;
  baseCurrency: Currency;
  date: string;
  securityMeta: Map<string, SecurityMeta>;
  valuedAtCost?: Set<string>; // securityIds valued at cost basis (no market price)
}): { nav: Decimal; cashWeight: number; holdings: HoldingRow[] } {
  const { components, prices, priceCurrencies, fxRates, baseCurrency, date, securityMeta, valuedAtCost } = args;

  const navSnap = computeNav({
    fundId: "",
    date,
    baseCurrency,
    components,
    prices,
    priceCurrencies,
    fxRates,
    previousNav: null,
  });
  const nav = navSnap.nav;

  const holdings: HoldingRow[] = [];
  if (!nav.isZero()) {
    for (const [securityId, pos] of components.positions) {
      const priceStr = prices.get(securityId);
      const ccy = priceCurrencies.get(securityId);
      if (!priceStr || !ccy) continue;
      const valueNative = pos.quantity.times(priceStr);
      const valueBase = convertCurrency(valueNative, ccy, baseCurrency, date, fxRates);
      const meta = securityMeta.get(securityId);
      holdings.push({
        securityId,
        ticker: meta?.ticker ?? "—",
        name: meta?.name ?? "Unknown",
        weight: round6(valueBase.dividedBy(nav)),
        sector: meta?.sector ?? null,
        ...(valuedAtCost?.has(securityId) ? { valuedAtCost: true } : {}),
      });
    }
  }
  holdings.sort((a, b) => b.weight - a.weight);

  const cashWeight = nav.isZero() ? 0 : round6(navSnap.cashBalance.dividedBy(nav));
  return { nav, cashWeight, holdings };
}

/**
 * Resolve the price to value a position at, given the best available market
 * price on-or-before the valuation date (or null when none exists).
 *
 * Falls back to the position's cost basis (avgCostNative) so a held security
 * with no in-period price history is still valued rather than crashing the
 * whole snapshot. The `valuedAtCost` flag lets callers disclose the fallback.
 */
export function resolvePositionPrice(
  marketPrice: { price: string; currency: Currency } | null,
  position: { avgCostNative: Decimal; currency: Currency }
): { price: string; currency: Currency; valuedAtCost: boolean } {
  if (marketPrice) {
    return { price: marketPrice.price, currency: marketPrice.currency, valuedAtCost: false };
  }
  return {
    price: position.avgCostNative.toString(),
    currency: position.currency,
    valuedAtCost: true,
  };
}

/**
 * Seed a fund's opening capital into the reconstructed cash balance.
 *
 * A fund's initial capital is held in `funds.startingNav` (base currency) and,
 * in the current data model, is NOT booked as a ledger transaction — so
 * buildLedgerState only accumulates subsequent trade/deposit cash impacts.
 * Without this, cash (and therefore NAV) is understated by the opening balance.
 *
 * Guarded: if the ledger already contains an explicit cash_deposit (i.e. the
 * opening capital IS modelled as a transaction), we trust the ledger and skip
 * seeding to avoid double-counting.
 */
export function seedOpeningCash(
  components: NavComponents,
  baseCurrency: Currency,
  startingNav: string,
  hasLedgerDeposit: boolean
): void {
  if (hasLedgerDeposit) return;
  const current = components.cashByCurrency.get(baseCurrency) ?? new Decimal(0);
  components.cashByCurrency.set(baseCurrency, current.plus(startingNav));
}

/**
 * Select the rows to disclose for a top-10 snapshot.
 *
 * Long-only books: the 10 largest by weight.
 * Books with shorts (the Long/Short fund): the 5 largest longs and the 5
 * largest shorts by absolute weight.
 */
export function selectTop10(holdings: HoldingRow[]): HoldingRow[] {
  const hasShorts = holdings.some((h) => h.weight < 0);
  if (!hasShorts) return holdings.slice(0, 10);
  const longs = holdings.filter((h) => h.weight > 0).slice(0, 5);
  const shorts = holdings
    .filter((h) => h.weight < 0)
    .sort((a, b) => a.weight - b.weight) // most negative first
    .slice(0, 5);
  return [...longs, ...shorts];
}

/** Package the full holdings list into the stored payload for a disclosure type. */
export function packageSnapshot(
  allHoldings: HoldingRow[],
  cashWeight: number,
  disclosureType: "top10" | "full"
): HoldingsSnapshotPayload {
  const sumWeights = (rows: HoldingRow[]) =>
    Number(rows.reduce((acc, h) => acc.plus(h.weight), new Decimal(0)).toFixed(6));

  if (disclosureType === "full") {
    return {
      holdings: allHoldings,
      cashWeight,
      otherCount: 0,
      otherWeight: 0,
      totalHoldings: allHoldings.length,
    };
  }

  const shown = selectTop10(allHoldings);
  const shownIds = new Set(shown.map((h) => h.securityId));
  const other = allHoldings.filter((h) => !shownIds.has(h.securityId));
  return {
    holdings: shown,
    cashWeight,
    otherCount: other.length,
    otherWeight: sumWeights(other),
    totalHoldings: allHoldings.length,
  };
}
