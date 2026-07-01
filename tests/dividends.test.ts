import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  selectPerShareRaw,
  normalizeDividend,
  dividendCashImpact,
  shouldBookDividend,
  dividendDedupeKey,
  type RawDividend,
} from "../src/lib/dividends";

const div = (over: Partial<RawDividend>): RawDividend => ({
  date: "2026-05-15",
  value: 1.0,
  unadjustedValue: null,
  currency: "GBP",
  ...over,
});

describe("selectPerShareRaw", () => {
  it("prefers unadjustedValue (actual cash paid) over value", () => {
    expect(selectPerShareRaw(div({ value: 2.0, unadjustedValue: 0.5 }))).toBe(0.5);
  });
  it("falls back to value when unadjustedValue is null", () => {
    expect(selectPerShareRaw(div({ value: 1.25, unadjustedValue: null }))).toBe(1.25);
  });
  it("rejects zero, negative, and non-finite", () => {
    expect(selectPerShareRaw(div({ value: 0, unadjustedValue: 0 }))).toBeNull();
    expect(selectPerShareRaw(div({ value: -1, unadjustedValue: null }))).toBeNull();
    expect(selectPerShareRaw(div({ value: NaN, unadjustedValue: null }))).toBeNull();
  });
});

describe("normalizeDividend", () => {
  it("converts pence (GBX) to GBP by dividing by 100", () => {
    const r = normalizeDividend("GBX", 525, "GBP");
    expect(r).not.toBeNull();
    expect(r!.currency).toBe("GBP");
    expect(r!.perShare.toString()).toBe("5.25");
  });
  it("converts mixed-case pence (GBp) without colliding with GBP", () => {
    const r = normalizeDividend("GBp", 7, "GBP");
    expect(r!.currency).toBe("GBP");
    expect(r!.perShare.toString()).toBe("0.07");
  });
  it("passes through GBP / USD / EUR unchanged", () => {
    expect(normalizeDividend("GBP", 0.5, "GBP")!.perShare.toString()).toBe("0.5");
    expect(normalizeDividend("usd", 0.25, "USD")!.currency).toBe("USD");
    expect(normalizeDividend("EUR", 1.1, "EUR")!.currency).toBe("EUR");
  });
  it("falls back to the security currency when none reported", () => {
    const r = normalizeDividend("", 0.4, "USD");
    expect(r!.currency).toBe("USD");
    expect(r!.perShare.toString()).toBe("0.4");
  });
  it("returns null for unsupported currencies", () => {
    expect(normalizeDividend("JPY", 10, "USD")).toBeNull();
    expect(normalizeDividend("CHF", 1, "EUR")).toBeNull();
  });
});

describe("dividendCashImpact", () => {
  it("credits a long holding (positive)", () => {
    expect(dividendCashImpact(new Decimal("0.5"), new Decimal("1000")).toString()).toBe("500");
  });
  it("debits a short holding (negative)", () => {
    expect(dividendCashImpact(new Decimal("0.5"), new Decimal("-1000")).toString()).toBe("-500");
  });
  it("is exact for fractional pence-derived amounts", () => {
    expect(dividendCashImpact(new Decimal("0.0525"), new Decimal("300")).toString()).toBe("15.75");
  });
});

describe("shouldBookDividend", () => {
  it("skips zero holdings", () => {
    expect(shouldBookDividend(new Decimal("0.5"), new Decimal("0"))).toBe(false);
  });
  it("skips zero per-share", () => {
    expect(shouldBookDividend(new Decimal("0"), new Decimal("100"))).toBe(false);
  });
  it("books non-zero long and short holdings", () => {
    expect(shouldBookDividend(new Decimal("0.5"), new Decimal("100"))).toBe(true);
    expect(shouldBookDividend(new Decimal("0.5"), new Decimal("-100"))).toBe(true);
  });
});

describe("dividendDedupeKey", () => {
  it("is stable and unique per (fund, security, ex-date)", () => {
    expect(dividendDedupeKey("f1", "s1", "2026-05-15")).toBe("f1|s1|2026-05-15");
    expect(dividendDedupeKey("f1", "s1", "2026-05-15")).toBe(dividendDedupeKey("f1", "s1", "2026-05-15"));
    expect(dividendDedupeKey("f1", "s2", "2026-05-15")).not.toBe(dividendDedupeKey("f1", "s1", "2026-05-15"));
  });
});
