/**
 * Pure helpers for derived price/P&L numbers shown around the dashboard.
 *
 * Kept separate from portfolio.ts so the math is testable in isolation and
 * any component can reach for them without pulling in the heavy DB layer.
 */

import Decimal from "decimal.js";

export type Direction = "up" | "down" | "flat";

export interface DailyChange {
  absoluteNative: Decimal; // signed: positive for up, negative for down
  percentage: Decimal; // signed, e.g. 0.0081 for +0.81%
  direction: Direction;
}

/**
 * Compute today-vs-yesterday change for a security.
 * Returns null when there's no previous close to compare against.
 */
export function computeDailyChange(
  todayClose: Decimal | string | number,
  previousClose: Decimal | string | number | null | undefined
): DailyChange | null {
  if (previousClose == null) return null;
  const today = new Decimal(todayClose);
  const prev = new Decimal(previousClose);
  if (prev.isZero()) return null;
  const absoluteNative = today.minus(prev);
  const percentage = absoluteNative.dividedBy(prev);
  const direction: Direction = absoluteNative.isZero()
    ? "flat"
    : absoluteNative.isPositive()
      ? "up"
      : "down";
  return { absoluteNative, percentage, direction };
}

export interface UnrealisedPnL {
  /** P&L in base currency, signed. */
  amountBase: Decimal;
  /** Return % vs cost basis, signed (e.g. 0.254 for +25.4%). */
  returnPct: Decimal;
  direction: Direction;
}

/**
 * Unrealised P&L for a single position.
 *   Long:  (currentPrice − avgCost) × |quantity| × fxToBase
 *   Short: (avgCost − currentPrice) × |quantity| × fxToBase
 *
 * Returns null when there's no current price (so we can show "—" in the UI).
 */
export function computeUnrealisedPnL(
  quantity: Decimal | string | number,
  avgCostNative: Decimal | string | number,
  currentPriceNative: Decimal | string | number | null | undefined,
  fxToBase: Decimal | string | number = 1
): UnrealisedPnL | null {
  if (currentPriceNative == null) return null;
  const qty = new Decimal(quantity);
  const cost = new Decimal(avgCostNative);
  const px = new Decimal(currentPriceNative);
  const fx = new Decimal(fxToBase);

  const isLong = qty.gt(0);
  const pnlPerShareNative = isLong ? px.minus(cost) : cost.minus(px);
  const amountBase = pnlPerShareNative.times(qty.abs()).times(fx);

  // Return % is computed against the cost basis (per-share basis × |qty|)
  const costBasisNative = cost.times(qty.abs());
  const returnPct = costBasisNative.isZero()
    ? new Decimal(0)
    : pnlPerShareNative.dividedBy(cost);

  const direction: Direction = amountBase.isZero()
    ? "flat"
    : amountBase.isPositive()
      ? "up"
      : "down";

  return { amountBase, returnPct, direction };
}
