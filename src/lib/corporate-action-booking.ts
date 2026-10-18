/**
 * Booking takeovers, mergers and spin-offs — pure planning, no database.
 *
 * Each event becomes a short sequence of ordinary ledger entries ("legs"). The
 * planner computes them; the executor writes them. Keeping the arithmetic here,
 * pure, means it can be tested exhaustively without a database.
 *
 * TWO ACCOUNTING TREATMENTS, chosen to match investment-fund practice:
 *
 * MERGERS AND TAKEOVERS — fair value. The target is treated as disposed of at
 * the value of what the holder receives, and any new shares as acquired at
 * market. This realises the gain or loss on the target, which is the standard
 * treatment for a fund reporting NAV (investment-company accounting records the
 * exchange at fair value). One mechanism covers every case:
 *   - cash takeover:  ratio 0,  cash > 0
 *   - share merger:   ratio > 0, cash 0
 *   - mixed deal:     ratio > 0, cash > 0
 *
 * SPIN-OFFS — cost allocation. Not a sale: the holder still owns everything it
 * owned, now in two pieces. The parent's cost basis is split between parent and
 * spin-off in proportion to their market values on the ex-date, and nothing is
 * realised. Without this, the parent's price falls by the spin-off's value and
 * the fund books a permanent fake loss.
 *
 * Fractional entitlements are paid as cash in lieu, as a broker would.
 * Long and short holdings are both handled; a short holder owes what a long
 * holder would receive.
 */
import Decimal from "decimal.js";
import { cashInLieu } from "./corporate-actions";

export type LegType = "buy" | "sell" | "short" | "cover" | "corporate_action";

export interface Leg {
  /** Which security the leg applies to. */
  role: "target" | "received" | "parent" | "spinco";
  transactionType: LegType;
  quantity: Decimal;
  price: Decimal;
  cashImpact: Decimal;
  /** Milliseconds after the effective date's midnight, to fix the order. */
  offsetMs: number;
  note: string;
}

function disposeType(long: boolean): LegType {
  return long ? "sell" : "cover";
}
function addType(long: boolean): LegType {
  return long ? "buy" : "short";
}

// ---------------------------------------------------------------------------
// Mergers and takeovers
// ---------------------------------------------------------------------------

export interface MergerInput {
  /** Signed shares of the target held immediately before the effective date. */
  held: Decimal;
  /** Average cost per target share, target currency. */
  avgCost: Decimal;
  /** Shares of the received security per target share. 0 for an all-cash deal. */
  ratio: Decimal;
  /** Cash per target share, in the target's currency. 0 for an all-share deal. */
  cashPerShare: Decimal;
  /** Price of the received security on the effective date, its own currency. */
  receivedPrice: Decimal;
  /** Converts the received security's currency into the target's. 1 if the same. */
  fxReceivedToTarget: Decimal;
}

export interface MergerPlan {
  legs: Leg[];
  fairValuePerShare: Decimal;
  realisedPnl: Decimal;
  receivedShares: Decimal;
  cashReceived: Decimal;
}

export function planMerger(i: MergerInput): MergerPlan {
  if (i.held.isZero()) throw new Error("Nothing held");
  if (i.ratio.isNegative() || i.cashPerShare.isNegative()) throw new Error("Terms cannot be negative");
  if (i.ratio.isZero() && i.cashPerShare.isZero()) throw new Error("The deal pays neither shares nor cash");
  if (i.ratio.greaterThan(0) && !i.receivedPrice.greaterThan(0)) {
    throw new Error("A price is needed for the shares received");
  }

  const long = i.held.greaterThan(0);
  const stockValue = i.ratio.times(i.receivedPrice).times(i.fxReceivedToTarget);
  const fairValuePerShare = stockValue.plus(i.cashPerShare);
  const cashReceived = i.held.times(i.cashPerShare);

  const legs: Leg[] = [
    {
      role: "target",
      transactionType: disposeType(long),
      quantity: i.held.negated(),
      price: fairValuePerShare,
      cashImpact: cashReceived,
      offsetMs: 0,
      note: "Target disposed of at the fair value of the consideration received",
    },
  ];

  let receivedShares = new Decimal(0);
  if (i.ratio.greaterThan(0)) {
    const exact = i.held.times(i.ratio);
    const whole = exact.truncated();
    const fraction = exact.minus(whole);
    receivedShares = whole;
    legs.push({
      role: "received",
      transactionType: addType(long),
      quantity: exact,
      price: i.receivedPrice,
      cashImpact: new Decimal(0),
      offsetMs: 1,
      note: "Shares received in exchange, at market",
    });
    if (!fraction.isZero()) {
      const c = cashInLieu(fraction, i.receivedPrice);
      legs.push({
        role: "received",
        transactionType: c.transactionType,
        quantity: c.quantity,
        price: i.receivedPrice,
        cashImpact: c.cashImpact,
        offsetMs: 2,
        note: "Cash in lieu of fractional shares",
      });
    }
  }

  const perShare = long ? fairValuePerShare.minus(i.avgCost) : i.avgCost.minus(fairValuePerShare);
  return {
    legs,
    fairValuePerShare,
    realisedPnl: perShare.times(i.held.abs()),
    receivedShares,
    cashReceived,
  };
}

