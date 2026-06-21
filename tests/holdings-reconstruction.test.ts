import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  mostRecentEligibleMonthEnd,
  mostRecentEligibleQuarterEnd,
  firstDayOfMonthOf,
  buildHoldings,
  selectTop10,
  packageSnapshot,
  type HoldingRow,
} from "../src/lib/holdings-reconstruction";
import type { NavComponents, Position, Currency } from "../src/lib/performance";

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe("eligible period-ends", () => {
  it("month-end: mid-month shows the prior completed month-end", () => {
    expect(mostRecentEligibleMonthEnd(d("2026-06-21"))).toBe("2026-05-31");
  });

  it("month-end: early in the month the lag floor still hides the just-closed month", () => {
    // 5 Jun − 14d = 22 May; 31 May is newer than the cutoff, so fall back to 30 Apr
    expect(mostRecentEligibleMonthEnd(d("2026-06-05"))).toBe("2026-04-30");
  });

  it("month-end: handles year boundary", () => {
    expect(mostRecentEligibleMonthEnd(d("2026-01-20"))).toBe("2025-12-31");
  });

  it("quarter-end: mid-Q2 shows Q1 close", () => {
    expect(mostRecentEligibleQuarterEnd(d("2026-06-21"))).toBe("2026-03-31");
  });

  it("quarter-end: just after a quarter close still lags to the prior quarter", () => {
    // 5 Jul − 14d = 21 Jun; 30 Jun is newer than cutoff -> 31 Mar
    expect(mostRecentEligibleQuarterEnd(d("2026-07-05"))).toBe("2026-03-31");
  });

  it("firstDayOfMonthOf", () => {
    expect(firstDayOfMonthOf("2026-05-31")).toBe("2026-05-01");
  });
});

function pos(securityId: string, qty: number, ccy: Currency = "GBP"): Position {
  return {
    securityId,
    quantity: new Decimal(qty),
    avgCostNative: new Decimal(10),
    currency: ccy,
  };
}

describe("buildHoldings", () => {
  it("computes weights as fraction of NAV and a cash weight", () => {
    const components: NavComponents = {
      cashByCurrency: new Map([["GBP", new Decimal(4000)]]),
      positions: new Map([["s1", pos("s1", 600)]]), // 600 @ 10 = 6000
    };
    const { nav, cashWeight, holdings } = buildHoldings({
      components,
      prices: new Map([["s1", "10"]]),
      priceCurrencies: new Map([["s1", "GBP"]]),
      fxRates: new Map(),
      baseCurrency: "GBP",
      date: "2026-05-31",
      securityMeta: new Map([["s1", { ticker: "AAA", name: "Alpha", sector: "Energy" }]]),
    });
    expect(nav.toString()).toBe("10000");
    expect(holdings).toHaveLength(1);
    expect(holdings[0].weight).toBeCloseTo(0.6, 6);
    expect(holdings[0].sector).toBe("Energy");
    expect(cashWeight).toBeCloseTo(0.4, 6);
  });

  it("sorts holdings by weight descending", () => {
    const components: NavComponents = {
      cashByCurrency: new Map([["GBP", new Decimal(0)]]),
      positions: new Map([
        ["small", pos("small", 100)], // 1000
        ["big", pos("big", 500)], // 5000
      ]),
    };
    const { holdings } = buildHoldings({
      components,
      prices: new Map([
        ["small", "10"],
        ["big", "10"],
      ]),
      priceCurrencies: new Map([
        ["small", "GBP"],
        ["big", "GBP"],
      ]),
      fxRates: new Map(),
      baseCurrency: "GBP",
      date: "2026-05-31",
      securityMeta: new Map(),
    });
    expect(holdings.map((h) => h.securityId)).toEqual(["big", "small"]);
  });
});

describe("selectTop10 / packageSnapshot", () => {
  const longOnly: HoldingRow[] = Array.from({ length: 14 }, (_, i) => ({
    securityId: `s${i}`,
    ticker: `T${i}`,
    name: `Name ${i}`,
    weight: (14 - i) / 100,
    sector: "X",
  }));

  it("long-only top-10 takes the 10 largest", () => {
    const top = selectTop10(longOnly);
    expect(top).toHaveLength(10);
    expect(top[0].securityId).toBe("s0");
  });

  it("packages top10 with an 'other' rollup that excludes disclosed rows", () => {
    const payload = packageSnapshot(longOnly, 0.05, "top10");
    expect(payload.holdings).toHaveLength(10);
    expect(payload.totalHoldings).toBe(14);
    expect(payload.otherCount).toBe(4);
    expect(payload.otherWeight).toBeGreaterThan(0);
  });

  it("full snapshot keeps every holding and zero 'other'", () => {
    const payload = packageSnapshot(longOnly, 0.05, "full");
    expect(payload.holdings).toHaveLength(14);
    expect(payload.otherCount).toBe(0);
  });

  it("long/short books disclose top-5 long and top-5 short", () => {
    const ls: HoldingRow[] = [
      { securityId: "L1", ticker: "L1", name: "L1", weight: 0.08, sector: "X" },
      { securityId: "L2", ticker: "L2", name: "L2", weight: 0.06, sector: "X" },
      { securityId: "L3", ticker: "L3", name: "L3", weight: 0.05, sector: "X" },
      { securityId: "L4", ticker: "L4", name: "L4", weight: 0.04, sector: "X" },
      { securityId: "L5", ticker: "L5", name: "L5", weight: 0.03, sector: "X" },
      { securityId: "L6", ticker: "L6", name: "L6", weight: 0.02, sector: "X" },
      { securityId: "S1", ticker: "S1", name: "S1", weight: -0.07, sector: "X" },
      { securityId: "S2", ticker: "S2", name: "S2", weight: -0.05, sector: "X" },
      { securityId: "S3", ticker: "S3", name: "S3", weight: -0.03, sector: "X" },
    ];
    const top = selectTop10(ls);
    const longs = top.filter((h) => h.weight > 0);
    const shorts = top.filter((h) => h.weight < 0);
    expect(longs).toHaveLength(5);
    expect(shorts).toHaveLength(3);
    expect(longs[0].securityId).toBe("L1");
    expect(shorts[0].securityId).toBe("S1"); // most negative first
    expect(top.some((h) => h.securityId === "L6")).toBe(false); // 6th long excluded
  });
});
