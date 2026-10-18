/**
 * Corporate action accounting — pure functions, no database.
 *
 * A corporate action is a RESTATEMENT, not a trade. A split changes how many
 * shares represent the same holding; it does not buy or sell anything, so it
 * must preserve the position's total cost basis and book no realised P&L.
 *
 * This matters because both position reconstructions in the system would
 * otherwise treat a corporate_action row as a trade:
 *
 *   - performance.ts keeps the old per-share cost on a REDUCTION, so a 1-for-10
 *     reverse split would leave a tenth of the shares at the old cost — every
 *     P&L figure wrong by a factor of ten.
 *   - portfolio.ts (the live dashboard) would treat the reduction as a SALE at a
 *     price of zero, booking a fake realised loss equal to the cost basis of the
 *     shares removed.
 *
 * Restating with cost basis preserved is correct for forward and reverse splits
 * alike, for long and short positions.
 */
import Decimal from "decimal.js";

export interface Restated {
  quantity: Decimal;
  avgCostNative: Decimal;
}

/**
 * Apply a share-count change while preserving total cost basis.
 * Returns null when the position is restated to zero.
 */
export function restatePosition(
  quantity: Decimal,
  avgCostNative: Decimal,
  delta: Decimal
): Restated | null {
  const newQty = quantity.plus(delta);
  if (newQty.isZero()) return null;
  const totalCost = avgCostNative.times(quantity.abs());
  return { quantity: newQty, avgCostNative: totalCost.dividedBy(newQty.abs()) };
}

export interface SplitPlan {
  /** New shares per old share, e.g. 10 for a 10-for-1, 0.1 for a 1-for-10. */
  ratio: Decimal;
  /** Exact post-split holding, which may be fractional. */
  exactShares: Decimal;
  /** Whole shares actually held after fractions are cashed out. */
  wholeShares: Decimal;
  /** Fractional entitlement settled as cash in lieu (signed like the position). */
  fractional: Decimal;
  /** Share change for the restatement entry: exactShares - held. */
  restateDelta: Decimal;
}

/**
 * Plan a split of `held` shares at `numerator`-for-`denominator`.
 *
 * Mirrors what a broker does: every share becomes `ratio` shares, and any
 * fraction left over is not held but paid out as cash in lieu at a reference
 * price. A 3-for-2 split of 25 shares gives 37.5; the holder keeps 37 and is
 * paid for the half. Truncation is toward zero, so shorts behave identically.
 */
export function planSplit(held: Decimal, numerator: number, denominator: number): SplitPlan {
  if (!(numerator > 0) || !(denominator > 0)) {
    throw new Error(`Invalid split ratio ${numerator}:${denominator}`);
  }
  const ratio = new Decimal(numerator).dividedBy(denominator);
  const exactShares = held.times(ratio);
  const wholeShares = exactShares.truncated();
  const fractional = exactShares.minus(wholeShares);
  return {
    ratio,
    exactShares,
    wholeShares,
    fractional,
    restateDelta: exactShares.minus(held),
  };
}

/**
 * The cash-in-lieu settlement for a fractional entitlement.
 *
 * Removes the fraction from the position and pays (or, for a short, charges)
 * its value at the reference price. Booked as an ordinary disposal so realised
 * P&L on the fraction is computed against the restated cost basis.
 */
export function cashInLieu(fractional: Decimal, referencePrice: Decimal) {
  return {
    quantity: fractional.negated(),
    cashImpact: fractional.times(referencePrice),
    transactionType: (fractional.greaterThan(0) ? "sell" : "cover") as "sell" | "cover",
  };
}

/** Human-readable ratio for ledger narratives: "10-for-1", "1-for-10", "3-for-2". */
export function describeSplit(numerator: number, denominator: number): string {
  return `${numerator}-for-${denominator}`;
}

/** Stable key so a split is never booked twice for the same fund and ex-date. */
export function splitDedupeKey(fundId: string, securityId: string, exDate: string): string {
  return `${fundId}|${securityId}|${exDate}|split`;
}

// ---------------------------------------------------------------------------
// Detection — the events that cannot be safely automated
// ---------------------------------------------------------------------------
//
// Takeovers, mergers, spin-offs and rights issues are not processed
// automatically, and deliberately so: their terms involve elections, proration
// and cash-in-lieu that no free data feed carries reliably, which is why fund
// administrators route them to a corporate actions team rather than automating
// them. What CAN be automated is noticing them.
//
// They share two signatures, both visible in prices alone:
//   - A large one-day move with no booked corporate action. Large caps
//     essentially never move 25% in a day without a split, spin-off, rights
//     issue, takeover bid or bad data.
//   - A holding that stops being priced. A completed takeover delists the
//     target; the system would otherwise carry its last price forward
//     indefinitely, with the cash never credited and the position never closed.

/** One-day move, in either direction, treated as a likely corporate action. */
export const LARGE_MOVE_THRESHOLD = 0.25;

/**
 * Calendar days without a price before a holding is flagged. Seven covers the
 * longest exchange holiday runs (Easter, Christmas) without false alarms.
 */
export const STALE_PRICE_DAYS = 7;

export interface HeldPriceObservation {
  fund: string;
  securityId: string;
  ticker: string;
  latestDate: string | null;
  latestClose: Decimal | null;
  previousClose: Decimal | null;
}

export type CorporateActionAlert =
  | { kind: "large_move"; fund: string; ticker: string; date: string; move: number; message: string }
  | { kind: "stale_price"; fund: string; ticker: string; lastPriced: string | null; days: number; message: string };

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);
}

/**
 * Flag held securities whose prices suggest an event nobody has processed.
 *
 * `booked` holds "securityId|YYYY-MM-DD" for every corporate action already in
 * the ledger, so a split the processor has handled is not reported again.
 */
export function detectCorporateActions(
  observations: HeldPriceObservation[],
  booked: Set<string>,
  today: string
): CorporateActionAlert[] {
  const alerts: CorporateActionAlert[] = [];

  for (const o of observations) {
    if (!o.latestDate || !o.latestClose) {
      alerts.push({
        kind: "stale_price",
        fund: o.fund,
        ticker: o.ticker,
        lastPriced: null,
        days: Infinity,
        message: `${o.ticker} (held by ${o.fund}) has no price in the last 30 days — likely delisted, taken over or renamed.`,
      });
      continue;
    }

    const age = daysBetween(o.latestDate, today);
    if (age > STALE_PRICE_DAYS) {
      alerts.push({
        kind: "stale_price",
        fund: o.fund,
        ticker: o.ticker,
        lastPriced: o.latestDate,
        days: age,
        message:
          `${o.ticker} (held by ${o.fund}) has not been priced for ${age} days. ` +
          `Likely a completed takeover, delisting or ticker change. It is being valued ` +
          `at its last price, and any cash due has not been credited.`,
      });
      continue;
    }

    if (o.previousClose && !o.previousClose.isZero()) {
      const move = o.latestClose.dividedBy(o.previousClose).minus(1).toNumber();
      if (Math.abs(move) > LARGE_MOVE_THRESHOLD && !booked.has(`${o.securityId}|${o.latestDate}`)) {
        alerts.push({
          kind: "large_move",
          fund: o.fund,
          ticker: o.ticker,
          date: o.latestDate,
          move,
          message:
            `${o.ticker} (held by ${o.fund}) moved ${(move * 100).toFixed(1)}% on ${o.latestDate} ` +
            `with no corporate action booked. Check for a spin-off, rights issue, takeover ` +
            `bid or unprocessed split before trusting today's NAV.`,
        });
      }
    }
  }

  return alerts;
}
