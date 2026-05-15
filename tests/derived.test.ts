import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  computeDailyChange,
  computeUnrealisedPnL,
} from "@/lib/derived";

describe("computeDailyChange", () => {
  it("up move: positive absolute and percentage, direction 'up'", () => {
    const r = computeDailyChange("105.40", "104.55")!;
    expect(r.direction).toBe("up");
    expect(r.absoluteNative.toNumber()).toBeCloseTo(0.85, 4);
    expect(r.percentage.toNumber()).toBeCloseTo(0.00813, 4);
  });

  it("down move: negative absolute and percentage, direction 'down'", () => {
    const r = computeDailyChange("100", "105")!;
    expect(r.direction).toBe("down");
    expect(r.absoluteNative.toNumber()).toBeCloseTo(-5, 4);
    expect(r.percentage.toNumber()).toBeCloseTo(-0.04762, 4);
  });

  it("flat: zero values, direction 'flat'", () => {
    const r = computeDailyChange("100", "100")!;
    expect(r.direction).toBe("flat");
    expect(r.absoluteNative.toNumber()).toBe(0);
  });

  it("no previous close: returns null", () => {
    expect(computeDailyChange("100", null)).toBeNull();
    expect(computeDailyChange("100", undefined)).toBeNull();
  });

  it("zero previous close: returns null (avoids div by zero)", () => {
    expect(computeDailyChange("100", "0")).toBeNull();
  });
});

describe("computeUnrealisedPnL", () => {
  it("long position: gain", () => {
    // Bought 100 @ £100, now £120 → +£2,000, +20%
    const r = computeUnrealisedPnL(100, 100, 120, 1)!;
    expect(r.direction).toBe("up");
    expect(r.amountBase.toNumber()).toBeCloseTo(2000, 2);
    expect(r.returnPct.toNumber()).toBeCloseTo(0.2, 4);
  });

  it("long position: loss", () => {
    const r = computeUnrealisedPnL(50, 100, 90, 1)!;
    expect(r.direction).toBe("down");
    expect(r.amountBase.toNumber()).toBeCloseTo(-500, 2);
    expect(r.returnPct.toNumber()).toBeCloseTo(-0.1, 4);
  });

  it("short position: gain when price drops", () => {
    // Short 50 @ £120, now £100 → +£1,000
    const r = computeUnrealisedPnL(-50, 120, 100, 1)!;
    expect(r.direction).toBe("up");
    expect(r.amountBase.toNumber()).toBeCloseTo(1000, 2);
  });

  it("short position: loss when price rises", () => {
    const r = computeUnrealisedPnL(-50, 100, 120, 1)!;
    expect(r.direction).toBe("down");
    expect(r.amountBase.toNumber()).toBeCloseTo(-1000, 2);
  });

  it("FX applied to base currency conversion", () => {
    // Long 100 AAPL @ $200, now $250 → +$5,000. FX 0.79 USD→GBP → +£3,950
    const r = computeUnrealisedPnL(100, 200, 250, 0.79)!;
    expect(r.amountBase.toNumber()).toBeCloseTo(3950, 2);
  });

  it("no current price: returns null", () => {
    expect(computeUnrealisedPnL(100, 100, null)).toBeNull();
  });

  it("zero P&L: direction 'flat'", () => {
    const r = computeUnrealisedPnL(100, 100, 100, 1)!;
    expect(r.direction).toBe("flat");
    expect(r.amountBase.toNumber()).toBe(0);
  });
});
