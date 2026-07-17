/**
 * BIG Capital — Performance Calculation Engine
 *
 * Implements the methodology defined in docs/phase-0-spec.md §5.
 *
 * KEY PRINCIPLES:
 *   1. Source of truth = transactions table. Positions, cash, NAV are derived.
 *   2. NAV is computed in the fund's base currency.
 *   3. Returns use Time-Weighted Return (TWR) — daily linking method.
 *   4. All numeric work uses string-based decimal to avoid floating-point drift,
 *      then converts to number only at the API boundary.
 *
 * This file is heavily tested. See tests/performance.test.ts for the test suite
 * including the CFA Institute reference TWR example.
 */

import Decimal from "decimal.js";

// Configure decimal.js for financial precision
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Currency = "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD";

export interface Transaction {
  id: string;
  fundId: string;
  securityId: string | null;
  transactionType:
    | "buy"
    | "sell"
    | "short"
    | "cover"
    | "dividend"
    | "cash_deposit"
    | "fx_adjustment"
    | "corporate_action";
  quantity: string; // decimal string
  price: string;
  currency: Currency;
  cashImpact: string; // signed cash impact in security's native ccy
  fxRateToBase: string; // FX to fund's base ccy at execution
  executedAt: Date;
}

export interface PriceQuote {
  securityId: string;
  date: string; // YYYY-MM-DD
  closePrice: string;
  currency: Currency;
}

export interface FxRate {
  fromCurrency: Currency;
  toCurrency: Currency;
  date: string;
  rate: string;
}

export interface Position {
  securityId: string;
  quantity: Decimal; // signed: positive = long, negative = short
  avgCostNative: Decimal; // weighted-average cost basis in security's currency
  currency: Currency;
}

export interface NavComponents {
  cashByCurrency: Map<Currency, Decimal>; // cash held in each currency
  positions: Map<string, Position>; // by securityId
}

export interface NavSnapshot {
  fundId: string;
  date: string;
  nav: Decimal; // in fund base ccy
  cashBalance: Decimal; // in fund base ccy
  positionValue: Decimal; // in fund base ccy
  grossExposure: Decimal; // |long| + |short| as fraction of NAV
  netExposure: Decimal; // (long - short) / NAV
  dailyReturn: Decimal | null;
}

// ---------------------------------------------------------------------------
// Building the ledger state from transactions
// ---------------------------------------------------------------------------

/**
 * Replay all transactions up to (and including) a given date to produce
 * the portfolio state: cash balances per currency, and positions.
 *
 * This is deliberately a pure function of the transaction history — no
 * intermediate stored state is consulted. This is what makes the ledger
 * auditable and reproducible at any historical date.
 */
export function buildLedgerState(
  transactions: Transaction[],
  asOf: Date
): NavComponents {
  const cashByCurrency = new Map<Currency, Decimal>();
  const positions = new Map<string, Position>();

  // Filter and sort transactions
  const relevant = transactions
    .filter((t) => t.executedAt <= asOf)
    .sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());

  for (const t of relevant) {
    // Cash impact always affects the cash balance in the transaction's currency
    const currentCash = cashByCurrency.get(t.currency) ?? new Decimal(0);
    cashByCurrency.set(t.currency, currentCash.plus(t.cashImpact));

    // Position changes only for security transactions
    if (t.securityId === null) continue;

    const qty = new Decimal(t.quantity);
    const price = new Decimal(t.price);

    if (qty.isZero()) continue;

    const existing = positions.get(t.securityId);

    if (
      t.transactionType === "buy" ||
      t.transactionType === "short" ||
      t.transactionType === "cover" ||
      t.transactionType === "sell" ||
      t.transactionType === "corporate_action"
    ) {
      if (!existing) {
        // Opening a position
        positions.set(t.securityId, {
          securityId: t.securityId,
          quantity: qty,
          avgCostNative: price,
          currency: t.currency,
        });
      } else {
        const newQty = existing.quantity.plus(qty);

        // Same-direction add: weighted-average cost
        // Reducing: keep avg cost on remaining (realised P&L computed separately)
        // Crossing zero: treat as close + open
        const sameDirection =
          (existing.quantity.greaterThan(0) && qty.greaterThan(0)) ||
          (existing.quantity.lessThan(0) && qty.lessThan(0));

        if (newQty.isZero()) {
          positions.delete(t.securityId);
        } else if (sameDirection) {
          // Weighted average
          const totalCost = existing.avgCostNative
            .times(existing.quantity.abs())
            .plus(price.times(qty.abs()));
          const newAvgCost = totalCost.dividedBy(newQty.abs());
          positions.set(t.securityId, {
            ...existing,
            quantity: newQty,
            avgCostNative: newAvgCost,
          });
        } else {
          // Reducing or crossing
          const sameSign =
            (newQty.greaterThan(0) && existing.quantity.greaterThan(0)) ||
            (newQty.lessThan(0) && existing.quantity.lessThan(0));

          if (sameSign) {
            // Reducing — avg cost unchanged on remaining
            positions.set(t.securityId, {
              ...existing,
              quantity: newQty,
            });
          } else {
            // Crossed zero — new position at this trade's price
            positions.set(t.securityId, {
              ...existing,
              quantity: newQty,
              avgCostNative: price,
            });
          }
        }
      }
    }
    // Dividends and cash_deposits don't affect positions, only cash (handled above)
  }

  return { cashByCurrency, positions };
}

