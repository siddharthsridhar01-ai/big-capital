/**
 * Basket orders — parsing and checking. Pure, so both can be tested directly.
 *
 * A basket is a list of orders submitted together: a rebalance, or a systematic
 * model's output. It is ALL OR NOTHING. If any order breaches any limit, soft or
 * hard, nothing is submitted; the PM trades those lines individually through the
 * ticket, where a soft breach can be justified, and resubmits the rest.
 *
 * Partial execution is the dangerous alternative. Dropping the short leg of a
 * pair because it breached leaves the long unhedged. And because each order is
 * checked against the book the earlier ones leave behind, removing one silently
 * invalidates the checks on everything after it.
 */
import type Decimal from "decimal.js";
import {
  checkTrade,
  applyTradeToContext,
  type FundConstraint,
  type PortfolioContext,
  type ProposedTrade,
  type ConstraintViolation,
} from "./constraints";

export type Side = "buy" | "sell" | "short" | "cover";
const SIDES = new Set<Side>(["buy", "sell", "short", "cover"]);
export const MAX_BASKET_ORDERS = 200;

export interface BasketLine {
  line: number;
  ticker: string;
  side: Side;
  shares: number;
}

export interface ParseResult {
  orders: BasketLine[];
  errors: Array<{ line: number; message: string }>;
}

/**
 * One order per line: ticker, side, shares — comma- or tab-separated, so it
 * can be pasted from a spreadsheet or written by a script. A header row and
 * blank or # comment lines are ignored.
 *
 *   ASML.AS, buy, 4
 *   SAN.MC, buy, 900
 *   NVDA, short, 40
 */
export function parseBasket(text: string): ParseResult {
  const orders: BasketLine[] = [];
  const errors: ParseResult["errors"] = [];
  const seen = new Map<string, number>();

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const parts = trimmed.split(/[,\t]/).map((p) => p.trim()).filter((p) => p !== "");
    if (orders.length === 0 && errors.length === 0 && /^(ticker|symbol)$/i.test(parts[0] ?? "")) return;

    if (parts.length !== 3) {
      errors.push({ line, message: `Expected ticker, side, shares — found ${parts.length} field${parts.length === 1 ? "" : "s"}.` });
      return;
    }
    const [tickerRaw, sideRaw, sharesRaw] = parts;
    const ticker = tickerRaw.toUpperCase();
    const side = sideRaw.toLowerCase() as Side;
    if (!SIDES.has(side)) {
      errors.push({ line, message: `Side "${sideRaw}" must be buy, sell, short or cover.` });
      return;
    }
    const shares = Number(sharesRaw.replace(/_/g, ""));
    if (!Number.isInteger(shares) || shares < 1) {
      errors.push({ line, message: `Shares "${sharesRaw}" must be a whole number of at least 1.` });
      return;
    }
    // One line per security: two lines for the same name are ambiguous, and
    // net into a single order more clearly.
    const prior = seen.get(ticker);
    if (prior != null) {
      errors.push({ line, message: `${ticker} already appears on line ${prior}. Combine them into one order.` });
      return;
    }
    seen.set(ticker, line);
    orders.push({ line, ticker, side, shares });
  });

  if (orders.length > MAX_BASKET_ORDERS) {
    errors.push({ line: 0, message: `A basket can hold at most ${MAX_BASKET_ORDERS} orders; this has ${orders.length}.` });
  }
  return { orders, errors };
}

export function reduceFirstRank(side: string): number {
  return side === "sell" || side === "cover" ? 0 : 1;
}

export interface SimulatedOrder<K> {
  key: K;
  trade: ProposedTrade;
  hard: ConstraintViolation[];
  soft: ConstraintViolation[];
  error: string | null;
}

/**
 * Check every order in sequence — sales and covers first, as they will fill —
 * each against the book the earlier orders leave behind.
 *
 * Every order is applied whether or not it breaches, because the basket is all
 * or nothing: if anything breaches, nothing is submitted, so later checks should
 * describe the basket as written.
 */
export function simulateBasket<K>(
  constraints: FundConstraint[],
  start: PortfolioContext,
  orders: Array<{ key: K; trade: ProposedTrade }>,
  prices: Map<string, Decimal>
): { results: SimulatedOrder<K>[]; end: PortfolioContext; clean: boolean } {
  const ordered = orders
    .map((o, i) => ({ ...o, i }))
    .sort((a, b) => reduceFirstRank(a.trade.side) - reduceFirstRank(b.trade.side) || a.i - b.i);

  let ctx = start;
  const results: SimulatedOrder<K>[] = [];
  for (const o of ordered) {
    try {
      const r = checkTrade(constraints, o.trade, ctx, prices);
      results.push({ key: o.key, trade: o.trade, hard: r.hardViolations, soft: r.softViolations, error: null });
    } catch (e) {
      results.push({ key: o.key, trade: o.trade, hard: [], soft: [], error: e instanceof Error ? e.message : String(e) });
    }
    ctx = applyTradeToContext(ctx, o.trade);
  }
  const clean = results.every((r) => !r.error && r.hard.length === 0 && r.soft.length === 0);
  return { results, end: ctx, clean };
}


/**
 * Whether an order may fill at a session's opening print.
 *
 * Only if it was placed BEFORE that session opened. Filling at an open the PM
 * has already seen is look-ahead. Without the session time from the feed, it is
 * conservative and requires the order to predate the day entirely.
 */
export function orderMayFillAtOpen(submittedAt: Date, sessionStart: Date | null | undefined, todayUtc: string): boolean {
  if (sessionStart) return submittedAt < new Date(sessionStart);
  return submittedAt.toISOString().slice(0, 10) < todayUtc;
}