// ---------------------------------------------------------------------------
// Spin-offs
// ---------------------------------------------------------------------------

export interface SpinOffInput {
  /** Signed shares of the parent held immediately before the ex-date. */
  held: Decimal;
  /** Average cost per parent share, parent currency. */
  avgCost: Decimal;
  /** Spin-off shares received per parent share. */
  ratio: Decimal;
  /** Parent's price on the ex-date (after the spin-off value has left it). */
  parentPrice: Decimal;
  /** Spin-off's price on its first day, its own currency. */
  spincoPrice: Decimal;
  /** Converts the spin-off's currency into the parent's. 1 if the same. */
  fxSpincoToParent: Decimal;
}

export interface SpinOffPlan {
  legs: Leg[];
  /** Share of the original cost basis moved to the spin-off. */
  allocationToSpinco: Decimal;
  parentAvgBefore: Decimal;
  parentAvgAfter: Decimal;
  /** Cost per spin-off share, spin-off currency. */
  spincoAvgCost: Decimal;
  spincoShares: Decimal;
}

export function planSpinOff(i: SpinOffInput): SpinOffPlan {
  if (i.held.isZero()) throw new Error("Nothing held");
  if (!i.ratio.greaterThan(0)) throw new Error("A spin-off must distribute a positive number of shares");
  if (!i.parentPrice.greaterThan(0) || !i.spincoPrice.greaterThan(0)) {
    throw new Error("Both prices are needed to allocate cost");
  }

  const long = i.held.greaterThan(0);

  // Spin-off value carried per parent share, in the parent's currency.
  const spincoValue = i.ratio.times(i.spincoPrice).times(i.fxSpincoToParent);
  const allocation = spincoValue.dividedBy(i.parentPrice.plus(spincoValue));

  const parentAvgAfter = i.avgCost.times(new Decimal(1).minus(allocation));
  // Cost per spin-off share: the allocated cost per parent share, spread over the
  // `ratio` spin-off shares each parent share became, then into spin-off currency.
  const spincoAvgParentCcy = i.avgCost.times(allocation).dividedBy(i.ratio);
  const spincoAvgCost = spincoAvgParentCcy.dividedBy(i.fxSpincoToParent);

  const exact = i.held.times(i.ratio);
  const whole = exact.truncated();
  const fraction = exact.minus(whole);

  const legs: Leg[] = [
    // Remove the parent at its old cost — a restatement, so nothing is realised.
    {
      role: "parent",
      transactionType: "corporate_action",
      quantity: i.held.negated(),
      price: new Decimal(0),
      cashImpact: new Decimal(0),
      offsetMs: 0,
      note: "Parent restated to carry its reduced cost basis",
    },
    // Re-establish the same shares at the reduced cost.
    {
      role: "parent",
      transactionType: addType(long),
      quantity: i.held,
      price: parentAvgAfter,
      cashImpact: new Decimal(0),
      offsetMs: 1,
      note: "Parent re-established at its share of the original cost basis",
    },
    {
      role: "spinco",
      transactionType: addType(long),
      quantity: exact,
      price: spincoAvgCost,
      cashImpact: new Decimal(0),
      offsetMs: 2,
      note: "Spin-off shares received, carrying their share of the original cost basis",
    },
  ];

  if (!fraction.isZero()) {
    const c = cashInLieu(fraction, i.spincoPrice);
    legs.push({
      role: "spinco",
      transactionType: c.transactionType,
      quantity: c.quantity,
      price: i.spincoPrice,
      cashImpact: c.cashImpact,
      offsetMs: 3,
      note: "Cash in lieu of fractional spin-off shares",
    });
  }

  return {
    legs,
    allocationToSpinco: allocation,
    parentAvgBefore: i.avgCost,
    parentAvgAfter,
    spincoAvgCost,
    spincoShares: whole,
  };
}
