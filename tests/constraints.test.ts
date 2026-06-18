/**
 * Constraint engine tests.
 *
 * Verifies each constraint type both passes when state is within limits and
 * produces the right violation (with correct hard/soft flag) when breached.
 */

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  checkTrade,
  type FundConstraint,
  type ProposedTrade,
  type PortfolioContext,
} from "@/lib/constraints";

// Helpers -------------------------------------------------------------------

const SEC_AZN = "sec_azn";
const SEC_SHEL = "sec_shel";
const SEC_AAPL = "sec_aapl";
const SEC_NOT_IN_UNIV = "sec_not_in_univ";

function makeCtx(overrides?: Partial<PortfolioContext>): PortfolioContext {
  return {
    navBase: new Decimal(100000),
    cashByCurrency: new Map([["GBP", new Decimal(100000)]]),
    positions: new Map(),
    fxRates: new Map(),
    baseCurrency: "GBP",
    date: "2026-05-15",
    securityMeta: new Map([
      [SEC_AZN, { ticker: "AZN", sector: "Health Care", currency: "GBP" }],
      [SEC_SHEL, { ticker: "SHEL", sector: "Energy", currency: "GBP" }],
      [SEC_AAPL, { ticker: "AAPL", sector: "IT", currency: "USD" }],
      [SEC_NOT_IN_UNIV, { ticker: "XYZ", sector: "Misc", currency: "GBP" }],
    ]),
    investableUniverse: new Set([SEC_AZN, SEC_SHEL, SEC_AAPL]),
    ...overrides,
  };
}

function makeTrade(overrides?: Partial<ProposedTrade>): ProposedTrade {
  return {
    securityId: SEC_AZN,
    side: "buy",
    quantity: new Decimal(10),
    price: new Decimal(105.4),
    currency: "GBP",
    ...overrides,
  };
}

function constraint(
  type: FundConstraint["constraintType"],
  value: unknown,
  isHard: boolean
): FundConstraint {
  return { id: `c_${type}`, constraintType: type, value, isHard };
}

// Prices map for evaluating post-trade NAV
const PRICES = new Map<string, Decimal>([
  [SEC_AZN, new Decimal(105.4)],
  [SEC_SHEL, new Decimal(28.1)],
  [SEC_AAPL, new Decimal(224.5)],
  [SEC_NOT_IN_UNIV, new Decimal(50)],
]);

// ---------------------------------------------------------------------------

describe("universe_only", () => {
  it("blocks buying a security outside the universe", () => {
    const ctx = makeCtx();
    const trade = makeTrade({ securityId: SEC_NOT_IN_UNIV });
    const result = checkTrade(
      [constraint("universe_only", true, true)],
      trade,
      ctx,
      PRICES
    );
    expect(result.pass).toBe(false);
    expect(result.hardViolations).toHaveLength(1);
    expect(result.hardViolations[0].constraintType).toBe("universe_only");
  });

  it("allows buying a security inside the universe", () => {
    const result = checkTrade(
      [constraint("universe_only", true, true)],
      makeTrade(),
      makeCtx(),
      PRICES
    );
    expect(result.pass).toBe(true);
    expect(result.hardViolations).toHaveLength(0);
  });

  it("allows selling a security outside the universe (close-out)", () => {
    const ctx = makeCtx({
      positions: new Map([
        [
          SEC_NOT_IN_UNIV,
          {
            securityId: SEC_NOT_IN_UNIV,
            quantity: new Decimal(5),
            avgCostNative: new Decimal(50),
            currency: "GBP",
          },
        ],
      ]),
    });
    const result = checkTrade(
      [constraint("universe_only", true, true)],
      makeTrade({ securityId: SEC_NOT_IN_UNIV, side: "sell", quantity: new Decimal(5) }),
      ctx,
      PRICES
    );
    expect(result.pass).toBe(true);
  });
});

describe("long_only", () => {
  it("blocks a short trade in a long-only fund", () => {
    const result = checkTrade(
      [constraint("long_only", true, true)],
      makeTrade({ side: "short" }),
      makeCtx(),
      PRICES
    );
    expect(result.pass).toBe(false);
    expect(result.hardViolations[0].constraintType).toBe("long_only");
  });

  it("blocks oversells that would create a short position", () => {
    const ctx = makeCtx({
      positions: new Map([
        [
          SEC_AZN,
          {
            securityId: SEC_AZN,
            quantity: new Decimal(5),
            avgCostNative: new Decimal(100),
            currency: "GBP",
          },
        ],
      ]),
    });
    const result = checkTrade(
      [constraint("long_only", true, true)],
      makeTrade({ side: "sell", quantity: new Decimal(10) }), // sells more than held
      ctx,
      PRICES
    );
    expect(result.pass).toBe(false);
    expect(result.hardViolations[0].constraintType).toBe("long_only");
  });

  it("allows normal long buys", () => {
    const result = checkTrade(
      [constraint("long_only", true, true)],
      makeTrade(),
      makeCtx(),
      PRICES
    );
    expect(result.pass).toBe(true);
  });
});

