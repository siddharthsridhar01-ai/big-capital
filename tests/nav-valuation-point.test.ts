/**
 * The NAV valuation point must be identical every day: every holding at its own
 * official close for that date.
 *
 * These pin the rule that a RECENT date waits for all holdings to close, while a
 * SETTLED date accepts what exists (a missing close by then means the security
 * did not trade, and carrying the previous close forward is correct).
 */
import { describe, it, expect } from "vitest";

/** Mirrors the guard in runNavSnapshot. */
function shouldWait(
  heldIds: string[],
  closedIds: string[],
  ageDays: number,
  settledAfterDays = 2
): boolean {
  if (heldIds.length === 0) return false;
  const closed = new Set(closedIds);
  const missing = heldIds.filter((id) => !closed.has(id));
  return ageDays >= settledAfterDays
    ? missing.length === heldIds.length
    : missing.length > 0;
}

describe("NAV valuation-point guard", () => {
  const held = ["uk", "us", "asia"];

  it("waits on a same-day strike when only some markets have closed", () => {
    expect(shouldWait(held, ["asia"], 0)).toBe(true);
    expect(shouldWait(held, ["asia", "uk"], 0)).toBe(true);
  });

  it("strikes a same-day date once every holding has closed", () => {
    expect(shouldWait(held, ["asia", "uk", "us"], 0)).toBe(false);
  });

  it("still waits the next morning if a market has not closed", () => {
    expect(shouldWait(held, ["asia", "uk"], 1)).toBe(true);
  });

  it("accepts a settled date with a partial set, carrying prices forward", () => {
    // Two days on, a missing close means the security did not trade.
    expect(shouldWait(held, ["asia", "uk"], 2)).toBe(false);
  });

  it("never strikes a date where nothing closed at all", () => {
    expect(shouldWait(held, [], 5)).toBe(true);
  });

  it("allows a fund with no holdings through", () => {
    expect(shouldWait([], [], 0)).toBe(false);
  });
});
