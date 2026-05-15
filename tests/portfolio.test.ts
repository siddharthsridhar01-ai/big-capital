/**
 * Pure aggregation tests for portfolio state computation.
 *
 * Tests the pure function `aggregatePortfolioFromTransactions` which takes
 * raw transactions + metadata + prices and returns portfolio state.
 * No DB mocking required.
 */

import { describe, it, expect } from "vitest";
import {
  aggregatePortfolioFromTransactions,
  type RawTransaction,
  type SecurityMeta,
} from "@/lib/portfolio";

// Test fixtures
const AZN: SecurityMeta = {
  id: "sec_azn",
  ticker: "AZN",
  name: "AstraZeneca PLC",
  exchange: "LSE",
  currency: "GBP",
  gicsSector: "Health Care",
};

const SHEL: SecurityMeta = {
  id: "sec_shel",
  ticker: "SHEL",
  name: "Shell PLC",
  exchange: "LSE",
  currency: "GBP",
  gicsSector: "Energy",
};

const AAPL: SecurityMeta = {
  id: "sec_aapl",
  ticker: "AAPL",
  name: "Apple Inc",
  exchange: "NASDAQ",
  currency: "USD",
  gicsSector: "Information Technology",
};

const SECURITIES = [AZN, SHEL, AAPL];

const PRICES = new Map([
  ["sec_azn", { close: "105.40", date: "2026-05-15" }],
  ["sec_shel", { close: "28.10", date: "2026-05-15" }],
  ["sec_aapl", { close: "224.50", date: "2026-05-15" }],
]);

// Helpers for building transactions
function buy(secId: string, qty: number, price: number, daysAgo = 1): RawTransaction {
  return {
    securityId: secId,
    quantity: qty.toString(),
    price: price.toString(),
    currency: "GBP",
    cashImpact: (-qty * price).toString(),
    fxRateToBase: "1",
    executedAt: new Date(Date.now() - daysAgo * 86400000),
  };
}

function sell(secId: string, qty: number, price: number, daysAgo = 0): RawTransaction {
  return {
    securityId: secId,
    quantity: (-qty).toString(),
    price: price.toString(),
    currency: "GBP",
    cashImpact: (qty * price).toString(),
    fxRateToBase: "1",
    executedAt: new Date(Date.now() - daysAgo * 86400000),
  };
}

function short(secId: string, qty: number, price: number, daysAgo = 1): RawTransaction {
  return {
    securityId: secId,
    quantity: (-qty).toString(),
    price: price.toString(),
    currency: "GBP",
    cashImpact: (qty * price).toString(),
    fxRateToBase: "1",
    executedAt: new Date(Date.now() - daysAgo * 86400000),
  };
}

function cover(secId: string, qty: number, price: number, daysAgo = 0): RawTransaction {
  return {
    securityId: secId,
    quantity: qty.toString(),
    price: price.toString(),
    currency: "GBP",
    cashImpact: (-qty * price).toString(),
    fxRateToBase: "1",
    executedAt: new Date(Date.now() - daysAgo * 86400000),
  };
}

