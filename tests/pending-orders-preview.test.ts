/**
 * Previews and limits include queued orders.
 *
 * Queuing an order runs no compliance check, so the preview is the only warning
 * a PM gets. Checked against the current book alone, each of twenty-five orders
 * queued for the open looked affordable — and the later ones were refused at the
 * open when the cash ran out. These pin the forward book: the current holdings
 * plus every queued order, estimated at its latest price.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  provisionalFromQueue,
  reduceFirstRank,
  aggregatePortfolioFromTransactions,
  type SecurityMeta,
  type RawTransaction,
} from "../src/lib/portfolio";
import { checkTrade, type FundConstraint, type ProposedTrade, type PortfolioContext } from "../src/lib/constraints";

const META: SecurityMeta[] = [
  { id: "hsba", ticker: "HSBA", name: "HSBC", exchange: "LSE", currency: "GBP", gicsSector: "Financials" },
  { id: "azn", ticker: "AZN", name: "AstraZeneca", exchange: "LSE", currency: "GBP", gicsSector: "Health Care" },
  { id: "rel", ticker: "REL", name: "RELX", exchange: "LSE", currency: "GBP", gicsSector: "Industrials" },
  { id: "sap", ticker: "SAP", name: "SAP", exchange: "XETRA", currency: "EUR", gicsSector: "Information Technology" },
];
const PRICES = new Map([
  ["hsba", { close: "10", date: "2026-10-16" }],
  ["azn", { close: "120", date: "2026-10-16" }],
  ["rel", { close: "40", date: "2026-10-16" }],
  ["sap", { close: "200", date: "2026-10-16" }],
]);
const FX = new Map([["EUR", new Decimal("0.86")]]);
const AFTER = new Date("2026-10-19T00:00:00Z");

function order(securityId: string, side: string, quantity: number, minute = 0) {
  return { securityId, side, quantity: String(quantity), submittedAt: new Date(Date.parse("2026-10-18T20:00:00Z") + minute * 60000) };
}

function forwardBook(queue: ReturnType<typeof order>[], held: RawTransaction[] = []) {
  const { provisional, unpriced } = provisionalFromQueue(queue, META, PRICES, FX, AFTER);
  const state = aggregatePortfolioFromTransactions("GBP", "100000", [...held, ...provisional], META, PRICES, undefined, FX);
  return { state, unpriced, provisional };
}

describe("the forward book", () => {
  it("spends cash on queued purchases", () => {
    // 600 HSBC at £10 = £6,000.
    const { state } = forwardBook([order("hsba", "buy", 600)]);
    expect(state.cashBase.toNumber()).toBe(94000);
  });

  it("shows queued purchases as positions and sector weight", () => {
    const { state } = forwardBook([order("hsba", "buy", 600), order("azn", "buy", 40)]);
    expect(state.positions.get("hsba")!.quantity.toNumber()).toBe(600);
    expect(state.sectorExposures.get("Financials")!.toNumber()).toBeCloseTo(0.06, 6);
    expect(state.sectorExposures.get("Health Care")!.toNumber()).toBeCloseTo(0.048, 6);
  });

  it("counts queued names towards the position count", () => {
    const { state } = forwardBook([order("hsba", "buy", 600), order("azn", "buy", 40), order("rel", "buy", 100)]);
    expect(state.positions.size).toBe(3);
  });

  it("converts a foreign-currency order at the current rate", () => {
    // 30 SAP at €200 = €6,000 = £5,160 at 0.86.
    const { state } = forwardBook([order("sap", "buy", 30)]);
    expect(state.cashBase.toNumber()).toBeCloseTo(100000 - 5160, 6);
  });

  it("leaves out and counts an order it cannot price, rather than guessing", () => {
    const { unpriced, provisional } = forwardBook([order("hsba", "buy", 600), order("unknown", "buy", 10)]);
    expect(unpriced).toBe(1);
    expect(provisional).toHaveLength(1);
  });

  it("a queued sale releases cash for a queued purchase", () => {
    const held: RawTransaction[] = [{
      transactionType: "buy", securityId: "azn", quantity: "100", price: "120", currency: "GBP",
      cashImpact: "-12000", fxRateToBase: "1", executedAt: new Date("2026-10-15T08:00:00Z"),
    }];
    const { state } = forwardBook([order("azn", "sell", 50), order("hsba", "buy", 600)], held);
    // 100,000 - 12,000 + 6,000 (sale) - 6,000 (purchase)
    expect(state.cashBase.toNumber()).toBe(88000);
  });
});

describe("reduce before you add", () => {
  it("ranks sales and covers ahead of purchases and shorts", () => {
    expect(reduceFirstRank("sell")).toBeLessThan(reduceFirstRank("buy"));
    expect(reduceFirstRank("cover")).toBeLessThan(reduceFirstRank("short"));
  });

  it("orders a trim before the purchase it funds, whatever order they were queued in", () => {
    // Purchase queued FIRST, trim second — the case that failed at the open.
    const { provisional } = forwardBook([order("hsba", "buy", 600, 0), order("azn", "sell", 50, 5)]);
    expect(provisional.map((p) => p.transactionType)).toEqual(["sell", "buy"]);
  });
});

describe("a new order previewed against the queue", () => {
  const LONG_ONLY: FundConstraint[] = [
    { id: "c1", constraintType: "long_only", value: true, isHard: true },
    { id: "c2", constraintType: "max_single_sector_pct", value: 0.35, isHard: false },
  ];
  // Twenty-five purchases of £3,920 each: £98,000 committed for the open.
  const queue = Array.from({ length: 25 }, (_, i) => order("rel", "buy", 98, i));

  function ctxFrom(state: ReturnType<typeof forwardBook>["state"]): PortfolioContext {
    const securityMeta: PortfolioContext["securityMeta"] = new Map();
    const positions: PortfolioContext["positions"] = new Map();
    for (const [id, p] of state.positions) {
      securityMeta.set(id, { ticker: p.ticker, sector: p.gicsSector, currency: p.currency });
      positions.set(id, { securityId: id, quantity: p.quantity, avgCostNative: p.avgCostNative, currency: p.currency });
    }
    securityMeta.set("hsba", { ticker: "HSBA", sector: "Financials", currency: "GBP" });
    return {
      navBase: state.navBase, cashByCurrency: state.cashByCurrency, positions, fxRates: new Map(),
      baseCurrency: "GBP", date: "2026-10-19", securityMeta, investableUniverse: new Set(["hsba", "rel"]),
    };
  }
  const buyHsbc: ProposedTrade = { securityId: "hsba", side: "buy", quantity: new Decimal(600), price: new Decimal(10), currency: "GBP" } as ProposedTrade;
  const px = new Map([["hsba", new Decimal(10)], ["rel", new Decimal(40)]]);

  it("looks affordable against the current book alone — the old, misleading preview", () => {
    const { state } = forwardBook([]);
    const r = checkTrade(LONG_ONLY, buyHsbc, ctxFrom(state), px);
    expect(r.hardViolations.some((v) => v.constraintId === "solvency")).toBe(false);
  });

  it("is blocked against the forward book, since the queue has already spent the cash", () => {
    const { state } = forwardBook(queue);
    expect(state.cashBase.toNumber()).toBe(2000);
    const r = checkTrade(LONG_ONLY, buyHsbc, ctxFrom(state), px);
    expect(r.hardViolations.some((v) => v.constraintId === "solvency")).toBe(true);
  });

  it("sees the sector weight the queue has already built", () => {
    // Every queued order is RELX, so Industrials is ~98% of the forward book.
    const { state } = forwardBook(queue);
    expect(state.sectorExposures.get("Industrials")!.toNumber()).toBeGreaterThan(0.35);
  });
});