// ---------------------------------------------------------------------------
// FX conversion
// ---------------------------------------------------------------------------

/**
 * Convert an amount from one currency to another using a given FX rate map.
 * Throws if the rate is not available — calling code must handle missing rates.
 */
export function convertCurrency(
  amount: Decimal,
  from: Currency,
  to: Currency,
  date: string,
  fxRates: Map<string, string>
): Decimal {
  if (from === to) return amount;

  const directKey = `${from}/${to}/${date}`;
  const directRate = fxRates.get(directKey);
  if (directRate) {
    return amount.times(directRate);
  }

  // Try inverse
  const inverseKey = `${to}/${from}/${date}`;
  const inverseRate = fxRates.get(inverseKey);
  if (inverseRate) {
    return amount.dividedBy(inverseRate);
  }

  throw new Error(`No FX rate available for ${from}->${to} on ${date}`);
}

// ---------------------------------------------------------------------------
// NAV computation
// ---------------------------------------------------------------------------

export interface ComputeNavInput {
  fundId: string;
  date: string;
  baseCurrency: Currency;
  components: NavComponents;
  prices: Map<string, string>; // securityId -> close price (native ccy)
  priceCurrencies: Map<string, Currency>; // securityId -> currency
  fxRates: Map<string, string>; // key: "FROM/TO/DATE"
  previousNav: Decimal | null; // for dailyReturn computation
}

/**
 * Compute end-of-day NAV for a fund.
 *
 * NAV = Σ(cash in each ccy → base) + Σ(position_qty × price × FX_to_base)
 *
 * Daily TWR contribution = (NAV_t - NAV_{t-1}) / NAV_{t-1}
 * Note: in a real-money fund with external flows, this becomes
 *   (NAV_t - NAV_{t-1} - flow_t) / (NAV_{t-1} + flow_t)
 * We support that signature even though paper funds typically have no flows.
 */
export function computeNav(input: ComputeNavInput, externalFlowBase: Decimal = new Decimal(0)): NavSnapshot {
  const { fundId, date, baseCurrency, components, prices, priceCurrencies, fxRates, previousNav } = input;

  // 1. Cash in base ccy
  let cashBase = new Decimal(0);
  for (const [ccy, amt] of components.cashByCurrency) {
    cashBase = cashBase.plus(convertCurrency(amt, ccy, baseCurrency, date, fxRates));
  }

  // 2. Positions in base ccy
  let longBase = new Decimal(0);
  let shortBase = new Decimal(0); // tracked as positive number; subtracted from NAV

  for (const [securityId, position] of components.positions) {
    const priceStr = prices.get(securityId);
    if (!priceStr) {
      throw new Error(`Missing price for security ${securityId} on ${date}`);
    }
    const priceCcy = priceCurrencies.get(securityId);
    if (!priceCcy) {
      throw new Error(`Missing currency for security ${securityId}`);
    }

    const valueNative = position.quantity.times(priceStr);
    const valueBase = convertCurrency(valueNative, priceCcy, baseCurrency, date, fxRates);

    if (valueBase.greaterThanOrEqualTo(0)) {
      longBase = longBase.plus(valueBase);
    } else {
      // Short position: valueBase is negative, NAV impact is the negative value
      // (we owe the absolute amount), so it reduces NAV
      shortBase = shortBase.plus(valueBase.abs());
    }
  }

  const positionValueBase = longBase.minus(shortBase);
  const nav = cashBase.plus(positionValueBase);

  // Gross exposure = (|long| + |short|) / NAV
  // Net exposure = (long - short) / NAV
  const grossExposure = nav.isZero()
    ? new Decimal(0)
    : longBase.plus(shortBase).dividedBy(nav);
  const netExposure = nav.isZero()
    ? new Decimal(0)
    : longBase.minus(shortBase).dividedBy(nav);

  // Daily return with cash-flow adjustment (Modified Dietz simplification for daily)
  let dailyReturn: Decimal | null = null;
  if (previousNav !== null && !previousNav.isZero()) {
    const denominator = previousNav.plus(externalFlowBase);
    if (!denominator.isZero()) {
      dailyReturn = nav.minus(previousNav).minus(externalFlowBase).dividedBy(denominator);
    }
  }

  return {
    fundId,
    date,
    nav,
    cashBalance: cashBase,
    positionValue: positionValueBase,
    grossExposure,
    netExposure,
    dailyReturn,
  };
}

// ---------------------------------------------------------------------------
// Time-Weighted Return — period chaining
// ---------------------------------------------------------------------------

/**
 * Compute TWR over an arbitrary period from a series of daily returns.
 *
 * TWR = Π(1 + r_t) - 1
 *
 * This is the industry-standard performance measure. It is unaffected by
 * the size and timing of external cash flows, which is what makes it the
 * right measure for comparing portfolio manager skill.
 *
 * Note: for periods >= 1 year, callers typically also report an annualised
 * return. See `annualiseReturn` below.
 */
