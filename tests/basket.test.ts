/**
 * Basket orders: parsing, and all-or-nothing checking in fill order.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { parseBasket, simulateBasket, MAX_BASKET_ORDERS } from "../src/lib/basket";
import type { FundConstraint, PortfolioContext, ProposedTrade } from "../src/lib/constraints";

describe("parseBasket", () => {
  it("reads ticker, side, shares", () => {
    const r = parseBasket("ASML.AS, buy, 4\nSAN.MC, buy, 900\nNVDA, short, 40");
    expect(r.errors).toEqual([]);
    expect(r.orders.map((o) => [o.ticker, o.side, o.shares])).toEqual([
      ["ASML.AS", "buy", 4], ["SAN.MC", "buy", 900], ["NVDA", "short", 40],
    ]);
  });

  it("accepts tab-separated input pasted from a spreadsheet", () => {
    expect(parseBasket("HSBA.L\tsell\t200").orders[0]).toMatchObject({ ticker: "HSBA.L", side: "sell", shares: 200 });
  });

  it("ignores a header row, blank lines and comments", () => {
    const r = parseBasket("ticker,side,shares\n\n# rebalance 19 Oct\nAZN.L,buy,10\n");
    expect(r.errors).toEqual([]);
    expect(r.orders).toHaveLength(1);
  });

  it("normalises case", () => {
    expect(parseBasket("azn.l, BUY, 10").orders[0]).toMatchObject({ ticker: "AZN.L", side: "buy" });
  });

  it("reports the line of each problem", () => {
    const r = parseBasket("AZN.L, buy, 10\nREL.L, hold, 5\nSHEL.L, buy, 2.5\nRIO.L, buy");
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });

  it("refuses zero or negative shares", () => {
    expect(parseBasket("AZN.L, buy, 0").errors).toHaveLength(1);
    expect(parseBasket("AZN.L, buy, -5").errors).toHaveLength(1);
  });

  it("refuses the same security twice", () => {
    const r = parseBasket("AZN.L, buy, 10\nAZN.L, buy, 5");
    expect(r.errors[0].message).toContain("already appears on line 1");
  });

  it("caps the basket size", () => {
    const text = Array.from({ length: MAX_BASKET_ORDERS + 1 }, (_, i) => `T${i}, buy, 1`).join("\n");
    expect(parseBasket(text).errors.some((e) => e.message.includes("at most"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("simulateBasket", () => {
  const LONG_ONLY: FundConstraint[] = [
    { id: "c1", constraintType: "long_only", value: true, isHard: true },
    { id: "c2", constraintType: "max_position_pct", value: 0.1, isHard: false },
  ];
  const prices = new Map([["a", new Decimal(10)], ["b", new Decimal(10)], ["c", new Decimal(10)]]);
  const meta: PortfolioContext["securityMeta"] = new Map([
    ["a", { ticker: "A", sector: "Financials", currency: "GBP" }],
    ["b", { ticker: "B", sector: "Industrials", currency: "GBP" }],
    ["c", { ticker: "C", sector: "Health Care", currency: "GBP" }],
  ]);
  const ctx = (cash: number, held: Array<[string, number]> = []): PortfolioContext => ({
    navBase: new Decimal(100000),
    cashByCurrency: new Map([["GBP", new Decimal(cash)]]),
    positions: new Map(held.map(([id, q]) => [id, { securityId: id, quantity: new Decimal(q), avgCostNative: new Decimal(10), currency: "GBP" as const }])),
    fxRates: new Map(),
    baseCurrency: "GBP",
    date: "2026-10-19",
    securityMeta: meta,
    investableUniverse: new Set(["a", "b", "c"]),
  });
  const t = (securityId: string, side: ProposedTrade["side"], q: number): ProposedTrade =>
    ({ securityId, side, quantity: new Decimal(q), price: new Decimal(10), currency: "GBP" }) as ProposedTrade;

  it("is clean when every order fits", () => {
    const r = simulateBasket(LONG_ONLY, ctx(100000), [
      { key: 1, trade: t("a", "buy", 500) }, { key: 2, trade: t("b", "buy", 500) },
    ], prices);
    expect(r.clean).toBe(true);
  });

  it("checks each order against the book the earlier ones leave", () => {
    // Each order is £6,000 against £10,000 of cash: the first fits, the second does not.
    const r = simulateBasket(LONG_ONLY, ctx(10000), [
      { key: 1, trade: t("a", "buy", 600) }, { key: 2, trade: t("b", "buy", 600) },
    ], prices);
    expect(r.results[0].hard).toHaveLength(0);
    expect(r.results[1].hard.some((v) => v.constraintId === "solvency")).toBe(true);
    expect(r.clean).toBe(false);
  });

  it("checks sales first, so a trim can fund a purchase listed before it", () => {
    // £2,000 cash; sell £6,000 of C to buy £6,000 of A. Listed buy-first.
    const r = simulateBasket(LONG_ONLY, ctx(2000, [["c", 800]]), [
      { key: 1, trade: t("a", "buy", 600) }, { key: 2, trade: t("c", "sell", 600) },
    ], prices);
    expect(r.results.map((x) => x.trade.side)).toEqual(["sell", "buy"]);
    expect(r.results.find((x) => x.key === 1)!.hard).toHaveLength(0);
  });

  it("is not clean if any single order has a soft breach", () => {
    // 1,500 shares at £10 = 15% of NAV, over the 10% soft position cap.
    const r = simulateBasket(LONG_ONLY, ctx(100000), [
      { key: 1, trade: t("a", "buy", 100) }, { key: 2, trade: t("b", "buy", 1500) },
    ], prices);
    expect(r.results.find((x) => x.key === 2)!.soft.length).toBeGreaterThan(0);
    expect(r.clean).toBe(false);
  });

  it("is not clean if an order cannot be checked", () => {
    const r = simulateBasket(LONG_ONLY, ctx(100000), [{ key: 1, trade: t("zzz", "buy", 1) }], prices);
    expect(r.results[0].error).toBeTruthy();
    expect(r.clean).toBe(false);
  });
});

// ---------------------------------------------------------------------------
import { orderMayFillAtOpen } from "../src/lib/basket";

describe("orderMayFillAtOpen — no look-ahead", () => {
  const open = new Date("2026-10-19T07:00:00Z"); // London 08:00 BST

  it("fills an order placed overnight at the next open", () => {
    expect(orderMayFillAtOpen(new Date("2026-10-18T21:00:00Z"), open, "2026-10-19")).toBe(true);
  });

  it("fills an order placed just before the open", () => {
    expect(orderMayFillAtOpen(new Date("2026-10-19T06:59:00Z"), open, "2026-10-19")).toBe(true);
  });

  it("refuses this morning's open for an order placed during the session", () => {
    // Placed at 10:00 London. The 08:00 open is already known — look-ahead.
    expect(orderMayFillAtOpen(new Date("2026-10-19T09:00:00Z"), open, "2026-10-19")).toBe(false);
  });

  it("without a session time, requires the order to predate the day", () => {
    expect(orderMayFillAtOpen(new Date("2026-10-18T21:00:00Z"), null, "2026-10-19")).toBe(true);
    expect(orderMayFillAtOpen(new Date("2026-10-19T06:00:00Z"), null, "2026-10-19")).toBe(false);
  });
});
