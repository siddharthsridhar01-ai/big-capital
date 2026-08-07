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

/**
 * A fund holding more than this fraction of NAV in cash is treated as still
 * being deployed (building its book). While near-empty, a cash-reducing trade
 * (buy/cover) does not trigger the max_cash_pct soft breach — the "cash too
 * high" nudge would just be noise during initial build-out. Tunable.
 */
const NEAR_EMPTY_CASH_THRESHOLD = new Decimal(0.5);

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
  // `fmt` is the precise 4dp formatter used for the structured audit fields
  // (`currentValue`, `limit`). `msg` is the human-facing 2dp formatter used
  // inside the violation `message` string — cleaner to read in the UI.
  const fmt = (d: Decimal) => d.toFixed(4);
  const msg = (d: Decimal) => d.toFixed(2);

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
            message: `Position in ${ctx.securityMeta.get(secId)?.ticker ?? secId} would be ${msg(pct.times(100))}%, exceeding the ${msg(limit.times(100))}% limit`,
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
          message: `Cash would be ${msg(cashPct.times(100))}%, below the ${msg(limit.times(100))}% minimum`,
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
        // Suppress during initial deployment: a cash-reducing trade (buy or
        // cover) in a fund that's still majority cash is just building the
        // book, so a "cash too high" nudge is noise. Once the fund is
        // majority-invested the constraint applies normally — including on
        // buys — so a mature fund that lets cash drift up still gets flagged.
        const isDeploying = trade.side === "buy" || trade.side === "cover";
        let preCashBase = new Decimal(0);
        for (const [ccy, amt] of ctx.cashByCurrency) {
          preCashBase = preCashBase.plus(
            convertToBase(amt, ccy, ctx.baseCurrency, ctx.date, ctx.fxRates)
          );
        }
        const preCashPct = preCashBase.dividedBy(ctx.navBase);
        if (isDeploying && preCashPct.greaterThan(NEAR_EMPTY_CASH_THRESHOLD)) {
          return null;
        }
        return {
          constraintId: constraint.id,
          constraintType: "max_cash_pct",
          isHard: constraint.isHard,
          message: `Cash would be ${msg(cashPct.times(100))}%, above the ${msg(limit.times(100))}% maximum`,
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
          message: `Gross exposure would be ${msg(grossRatio)}x, above the ${msg(limit)}x limit`,
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
          message: `Net exposure would be ${msg(netRatio.times(100))}%, outside the ±${msg(limit.times(100))}% band`,
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
            message: `${sector} exposure would be ${msg(pct.times(100))}%, above the ${msg(limit.times(100))}% limit`,
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

// ---------------------------------------------------------------------------
// Standing-book utilisation (for the PM dashboard "Limits" panel)
// ---------------------------------------------------------------------------

/**
 * Where the CURRENT book sits against each limit, whether or not it breaches.
 *
 * checkTrade() answers "may I do this trade?" and only reports constraints that
 * are violated. A PM also needs the standing picture — how close each limit is
 * before they act — otherwise a fund can sit off-mandate indefinitely and only
 * discover it when a trade is blocked.
 *
 * Shares positionValuesBase()/convertToBase() with checkTrade so weights and FX
 * are computed identically. It deliberately does NOT re-derive the thresholds:
 * both read the same `constraints` rows.
 */
export interface LimitUtilisation {
  constraintType: ConstraintType;
  isHard: boolean;
  /** Human label, e.g. "Largest position". */
  label: string;
  /** What the book is at now, as a fraction (0.0603) or a count (9). */
  current: number;
  /** The configured limit, same units as `current`. */
  limit: number;
  /** current/limit, clamped to 1 for bar rendering. Null for boolean rules. */
  utilisation: number | null;
  /** True when the limit is exceeded (or, for min_cash_pct, undershot). */
  breached: boolean;
  /** Formatted as a percentage rather than a raw count. */
  isPct: boolean;
  /** e.g. the ticker driving `max_position_pct`. */
  detail?: string;
  /**
   * Set when a limit is numerically exceeded but not treated as a breach
   * because the fund is still ramping up. See RAMP_UP_DAYS.
   */
  exempt?: "ramp-up";
}

/**
 * Deployment limits do not bind while a fund is still building its book.
 *
 * A fund launches 100% cash and deploys over weeks, so a cash ceiling is
 * guaranteed to be "breached" on day one — flagging that trains PMs to ignore
 * the panel. UCITS grants newly authorised funds a six-month derogation from
 * diversification limits for the same reason; 90 days is the shorter, stricter
 * end of that convention and suits a fund reviewed termly.
 *
 * CONCENTRATION limits are deliberately NOT exempt: a 30% single position is
 * reckless in week one exactly as it is in year one.
 */
export const RAMP_UP_DAYS = 90;

const RAMP_UP_EXEMPT: ReadonlySet<ConstraintType> = new Set([
  "max_cash_pct",
  "min_cash_pct",
]);

export function evaluateBookLimits(
  constraints: FundConstraint[],
  ctx: PortfolioContext,
  prices: Map<string, Decimal>,
  opts?: { daysSinceInception?: number; rampUpDays?: number }
): LimitUtilisation[] {
  const rampUpDays = opts?.rampUpDays ?? RAMP_UP_DAYS;
  const inRampUp =
    opts?.daysSinceInception !== undefined && opts.daysSinceInception < rampUpDays;
  const values = positionValuesBase(ctx.positions, prices, ctx);

  let gross = new Decimal(0);
  for (const v of values.values()) gross = gross.plus(v.abs());

  let cashBase = new Decimal(0);
  for (const [ccy, amt] of ctx.cashByCurrency) {
    cashBase = cashBase.plus(convertToBase(amt, ccy, ctx.baseCurrency, ctx.date, ctx.fxRates));
  }

  const nav = ctx.navBase.isZero() ? new Decimal(1) : ctx.navBase;
  const out: LimitUtilisation[] = [];

  const push = (
    o: Omit<LimitUtilisation, "utilisation"> & { utilisation?: number | null }
  ) => {
    const util =
      o.utilisation !== undefined
        ? o.utilisation
        : o.limit === 0
          ? null
          : Math.min(o.current / o.limit, 1);
    const exemptNow = inRampUp && RAMP_UP_EXEMPT.has(o.constraintType) && o.breached;
    out.push({
      ...o,
      utilisation: util,
      breached: exemptNow ? false : o.breached,
      ...(exemptNow ? { exempt: "ramp-up" as const } : {}),
    });
  };

  for (const c of constraints) {
    const num = typeof c.value === "number" ? c.value : Number(c.value);

    switch (c.constraintType) {
      case "max_position_pct": {
        let topId: string | null = null;
        let top = new Decimal(0);
        for (const [id, v] of values) {
          const w = v.abs().dividedBy(nav);
          if (w.greaterThan(top)) {
            top = w;
            topId = id;
          }
        }
        push({
          constraintType: c.constraintType,
          isHard: c.isHard,
          label: "Largest position",
          current: top.toNumber(),
          limit: num,
          breached: top.toNumber() > num,
          isPct: true,
          detail: topId ? (ctx.securityMeta.get(topId)?.ticker ?? undefined) : undefined,
        });
        break;
      }
      case "max_cash_pct":
      case "min_cash_pct": {
        const pct = cashBase.dividedBy(nav).toNumber();
        const isMin = c.constraintType === "min_cash_pct";
        push({
          constraintType: c.constraintType,
          isHard: c.isHard,
          label: isMin ? "Cash floor" : "Cash",
          current: pct,
          limit: num,
          breached: isMin ? pct < num : pct > num,
          isPct: true,
          utilisation: isMin ? null : num === 0 ? null : Math.min(pct / num, 1),
        });
        break;
      }
      case "max_single_sector_pct": {
        const bySector = new Map<string, Decimal>();
        for (const [id, v] of values) {
          const sector = ctx.securityMeta.get(id)?.sector ?? "Unclassified";
          bySector.set(sector, (bySector.get(sector) ?? new Decimal(0)).plus(v.abs()));
        }
        let topSector: string | null = null;
        let top = new Decimal(0);
        for (const [s, v] of bySector) {
          const w = v.dividedBy(nav);
          if (w.greaterThan(top)) {
            top = w;
            topSector = s;
          }
        }
        push({
          constraintType: c.constraintType,
          isHard: c.isHard,
          label: "Largest sector",
          current: top.toNumber(),
          limit: num,
          breached: top.toNumber() > num,
          isPct: true,
          detail: topSector ?? undefined,
        });
        break;
      }
      case "max_position_count": {
        let n = 0;
        for (const p of ctx.positions.values()) if (!p.quantity.isZero()) n += 1;
        push({
          constraintType: c.constraintType,
          isHard: c.isHard,
          label: "Positions",
          current: n,
          limit: num,
          breached: n > num,
          isPct: false,
        });
        break;
      }
      case "max_gross_exposure": {
        const g = gross.dividedBy(nav).toNumber();
        push({
          constraintType: c.constraintType,
          isHard: c.isHard,
          label: "Gross exposure",
          current: g,
          limit: num,
          breached: g > num,
          isPct: true,
        });
        break;
      }
      case "max_net_exposure": {
        let net = new Decimal(0);
        for (const v of values.values()) net = net.plus(v);
        const n = net.dividedBy(nav).abs().toNumber();
        push({
          constraintType: c.constraintType,
          isHard: c.isHard,
          label: "Net exposure",
          current: n,
          limit: num,
          breached: n > num,
          isPct: true,
        });
        break;
      }
      default:
        // universe_only / long_only are boolean rules with no utilisation; they
        // are enforced at trade time and shown as pills, not bars.
        break;
    }
  }

  return out;
}
