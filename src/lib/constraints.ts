/**
 * BIG Capital — Constraints Engine
 *
 * Evaluates a proposed trade against the fund's active constraints and returns
 * which (if any) constraints would be violated, distinguishing hard (block)
 * from soft (warn + override-with-rationale) violations.
 *
 * Constraints are configured per-fund and stored as data, not code. Adding a
 * new constraint type requires:
 *   1. Add a case in `evaluateConstraint` below
 *   2. (optional) add a UI editor for the new constraint type
 *
 * See docs/phase-0-spec.md §4 for the trade lifecycle and §11 for the locked
 * defaults: universe_only, long_only, max_gross_exposure, max_net_exposure
 * are HARD; everything else is SOFT.
 */

import Decimal from "decimal.js";
import type { Currency, Position } from "./performance";

export type ConstraintType =
  | "universe_only"
  | "max_position_pct"
  | "min_cash_pct"
  | "max_cash_pct"
  | "long_only"
  | "max_gross_exposure"
  | "max_net_exposure"
  | "max_single_sector_pct"
  | "max_position_count";

export interface FundConstraint {
  id: string;
  constraintType: ConstraintType;
  value: unknown; // shape depends on constraintType
  isHard: boolean;
}

export interface ProposedTrade {
  securityId: string;
  side: "buy" | "sell" | "short" | "cover";
  quantity: Decimal; // unsigned magnitude
  price: Decimal;
  currency: Currency;
}

export interface PortfolioContext {
  navBase: Decimal;
  cashByCurrency: Map<Currency, Decimal>;
  positions: Map<string, Position>; // current positions before trade
  fxRates: Map<string, string>;
  baseCurrency: Currency;
  date: string;
  // Security metadata needed for some checks
  securityMeta: Map<string, { ticker: string; sector: string | null; currency: Currency }>;
  // Set of security IDs currently in the investable universe
  investableUniverse: Set<string>;
}

export interface ConstraintViolation {
  constraintId: string;
  constraintType: ConstraintType;
  isHard: boolean;
  message: string;
  currentValue: string;
  limit: string;
}

export interface ConstraintCheckResult {
  pass: boolean;
  hardViolations: ConstraintViolation[];
  softViolations: ConstraintViolation[];
}

// ---------------------------------------------------------------------------
// Apply trade hypothetically to compute post-trade state
// ---------------------------------------------------------------------------