describe("aggregatePortfolioFromTransactions", () => {
  it("empty fund: NAV = starting, 100% cash", () => {
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [],
      SECURITIES,
      PRICES
    );
    expect(state.navBase.toString()).toBe("100000");
    expect(state.cashBase.toString()).toBe("100000");
    expect(state.positions.size).toBe(0);
    expect(state.grossExposure.toString()).toBe("0");
  });

  it("single buy: position recorded, cash reduced", () => {
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [buy("sec_azn", 100, 105.4)],
      SECURITIES,
      PRICES
    );
    expect(state.positions.size).toBe(1);
    const pos = state.positions.get("sec_azn");
    expect(pos?.quantity.toNumber()).toBe(100);
    expect(pos?.avgCostNative.toNumber()).toBe(105.4);
    expect(state.cashBase.toNumber()).toBeCloseTo(89460, 2);
  });

  it("two buys: weighted average cost", () => {
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [buy("sec_azn", 50, 100, 2), buy("sec_azn", 50, 120, 1)],
      SECURITIES,
      PRICES
    );
    const pos = state.positions.get("sec_azn");
    expect(pos?.quantity.toNumber()).toBe(100);
    expect(pos?.avgCostNative.toNumber()).toBeCloseTo(110, 6);
  });

  it("partial sell: position reduces, P&L realised", () => {
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [buy("sec_azn", 100, 100, 2), sell("sec_azn", 40, 120, 1)],
      SECURITIES,
      PRICES
    );
    const pos = state.positions.get("sec_azn");
    expect(pos?.quantity.toNumber()).toBe(60);
    expect(pos?.realisedPnlBase.toNumber()).toBeCloseTo(800, 2);
    // Avg cost on remaining 60 should still be 100
    expect(pos?.avgCostNative.toNumber()).toBeCloseTo(100, 6);
  });

  it("full close: position removed entirely", () => {
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [buy("sec_azn", 100, 100, 2), sell("sec_azn", 100, 120, 1)],
      SECURITIES,
      PRICES
    );
    expect(state.positions.size).toBe(0);
  });

  it("short position: negative quantity", () => {
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [short("sec_azn", 50, 100, 1)],
      SECURITIES,
      PRICES
    );
    const pos = state.positions.get("sec_azn");
    expect(pos?.quantity.toNumber()).toBe(-50);
    expect(pos?.avgCostNative.toNumber()).toBe(100);
  });

  it("short then cover: P&L on the closed short, position cleared", () => {
    // Short 50 @ £120, cover 50 @ £100 = £20 × 50 = £1000 profit
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [short("sec_azn", 50, 120, 2), cover("sec_azn", 50, 100, 1)],
      SECURITIES,
      PRICES
    );
    expect(state.positions.size).toBe(0);
    // Cash: 100000 + 6000 (short proceeds) - 5000 (cover) = 101000
    expect(state.cashBase.toNumber()).toBeCloseTo(101000, 2);
  });

  it("two positions: NAV preserved, sectors aggregated", () => {
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [buy("sec_azn", 100, 105.4, 2), buy("sec_shel", 100, 28.1, 1)],
      SECURITIES,
      PRICES
    );
    expect(state.positions.size).toBe(2);
    // Cash = 100,000 - 10,540 - 2,810 = 86,650
    expect(state.cashBase.toNumber()).toBeCloseTo(86650, 2);
    // NAV = cash + market values at PRICES (same as cost here) = 100,000
    expect(state.navBase.toNumber()).toBeCloseTo(100000, 2);
    expect(state.sectorExposures.has("Health Care")).toBe(true);
    expect(state.sectorExposures.has("Energy")).toBe(true);
  });

  it("gross and net exposure: long-only fund has gross == net", () => {
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [buy("sec_azn", 100, 105.4)],
      SECURITIES,
      PRICES
    );
    expect(state.grossExposure.toNumber()).toBeGreaterThan(0);
    expect(state.grossExposure.toNumber()).toBeCloseTo(
      state.netExposure.toNumber(),
      6
    );
  });

  it("long + short: gross > |net|", () => {
    // Long 50 AZN @ £105.40, short 100 SHEL @ £28.10
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [buy("sec_azn", 50, 105.4, 2), short("sec_shel", 100, 28.1, 1)],
      SECURITIES,
      PRICES
    );
    expect(state.positions.size).toBe(2);
    expect(state.grossExposure.toNumber()).toBeGreaterThan(
      Math.abs(state.netExposure.toNumber())
    );
  });

  it("asOfDate filter: only includes txns up to date", () => {
    const dayBeforeNow = new Date(Date.now() - 86400000 * 1.5);
    const state = aggregatePortfolioFromTransactions(
      "GBP",
      "100000",
      [buy("sec_azn", 50, 100, 2), buy("sec_azn", 50, 120, 1)],
      SECURITIES,
      PRICES,
      dayBeforeNow
    );
    // Only the txn from 2 days ago should be included
    const pos = state.positions.get("sec_azn");
    expect(pos?.quantity.toNumber()).toBe(50);
    expect(pos?.avgCostNative.toNumber()).toBe(100);
  });
});
