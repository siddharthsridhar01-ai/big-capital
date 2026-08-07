/**
 * Standing-book limit utilisation.
 *
 * The dashboard "Limits" panel and the trade blocker must not disagree, so both
 * read the same constraint rows and share the same weighting helpers. These
 * tests pin the utilisation maths, including the case that motivated the panel:
 * a fund sitting well over its cash ceiling with no trade in flight.
 */

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  evaluateBookLimits,
  type FundConstraint,
  type PortfolioContext,
} from "@/lib/constraints";

const SEC_A = "sec_a";
const SEC_B = "sec_b";

function ctx(overrides?: Partial<PortfolioContext>): PortfolioContext {
  return {
    navBase: new Decimal(100000),
    cashByCurrency: new Map([["GBP", new Decimal(60000)]]),
    positions: new Map([
      [SEC_A, { securityId: SEC_A, quantity: new Decimal(1000) }],
      [SEC_B, { securityId: SEC_B, quantity: new Decimal(1000) }],
    ]) as PortfolioContext["positions"],
    fxRates: new Map(),
    baseCurrency: "GBP",
    date: "2026-08-07",
    securityMeta: new Map([
      [SEC_A, { ticker: "AAA", sector: "Financials", currency: "GBP" }],
      [SEC_B, { ticker: "BBB", sector: "Energy", currency: "GBP" }],
    ]),
    investableUniverse: new Set([SEC_A, SEC_B]),
    ...overrides,
  };
}

// AAA 1000 @ 30 = 30,000 (30%); BBB 1000 @ 10 = 10,000 (10%)
const prices = new Map([
  [SEC_A, new Decimal(30)],
  [SEC_B, new Decimal(10)],
]);

const constraints: FundConstraint[] = [
  { id: "c1", constraintType: "max_position_pct", value: 0.08, isHard: false },
  { id: "c2", constraintType: "max_cash_pct", value: 0.2, isHard: false },
  { id: "c3", constraintType: "max_single_sector_pct", value: 0.35, isHard: false },
  { id: "c4", constraintType: "max_position_count", value: 40, isHard: false },
];

describe("evaluateBookLimits", () => {
  const rows = evaluateBookLimits(constraints, ctx(), prices);
  const byType = (t: string) => rows.find((r) => r.constraintType === t)!;

  it("flags a cash ceiling breach with no trade in flight", () => {
    const cash = byType("max_cash_pct");
    expect(cash.current).toBeCloseTo(0.6, 6);
    expect(cash.limit).toBe(0.2);
    expect(cash.breached).toBe(true);
    expect(cash.utilisation).toBe(1); // clamped for the bar
  });

  it("reports the largest position and names it", () => {
    const pos = byType("max_position_pct");
    expect(pos.current).toBeCloseTo(0.3, 6);
    expect(pos.detail).toBe("AAA");
    expect(pos.breached).toBe(true);
  });

  it("reports the largest sector, not the sum of sectors", () => {
    const sec = byType("max_single_sector_pct");
    expect(sec.current).toBeCloseTo(0.3, 6);
    expect(sec.detail).toBe("Financials");
    expect(sec.breached).toBe(false); // 30% < 35%
  });

  it("counts only non-zero positions and reports utilisation below the cap", () => {
    const n = byType("max_position_count");
    expect(n.current).toBe(2);
    expect(n.limit).toBe(40);
    expect(n.breached).toBe(false);
    expect(n.utilisation).toBeCloseTo(0.05, 6);
    expect(n.isPct).toBe(false);
  });

  it("treats a cash floor as breached when undershot", () => {
    const floor: FundConstraint[] = [
      { id: "c5", constraintType: "min_cash_pct", value: 0.02, isHard: false },
    ];
    const lowCash = ctx({ cashByCurrency: new Map([["GBP", new Decimal(500)]]) });
    const r = evaluateBookLimits(floor, lowCash, prices)[0];
    expect(r.current).toBeCloseTo(0.005, 6);
    expect(r.breached).toBe(true);
  });

  it("ignores boolean rules that cannot be partially used", () => {
    const bools: FundConstraint[] = [
      { id: "c6", constraintType: "long_only", value: true, isHard: true },
      { id: "c7", constraintType: "universe_only", value: true, isHard: true },
    ];
    expect(evaluateBookLimits(bools, ctx(), prices)).toHaveLength(0);
  });
});