function applyTradeToPositions(
  positions: Map<string, Position>,
  trade: ProposedTrade
): Map<string, Position> {
  const result = new Map(positions);
  const existing = result.get(trade.securityId);

  const signedQty =
    trade.side === "buy" || trade.side === "cover"
      ? trade.quantity
      : trade.quantity.negated();

  if (!existing) {
    result.set(trade.securityId, {
      securityId: trade.securityId,
      quantity: signedQty,
      avgCostNative: trade.price,
      currency: trade.currency,
    });
  } else {
    const newQty = existing.quantity.plus(signedQty);
    if (newQty.isZero()) {
      result.delete(trade.securityId);
    } else {
      result.set(trade.securityId, {
        ...existing,
        quantity: newQty,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers for the checks
// ---------------------------------------------------------------------------

function convertToBase(
  amount: Decimal,
  from: Currency,
  to: Currency,
  date: string,
  fxRates: Map<string, string>
): Decimal {
  if (from === to) return amount;
  const direct = fxRates.get(`${from}/${to}/${date}`);
  if (direct) return amount.times(direct);
  const inverse = fxRates.get(`${to}/${from}/${date}`);
  if (inverse) return amount.dividedBy(inverse);
  throw new Error(`No FX rate ${from}->${to} on ${date}`);
}

function positionValuesBase(
  positions: Map<string, Position>,
  prices: Map<string, Decimal>,
  ctx: PortfolioContext
): Map<string, Decimal> {
  const result = new Map<string, Decimal>();
  for (const [secId, pos] of positions) {
    const price = prices.get(secId);
    if (!price) throw new Error(`No price for ${secId}`);
    const meta = ctx.securityMeta.get(secId);
    if (!meta) throw new Error(`No metadata for ${secId}`);
    const native = pos.quantity.times(price);
    const base = convertToBase(native, meta.currency, ctx.baseCurrency, ctx.date, ctx.fxRates);
    result.set(secId, base);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-constraint evaluation
// ---------------------------------------------------------------------------

function evaluateConstraint(
  constraint: FundConstraint,
  trade: ProposedTrade,
  postTradePositions: Map<string, Position>,
  postTradeCash: Map<Currency, Decimal>,
  ctx: PortfolioContext,
  pricesPostTrade: Map<string, Decimal>
): ConstraintViolation | null {
  const fmt = (d: Decimal) => d.toFixed(4);

  switch (constraint.constraintType) {
    case "universe_only": {
      const enabled = constraint.value === true;
      if (!enabled) return null;
      // Only buys/shorts are restricted to universe; closes (sell/cover) always allowed
      if (trade.side !== "buy" && trade.side !== "short") return null;
      if (!ctx.investableUniverse.has(trade.securityId)) {
        return {
          constraintId: constraint.id,
          constraintType: "universe_only",
          isHard: constraint.isHard,
          message: "Security is not in this fund's investable universe",
          currentValue: "outside",
          limit: "in_universe",
        };
      }
      return null;
    }

    case "long_only": {
      const enabled = constraint.value === true;
      if (!enabled) return null;
      // Block shorts and oversells (any post-trade negative quantity)
      for (const pos of postTradePositions.values()) {
        if (pos.quantity.lessThan(0)) {
          return {
            constraintId: constraint.id,
            constraintType: "long_only",
            isHard: constraint.isHard,
            message: "Trade would result in a short position; fund is long-only",
            currentValue: pos.quantity.toFixed(2),
            limit: "0",
          };
        }
      }
      return null;
    }

    case "max_position_pct": {
      const limit = new Decimal(constraint.value as number);
      const postValues = positionValuesBase(postTradePositions, pricesPostTrade, ctx);
      let postNav = new Decimal(0);
      for (const v of postValues.values()) postNav = postNav.plus(v);
      for (const [, cash] of postTradeCash) {
        postNav = postNav.plus(convertToBase(cash, [...postTradeCash.keys()][0], ctx.baseCurrency, ctx.date, ctx.fxRates));
      }
      // Note: post-NAV computed properly in real callers; here we use ctx.navBase as approximation
      const navForCheck = ctx.navBase;
      for (const [secId, val] of postValues) {
        if (navForCheck.isZero()) continue;
        const pct = val.abs().dividedBy(navForCheck);
        if (pct.greaterThan(limit)) {
          return {
            constraintId: constraint.id,
            constraintType: "max_position_pct",
            isHard: constraint.isHard,
            message: `Position in ${ctx.securityMeta.get(secId)?.ticker ?? secId} would be ${fmt(pct.times(100))}%, exceeding the ${fmt(limit.times(100))}% limit`,
            currentValue: fmt(pct),
            limit: fmt(limit),
          };
        }
      }
      return null;
    }

    case "min_cash_pct": {
      const limit = new Decimal(constraint.value as number);
      let cashBase = new Decimal(0);
      for (const [ccy, amt] of postTradeCash) {
        cashBase = cashBase.plus(convertToBase(amt, ccy, ctx.baseCurrency, ctx.date, ctx.fxRates));
      }
      if (ctx.navBase.isZero()) return null;
      const cashPct = cashBase.dividedBy(ctx.navBase);
      if (cashPct.lessThan(limit)) {
        return {
          constraintId: constraint.id,
          constraintType: "min_cash_pct",
          isHard: constraint.isHard,
          message: `Cash would be ${fmt(cashPct.times(100))}%, below the ${fmt(limit.times(100))}% minimum`,
          currentValue: fmt(cashPct),
          limit: fmt(limit),
        };
      }
      return null;
    }

    case "max_cash_pct": {
      const limit = new Decimal(constraint.value as number);
      let cashBase = new Decimal(0);
      for (const [ccy, amt] of postTradeCash) {
        cashBase = cashBase.plus(convertToBase(amt, ccy, ctx.baseCurrency, ctx.date, ctx.fxRates));
      }
      if (ctx.navBase.isZero()) return null;
      const cashPct = cashBase.dividedBy(ctx.navBase);
      if (cashPct.greaterThan(limit)) {
        return {
          constraintId: constraint.id,
          constraintType: "max_cash_pct",
          isHard: constraint.isHard,
          message: `Cash would be ${fmt(cashPct.times(100))}%, above the ${fmt(limit.times(100))}% maximum`,
          currentValue: fmt(cashPct),
          limit: fmt(limit),
        };
      }
      return null;
    }

    case "max_gross_exposure": {
      const limit = new Decimal(constraint.value as number);
      const postValues = positionValuesBase(postTradePositions, pricesPostTrade, ctx);
      let gross = new Decimal(0);
      for (const v of postValues.values()) gross = gross.plus(v.abs());
      if (ctx.navBase.isZero()) return null;
      const grossRatio = gross.dividedBy(ctx.navBase);
      if (grossRatio.greaterThan(limit)) {
        return {
          constraintId: constraint.id,
          constraintType: "max_gross_exposure",
          isHard: constraint.isHard,
          message: `Gross exposure would be ${fmt(grossRatio)}x, above the ${fmt(limit)}x limit`,
          currentValue: fmt(grossRatio),
          limit: fmt(limit),
        };
      }
      return null;
    }

    case "max_net_exposure": {
      const limit = new Decimal(constraint.value as number); // typically 0.2 = ±20%
      const postValues = positionValuesBase(postTradePositions, pricesPostTrade, ctx);
      let net = new Decimal(0);
      for (const v of postValues.values()) net = net.plus(v);
      if (ctx.navBase.isZero()) return null;
      const netRatio = net.dividedBy(ctx.navBase);
      if (netRatio.abs().greaterThan(limit)) {
        return {
          constraintId: constraint.id,
          constraintType: "max_net_exposure",
          isHard: constraint.isHard,
          message: `Net exposure would be ${fmt(netRatio.times(100))}%, outside the ±${fmt(limit.times(100))}% band`,
          currentValue: fmt(netRatio),
          limit: fmt(limit),
        };
      }
      return null;
    }

    case "max_single_sector_pct": {
      const limit = new Decimal(constraint.value as number);
      const postValues = positionValuesBase(postTradePositions, pricesPostTrade, ctx);
      const bySector = new Map<string, Decimal>();
      for (const [secId, val] of postValues) {
        const sector = ctx.securityMeta.get(secId)?.sector ?? "Unknown";
        bySector.set(sector, (bySector.get(sector) ?? new Decimal(0)).plus(val.abs()));
      }
      if (ctx.navBase.isZero()) return null;
      for (const [sector, val] of bySector) {
        const pct = val.dividedBy(ctx.navBase);
        if (pct.greaterThan(limit)) {
          return {
            constraintId: constraint.id,
            constraintType: "max_single_sector_pct",
            isHard: constraint.isHard,
            message: `${sector} exposure would be ${fmt(pct.times(100))}%, above the ${fmt(limit.times(100))}% limit`,
            currentValue: fmt(pct),
            limit: fmt(limit),
          };
        }
      }
      return null;
    }

    case "max_position_count": {
      const limit = constraint.value as number;
      if (postTradePositions.size > limit) {
        return {
          constraintId: constraint.id,
          constraintType: "max_position_count",
          isHard: constraint.isHard,
          message: `Position count would be ${postTradePositions.size}, above the limit of ${limit}`,
          currentValue: postTradePositions.size.toString(),
          limit: limit.toString(),
        };
      }
      return null;
    }

    default:
      // Unknown constraint type — fail loudly in dev, silently in prod is wrong
      throw new Error(`Unknown constraint type: ${constraint.constraintType}`);
  }
}

// ---------------------------------------------------------------------------
// Public API: evaluate a proposed trade against all active constraints
// ---------------------------------------------------------------------------

export function checkTrade(
  constraints: FundConstraint[],
  trade: ProposedTrade,
  ctx: PortfolioContext,
  pricesPostTrade: Map<string, Decimal>
): ConstraintCheckResult {
  // Build post-trade positions
  const postTradePositions = applyTradeToPositions(ctx.positions, trade);

  // Build post-trade cash: trade affects cash in trade.currency
  const postTradeCash = new Map(ctx.cashByCurrency);
  const signedCashImpact =
    trade.side === "buy" || trade.side === "cover"
      ? trade.price.times(trade.quantity).negated()
      : trade.price.times(trade.quantity);
  const currentCash = postTradeCash.get(trade.currency) ?? new Decimal(0);
  postTradeCash.set(trade.currency, currentCash.plus(signedCashImpact));

  const hard: ConstraintViolation[] = [];
  const soft: ConstraintViolation[] = [];

  for (const c of constraints) {
    const violation = evaluateConstraint(
      c,
      trade,
      postTradePositions,
      postTradeCash,
      ctx,
      pricesPostTrade
    );
    if (!violation) continue;
    if (violation.isHard) hard.push(violation);
    else soft.push(violation);
  }

  return {
    pass: hard.length === 0,
    hardViolations: hard,
    softViolations: soft,
  };
}
