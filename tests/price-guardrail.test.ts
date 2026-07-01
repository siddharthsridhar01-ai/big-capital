import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { checkPriceSanity } from "../src/lib/price-guardrail";

const D = (n: string | number) => new Decimal(n);

describe("checkPriceSanity", () => {
  it("passes a normal price near the last close", () => {
    const r = checkPriceSanity(D("4.58"), D("4.55"));
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(true);
  });

  it("allows genuine large moves within the wide band", () => {
    expect(checkPriceSanity(D("150"), D("100")).ok).toBe(true); // +50%
    expect(checkPriceSanity(D("60"), D("100")).ok).toBe(true); // -40%
  });

  it("blocks a pence/pounds unit error (~100x the reference)", () => {
    // AZN real ~£105; a pence value would come through as ~10540
    const r = checkPriceSanity(D("10540"), D("105.40"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unit|pence|symbol/i);
  });

  it("blocks a collapse to a tiny fraction (wrong symbol / bad quote)", () => {
    const r = checkPriceSanity(D("1.05"), D("105.40"));
    expect(r.ok).toBe(false);
  });

  it("blocks non-positive or non-finite execution prices", () => {
    expect(checkPriceSanity(D("0"), D("100")).ok).toBe(false);
    expect(checkPriceSanity(D("-5"), D("100")).ok).toBe(false);
  });

  it("passes (unchecked) when there is no reference close", () => {
    const r = checkPriceSanity(D("50"), null);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(false);
  });

  it("passes (unchecked) when the reference is invalid", () => {
    expect(checkPriceSanity(D("50"), D("0")).checked).toBe(false);
  });

  it("respects custom thresholds", () => {
    // Tighter band: 2x / 0.5x
    expect(checkPriceSanity(D("250"), D("100"), { maxRatio: 2 }).ok).toBe(false);
    expect(checkPriceSanity(D("150"), D("100"), { maxRatio: 2 }).ok).toBe(true);
  });
});
