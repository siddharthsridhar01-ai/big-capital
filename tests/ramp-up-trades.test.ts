/**
 * The cash band is not enforced on trades during the first 90 days — matching
 * the limits panel — but the solvency check is.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { checkTrade, RAMP_UP_DAYS, type FundConstraint, type PortfolioContext, type ProposedTrade } from "../src/lib/constraints";

const PX = new Map([["x", new Decimal(10)]]);
const META: PortfolioContext["securityMeta"] = new Map([["x", { ticker: "X", sector: "Industrials", currency: "GBP" }]]);
const ctx = (cash: number, days?: number): PortfolioContext => ({
  navBase: new Decimal(100000), cashByCurrency: new Map([["GBP", new Decimal(cash)]]), positions: new Map(),
  fxRates: new Map(), baseCurrency: "GBP", date: "2026-10-19", securityMeta: META, investableUniverse: new Set(["x"]),
  daysSinceInception: days,
});
const trade = (side: ProposedTrade["side"], q: number) =>
  ({ securityId: "x", side, quantity: new Decimal(q), price: new Decimal(10), currency: "GBP" }) as ProposedTrade;
const has = (r: ReturnType<typeof checkTrade>, t: string) => [...r.softViolations, ...r.hardViolations].some((v) => v.constraintType === t);

describe("cash band during ramp-up", () => {
  const LS: FundConstraint[] = [
    { id: "g", constraintType: "max_gross_exposure", value: 2, isHard: true },
    { id: "mx", constraintType: "max_cash_pct", value: 0.4, isHard: false },
  ];

  it("does not ask to justify the cash a short raises in the first 90 days", () => {
    // Shorting £50,000 lifts cash from £100,000 to £150,000 — 150% of NAV.
    expect(has(checkTrade(LS, trade("short", 5000), ctx(100000, 5), PX), "max_cash_pct")).toBe(false);
  });

  it("enforces it again once the ramp-up has passed", () => {
    expect(has(checkTrade(LS, trade("short", 5000), ctx(100000, RAMP_UP_DAYS), PX), "max_cash_pct")).toBe(true);
  });

  it("enforces it when the fund's age is unknown", () => {
    expect(has(checkTrade(LS, trade("short", 5000), ctx(100000, undefined), PX), "max_cash_pct")).toBe(true);
  });

  it("waives the cash floor too", () => {
    const floor: FundConstraint[] = [
      { id: "l", constraintType: "long_only", value: true, isHard: true },
      { id: "mn", constraintType: "min_cash_pct", value: 0.05, isHard: false },
    ];
    // Spending £98,000 of £100,000 leaves 2%, under a 5% floor.
    const r = checkTrade(floor, trade("buy", 9800), ctx(100000, 10), PX);
    expect(r.softViolations.some((v) => v.constraintType === "min_cash_pct")).toBe(false);
  });

  it("still blocks a long-only fund spending cash it does not have", () => {
    const floor: FundConstraint[] = [
      { id: "l", constraintType: "long_only", value: true, isHard: true },
      { id: "mn", constraintType: "min_cash_pct", value: 0.05, isHard: false },
    ];
    const r = checkTrade(floor, trade("buy", 20000), ctx(100000, 10), PX);
    expect(r.hardViolations.some((v) => v.constraintId === "solvency")).toBe(true);
  });
});