export function timeWeightedReturn(dailyReturns: (Decimal | null)[]): Decimal {
  let product = new Decimal(1);
  for (const r of dailyReturns) {
    if (r === null) continue;
    product = product.times(new Decimal(1).plus(r));
  }
  return product.minus(1);
}

/**
 * Annualise a cumulative return over N days.
 *   (1 + total_return)^(252/N) - 1   for trading-day annualisation
 *   (1 + total_return)^(365/N) - 1   for calendar-day annualisation
 *
 * We use calendar days for periods >= 1 year (since-inception, 3Y, 5Y) and
 * skip annualisation for shorter periods (industry convention — don't
 * extrapolate short-period performance).
 */
export function annualiseReturn(
  cumulativeReturn: Decimal,
  calendarDays: number
): Decimal {
  if (calendarDays < 365) {
    throw new Error("Do not annualise returns for periods under 1 year");
  }
  const onePlusR = new Decimal(1).plus(cumulativeReturn);
  // (1+r)^(365/N) - 1
  const exponent = new Decimal(365).dividedBy(calendarDays);
  const ln = Decimal.ln(onePlusR);
  const annual = Decimal.exp(ln.times(exponent));
  return annual.minus(1);
}

// ---------------------------------------------------------------------------
// Risk metrics
// ---------------------------------------------------------------------------

/**
 * Annualised volatility from daily returns.
 *   σ_annual = σ_daily × √252
 */
export function annualisedVolatility(dailyReturns: (Decimal | null)[]): Decimal {
  const clean = dailyReturns.filter((r): r is Decimal => r !== null);
  if (clean.length < 2) return new Decimal(0);

  // Sample mean
  let sum = new Decimal(0);
  for (const r of clean) sum = sum.plus(r);
  const mean = sum.dividedBy(clean.length);

  // Sample variance (n-1 denominator)
  let sumSqDev = new Decimal(0);
  for (const r of clean) {
    const dev = r.minus(mean);
    sumSqDev = sumSqDev.plus(dev.times(dev));
  }
  const variance = sumSqDev.dividedBy(clean.length - 1);
  const sigmaDaily = variance.sqrt();

  // Annualise (252 trading days)
  return sigmaDaily.times(new Decimal(252).sqrt());
}

/**
 * Sharpe ratio = (annualised_return - rf) / annualised_volatility
 *
 * @param annualisedReturn  the portfolio's annualised TWR
 * @param annualisedRf      the risk-free rate, annualised
 * @param annualisedVol     the portfolio's annualised volatility
 */
export function sharpeRatio(
  annualisedReturn: Decimal,
  annualisedRf: Decimal,
  annualisedVol: Decimal
): Decimal {
  if (annualisedVol.isZero()) return new Decimal(0);
  return annualisedReturn.minus(annualisedRf).dividedBy(annualisedVol);
}

/**
 * Maximum drawdown from a sequence of NAVs.
 * Returns a positive number representing the worst peak-to-trough decline.
 *   max(1 - NAV_t / peak_t) over all t
 */
export function maxDrawdown(navSeries: Decimal[]): Decimal {
  if (navSeries.length === 0) return new Decimal(0);
  let peak = navSeries[0];
  let maxDd = new Decimal(0);
  for (const nav of navSeries) {
    if (nav.greaterThan(peak)) peak = nav;
    if (peak.isZero()) continue;
    const dd = new Decimal(1).minus(nav.dividedBy(peak));
    if (dd.greaterThan(maxDd)) maxDd = dd;
  }
  return maxDd;
}

/**
 * Beta of portfolio vs benchmark from aligned daily return series.
 *   β = Cov(r_p, r_b) / Var(r_b)
 */
export function beta(
  portfolioReturns: Decimal[],
  benchmarkReturns: Decimal[]
): Decimal {
  if (portfolioReturns.length !== benchmarkReturns.length) {
    throw new Error("Return series must be the same length for beta");
  }
  if (portfolioReturns.length < 2) return new Decimal(0);

  const n = portfolioReturns.length;
  let sumP = new Decimal(0);
  let sumB = new Decimal(0);
  for (let i = 0; i < n; i++) {
    sumP = sumP.plus(portfolioReturns[i]);
    sumB = sumB.plus(benchmarkReturns[i]);
  }
  const meanP = sumP.dividedBy(n);
  const meanB = sumB.dividedBy(n);

  let cov = new Decimal(0);
  let varB = new Decimal(0);
  for (let i = 0; i < n; i++) {
    const devP = portfolioReturns[i].minus(meanP);
    const devB = benchmarkReturns[i].minus(meanB);
    cov = cov.plus(devP.times(devB));
    varB = varB.plus(devB.times(devB));
  }
  cov = cov.dividedBy(n - 1);
  varB = varB.dividedBy(n - 1);

  if (varB.isZero()) return new Decimal(0);
  return cov.dividedBy(varB);
}
