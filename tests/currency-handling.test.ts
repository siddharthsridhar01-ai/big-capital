/**
 * Multi-currency handling.
 *
 * Three failures, each found on launch day:
 *   - Swiss franc prices displayed as "$", because sixteen ternaries knew only
 *     pounds and euros.
 *   - The trade preview valued a krone at par with a pound, because a missing
 *     fallback rate was silently replaced with 1.
 *   - The compliance check was given a rate for the trade's currency only, so a
 *     fund already holding euros could not buy a Swiss stock.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { CURRENCIES, CURRENCY_SYMBOL, FALLBACK_PER_EUR, currencySymbol } from "../src/lib/currency";
import { checkTrade, type FundConstraint, type ProposedTrade, type PortfolioContext } from "../src/lib/constraints";
import { aggregatePortfolioFromTransactions, staticFxFallback, type RawTransaction } from "../src/lib/portfolio";

describe("currency symbols", () => {
  it("shows the Swiss franc and Nordic currencies by code, not as dollars", () => {
    expect(currencySymbol("CHF")).toBe("CHF ");
    expect(currencySymbol("DKK")).toBe("DKK ");
    expect(currencySymbol("SEK")).toBe("SEK ");
    expect(currencySymbol("NOK")).toBe("NOK ");
  });
  it("keeps the familiar symbols", () => {
    expect(currencySymbol("GBP")).toBe("£");
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("USD")).toBe("$");
  });
  it("never guesses dollars for a currency it does not know", () => {
    expect(currencySymbol("PLN")).toBe("PLN ");
    expect(currencySymbol("PLN")).not.toBe("$");
  });
  it("has a symbol and a fallback rate for every supported currency", () => {
    for (const c of CURRENCIES) {
      expect(CURRENCY_SYMBOL[c], c).toBeTruthy();
      expect(FALLBACK_PER_EUR[c], c).toBeGreaterThan(0);
    }
  });
  it("can convert between any two supported currencies without throwing", () => {
    for (const a of CURRENCIES) for (const b of CURRENCIES) {
      expect(() => staticFxFallback(a, b), `${a}->${b}`).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
describe("compliance check with several currencies in the book", () => {
  const DATE = "2026-10-19";
  const SAP = "sec_sap";
  const UBS = "sec_ubs";
  const LONG_ONLY: FundConstraint[] = [
    { id: "c1", constraintType: "long_only", value: true, isHard: true },
    { id: "c2", constraintType: "max_position_pct", value: 0.08, isHard: false },
  ];
  // A pound fund that has already bought euro stock: long SAP, short euro cash.
  const ctx = (fx: Map<string, string>): PortfolioContext => ({
    navBase: new Decimal(100000),
    cashByCurrency: new Map([["GBP", new Decimal(95000)], ["EUR", new Decimal(-5800)]]),
    positions: new Map([[SAP, { securityId: SAP, quantity: new Decimal(25), avgCostNative: new Decimal(232), currency: "EUR" }]]),
    fxRates: fx,
    baseCurrency: "GBP",
    date: DATE,
    securityMeta: new Map([
      [SAP, { ticker: "SAP", sector: "Information Technology", currency: "EUR" }],
      [UBS, { ticker: "UBSG", sector: "Financials", currency: "CHF" }],
    ]),
    investableUniverse: new Set([SAP, UBS]),
  });
  const buyUbs: ProposedTrade = {
    securityId: UBS, side: "buy", quantity: new Decimal(100), price: new Decimal(30), currency: "CHF",
  } as ProposedTrade;
  const prices = new Map([[SAP, new Decimal(232)], [UBS, new Decimal(30)]]);

  it("fails when given only the trade's own currency — the launch-day bug", () => {
    const onlyChf = new Map([[`CHF/GBP/${DATE}`, "0.89"]]);
    expect(() => checkTrade(LONG_ONLY, buyUbs, ctx(onlyChf), prices)).toThrow(/No FX rate EUR->GBP/);
  });

  it("succeeds once every currency in the book has a rate", () => {
    const all = new Map([[`CHF/GBP/${DATE}`, "0.89"], [`EUR/GBP/${DATE}`, "0.86"]]);
    const r = checkTrade(LONG_ONLY, buyUbs, ctx(all), prices);
    expect(r.hardViolations.some((v) => v.constraintId === "solvency")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("valuing the live portfolio at current rates", () => {
  const meta = [{ id: "sap", ticker: "SAP", name: "SAP", exchange: "XETRA", currency: "EUR" as const, gicsSector: "Information Technology" }];
  // Bought 100 SAP at €200 when €1 = £0.86, so euro cash is -€20,000.
  const txns: RawTransaction[] = [{
    transactionType: "buy", securityId: "sap", quantity: "100", price: "200", currency: "EUR",
    cashImpact: "-20000", fxRateToBase: "0.86", executedAt: new Date("2026-10-19T07:00:00Z"),
  }];
  const priceMap = new Map([["sap", { close: "200", date: "2026-10-20" }]]);

  it("offsets a euro holding against the euro cash that paid for it", () => {
    // The euro moves to £0.90; the shares are unchanged at €200. A fund long euro
    // shares and short euro cash has no net currency exposure, so NAV must not move.
    const state = aggregatePortfolioFromTransactions(
      "GBP", "100000", txns, meta, priceMap, undefined, new Map([["EUR", new Decimal("0.90")]])
    );
    expect(state.navBase.toNumber()).toBeCloseTo(100000, 6);
  });

  it("values the holding at today's rate, not the day it was bought", () => {
    const state = aggregatePortfolioFromTransactions(
      "GBP", "100000", txns, meta, priceMap, undefined, new Map([["EUR", new Decimal("0.90")]])
    );
    expect(state.positions.get("sap")!.marketValueBase!.toNumber()).toBeCloseTo(18000, 6);
  });
});