describe("max_position_pct", () => {
  it("flags a soft violation when buying too much of one name", () => {
    // 100 AZN @ £105.40 = £10,540 = 10.54% of £100k NAV — above 8% limit
    const result = checkTrade(
      [constraint("max_position_pct", 0.08, false)],
      makeTrade({ quantity: new Decimal(100) }),
      makeCtx(),
      PRICES
    );
    expect(result.pass).toBe(true); // soft = pass overall
    expect(result.softViolations).toHaveLength(1);
    expect(result.softViolations[0].constraintType).toBe("max_position_pct");
  });

  it("passes when position is below the limit", () => {
    const result = checkTrade(
      [constraint("max_position_pct", 0.08, false)],
      makeTrade({ quantity: new Decimal(10) }), // ~1%
      makeCtx(),
      PRICES
    );
    expect(result.softViolations).toHaveLength(0);
  });

  it("hard-blocks when isHard=true", () => {
    const result = checkTrade(
      [constraint("max_position_pct", 0.08, true)],
      makeTrade({ quantity: new Decimal(100) }),
      makeCtx(),
      PRICES
    );
    expect(result.pass).toBe(false);
    expect(result.hardViolations).toHaveLength(1);
  });
});

describe("min_cash_pct", () => {
  it("flags when cash would drop below the floor", () => {
    // 90 AZN @ £105.40 = £9,486 spent; cash = £90,514 (90.51%)... that's fine.
    // Try a larger buy: 900 AZN @ £105.40 = £94,860 spent; cash = £5,140 (5.14%) — below 10% floor
    const result = checkTrade(
      [constraint("min_cash_pct", 0.1, false)],
      makeTrade({ quantity: new Decimal(900) }),
      makeCtx(),
      PRICES
    );
    expect(result.softViolations).toHaveLength(1);
    expect(result.softViolations[0].constraintType).toBe("min_cash_pct");
  });

  it("passes when cash stays above the floor", () => {
    const result = checkTrade(
      [constraint("min_cash_pct", 0.02, false)],
      makeTrade({ quantity: new Decimal(10) }),
      makeCtx(),
      PRICES
    );
    expect(result.softViolations).toHaveLength(0);
  });
});

describe("max_cash_pct", () => {
  it("suppresses the breach on a deploying buy while the fund is still majority cash", () => {
    // Near-empty fund (100% cash). A buy is building the book, so the
    // cash-max nudge is suppressed during deployment.
    const result = checkTrade(
      [constraint("max_cash_pct", 0.2, false)],
      makeTrade({ quantity: new Decimal(10) }), // tiny buy — cash still > 20%
      makeCtx(),
      PRICES
    );
    expect(
      result.softViolations.filter((v) => v.constraintType === "max_cash_pct")
    ).toHaveLength(0);
  });

  it("still flags cash-max once the fund is majority invested", () => {
    // Fund is mostly deployed (cash = 15% of NAV); a small buy leaves cash
    // above the 10% ceiling, so the breach fires normally.
    const result = checkTrade(
      [constraint("max_cash_pct", 0.1, false)],
      makeTrade({ quantity: new Decimal(10) }),
      makeCtx({ cashByCurrency: new Map([["GBP", new Decimal(15000)]]) }),
      PRICES
    );
    expect(result.softViolations).toHaveLength(1);
    expect(result.softViolations[0].constraintType).toBe("max_cash_pct");
  });

  it("still flags when a sell raises cash above the ceiling in a near-empty fund", () => {
    // A sell/short raises cash rather than deploying it, so suppression does
    // not apply even when the fund is majority cash.
    const result = checkTrade(
      [constraint("max_cash_pct", 0.2, false)],
      makeTrade({ side: "short", quantity: new Decimal(10) }),
      makeCtx(),
      PRICES
    );
    expect(result.softViolations[0].constraintType).toBe("max_cash_pct");
  });
});

describe("max_single_sector_pct", () => {
  it("flags when sector exposure exceeds the limit", () => {
    // 500 AZN @ £105.40 = £52,700 = 52.7% — way above 35% sector limit (Health Care)
    const result = checkTrade(
      [constraint("max_single_sector_pct", 0.35, false)],
      makeTrade({ quantity: new Decimal(500) }),
      makeCtx(),
      PRICES
    );
    expect(result.softViolations).toHaveLength(1);
    expect(result.softViolations[0].constraintType).toBe(
      "max_single_sector_pct"
    );
  });

  it("aggregates across multiple positions in same sector", () => {
    // Pre-existing 200 AZN at £105.40 = £21,080 = 21% Health Care
    // Buying 200 more = 42% — above 35%
    const ctx = makeCtx({
      positions: new Map([
        [
          SEC_AZN,
          {
            securityId: SEC_AZN,
            quantity: new Decimal(200),
            avgCostNative: new Decimal(105.4),
            currency: "GBP",
          },
        ],
      ]),
      // Adjust cash to reflect existing position
      cashByCurrency: new Map([["GBP", new Decimal(78920)]]),
    });
    const result = checkTrade(
      [constraint("max_single_sector_pct", 0.35, false)],
      makeTrade({ quantity: new Decimal(200) }),
      ctx,
      PRICES
    );
    expect(result.softViolations).toHaveLength(1);
  });
});

