/**
 * A long-only fund cannot spend cash it does not hold.
 *
 * This was unenforced: the only cash rule was min_cash_pct, a SOFT buffer, so a
 * written justification was enough to let a 100k fund buy 1.2m of stock and run
 * cash at -748% of NAV. A limit that can be typed past is not a limit.
 *
 * The check lives in checkTrade rather than in fund_constraints so it cannot be
 * softened, switched off, or forgotten when a new fund is seeded.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  checkTrade,
  type FundConstraint,
  type ProposedTrade,
  type PortfolioContext,
} from "@/lib/constraints";

const SEC = "sec_azn";

function ctx(cash: number, overrides?: Partial<PortfolioContext>): PortfolioContext {
  return {
    navBase: new Decimal(100000),
    cashByCurrency: new Map([["GBP", new Decimal(cash)]]),
    positions: new Map(),
    fxRates: new Map(),
    baseCurrency: "GBP",
    date: "2026-05-15",
    securityMeta: new Map([[SEC, { ticker: "AZN", sector: "Health Care", currency: "GBP" }]]),
    investableUniverse: new Set([SEC]),
    ...overrides,
  };
}

/** Prices for the post-trade book; only the traded security is held here. */
const PRICES = new Map([[SEC, new Decimal(58.76)]]);

function trade(qty: number, price: number): ProposedTrade {
  return {
    securityId: SEC,
    side: "buy",
    quantity: new Decimal(qty),
    price: new Decimal(price),
    currency: "GBP",
  } as ProposedTrade;
}

const LONG_ONLY: FundConstraint[] = [
  { id: "c1", constraintType: "long_only", value: true, isHard: true },
  // Deliberately SOFT, exactly as the live funds have it.
  { id: "c2", constraintType: "min_cash_pct", value: 0.02, isHard: false },
];

describe("solvency", () => {
  it("blocks a buy that would take cash negative", () => {
    const r = checkTrade(LONG_ONLY, trade(20000, 58.76), ctx(100000), PRICES);
    expect(r.pass).toBe(false);
    expect(r.hardViolations.some((v) => v.constraintId === "solvency")).toBe(true);
  });

  it("cannot be overridden, because the breach is HARD", () => {
    // The justification box only clears soft violations. This must not appear there.
    const r = checkTrade(LONG_ONLY, trade(20000, 58.76), ctx(100000), PRICES);
    expect(r.softViolations.some((v) => v.constraintId === "solvency")).toBe(false);
  });

  it("names the affordable size so the PM can correct it", () => {
    const r = checkTrade(LONG_ONLY, trade(20000, 50), ctx(100000), PRICES);
    const v = r.hardViolations.find((x) => x.constraintId === "solvency")!;
    expect(v.message).toContain("2000 shares"); // 100000 / 50
  });

  it("allows a trade that exactly spends the cash", () => {
    const r = checkTrade(LONG_ONLY, trade(2000, 50), ctx(100000), PRICES);
    expect(r.hardViolations.some((v) => v.constraintId === "solvency")).toBe(false);
  });

  it("allows an affordable trade well inside cash", () => {
    const r = checkTrade(LONG_ONLY, trade(100, 50), ctx(100000), PRICES);
    expect(r.pass).toBe(true);
  });

  it("does not block a SELL, which raises cash", () => {
    const t = { ...trade(5000, 50), side: "sell" } as ProposedTrade;
    const r = checkTrade(LONG_ONLY, t, ctx(0), PRICES);
    expect(r.hardViolations.some((v) => v.constraintId === "solvency")).toBe(false);
  });

  it("leaves non-long-only funds alone, since they fund positions differently", () => {
    // No long_only constraint means the fund may use leverage; gross and net
    // exposure limits govern it instead, so solvency must not fire here.
    const ls: FundConstraint[] = [
      { id: "c1", constraintType: "universe_only", value: true, isHard: true },
    ];
    const r = checkTrade(ls, trade(20000, 58.76), ctx(100000), PRICES);
    expect(r.hardViolations.some((v) => v.constraintId === "solvency")).toBe(false);
  });
});

describe("concentration limits block rather than warn", () => {
  const HARD_POSITION: FundConstraint[] = [
    { id: "c1", constraintType: "long_only", value: true, isHard: true },
    { id: "c2", constraintType: "max_position_pct", value: 0.08, isHard: true },
  ];

  it("blocks a buy that would exceed the position cap", () => {
    // 1,000 shares at 58.76 = 58,760 on a 100,000 NAV = 58.8%, well over 8%.
    const r = checkTrade(HARD_POSITION, trade(1000, 58.76), ctx(100000), PRICES);
    expect(r.pass).toBe(false);
    expect(r.hardViolations.some((v) => v.constraintType === "max_position_pct")).toBe(true);
  });

  it("does not offer the breach as something a justification can clear", () => {
    const r = checkTrade(HARD_POSITION, trade(1000, 58.76), ctx(100000), PRICES);
    expect(r.softViolations.some((v) => v.constraintType === "max_position_pct")).toBe(false);
  });

  it("allows a trade inside the cap", () => {
    // 100 shares at 58.76 = 5,876 = 5.9% of NAV.
    const r = checkTrade(HARD_POSITION, trade(100, 58.76), ctx(100000), PRICES);
    expect(r.pass).toBe(true);
  });
});