describe("max_position_count", () => {
  it("flags when too many positions", () => {
    // Create context with 40 positions already, try to add 1 more
    const positions = new Map();
    for (let i = 0; i < 40; i++) {
      const id = `sec_filler_${i}`;
      positions.set(id, {
        securityId: id,
        quantity: new Decimal(1),
        avgCostNative: new Decimal(100),
        currency: "GBP",
      });
    }
    const ctx = makeCtx({ positions });
    const result = checkTrade(
      [constraint("max_position_count", 40, false)],
      makeTrade(), // adds the 41st position (AZN)
      ctx,
      PRICES
    );
    expect(result.softViolations).toHaveLength(1);
    expect(result.softViolations[0].constraintType).toBe("max_position_count");
  });

  it("passes when adding to an existing position (no new position)", () => {
    const positions = new Map();
    for (let i = 0; i < 39; i++) {
      const id = `sec_filler_${i}`;
      positions.set(id, {
        securityId: id,
        quantity: new Decimal(1),
        avgCostNative: new Decimal(100),
        currency: "GBP",
      });
    }
    // 40th position is AZN
    positions.set(SEC_AZN, {
      securityId: SEC_AZN,
      quantity: new Decimal(5),
      avgCostNative: new Decimal(105),
      currency: "GBP",
    });
    const ctx = makeCtx({ positions });
    const result = checkTrade(
      [constraint("max_position_count", 40, false)],
      makeTrade({ quantity: new Decimal(10) }), // add to AZN, doesn't create new
      ctx,
      PRICES
    );
    expect(result.softViolations).toHaveLength(0);
  });
});

describe("max_gross_exposure (L/S fund)", () => {
  it("flags when gross exceeds the limit", () => {
    // 1000 AZN @ £105.40 = £105,400 = 1.054x NAV > 1.0x limit (just barely)
    const ctx = makeCtx({
      // L/S fund usually has bigger NAV but we test the ratio not absolute
    });
    const result = checkTrade(
      [constraint("max_gross_exposure", 1.0, false)],
      makeTrade({ quantity: new Decimal(1000) }),
      ctx,
      PRICES
    );
    expect(result.softViolations).toHaveLength(1);
    expect(result.softViolations[0].constraintType).toBe("max_gross_exposure");
  });

  it("counts shorts in gross", () => {
    const result = checkTrade(
      [constraint("max_gross_exposure", 0.5, false)],
      makeTrade({ side: "short", quantity: new Decimal(1000) }),
      makeCtx(),
      PRICES
    );
    expect(result.softViolations).toHaveLength(1);
  });
});

describe("max_net_exposure (L/S fund)", () => {
  it("flags when net exceeds the band", () => {
    const result = checkTrade(
      [constraint("max_net_exposure", 0.2, false)], // ±20% band
      makeTrade({ quantity: new Decimal(500) }), // 52.7% net long
      makeCtx(),
      PRICES
    );
    expect(result.softViolations).toHaveLength(1);
    expect(result.softViolations[0].constraintType).toBe("max_net_exposure");
  });

  it("treats short as negative net", () => {
    const result = checkTrade(
      [constraint("max_net_exposure", 0.2, false)],
      makeTrade({ side: "short", quantity: new Decimal(500) }),
      makeCtx(),
      PRICES
    );
    expect(result.softViolations).toHaveLength(1);
  });
});

describe("combined checks", () => {
  it("returns multiple violations when a trade breaches several constraints", () => {
    // Buy 1000 AZN — breaches: max_position_pct (105%), max_single_sector_pct (105%),
    // min_cash_pct (would go negative), max_position_count if already full, etc.
    const result = checkTrade(
      [
        constraint("max_position_pct", 0.08, false),
        constraint("max_single_sector_pct", 0.35, false),
        constraint("min_cash_pct", 0.02, false),
      ],
      makeTrade({ quantity: new Decimal(1000) }),
      makeCtx(),
      PRICES
    );
    expect(result.softViolations.length).toBeGreaterThanOrEqual(2);
  });

  it("separates hard and soft violations correctly", () => {
    const result = checkTrade(
      [
        constraint("universe_only", true, true), // hard
        constraint("max_position_pct", 0.08, false), // soft
      ],
      makeTrade({ securityId: SEC_NOT_IN_UNIV, quantity: new Decimal(100) }),
      makeCtx(),
      PRICES
    );
    expect(result.hardViolations.length).toBeGreaterThan(0);
    expect(result.pass).toBe(false); // hard fails make whole check fail
  });
});
