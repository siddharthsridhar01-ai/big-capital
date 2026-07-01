import { describe, it, expect } from "vitest";
import { resolvePriceCurrency } from "../src/workers/fetch-prices-yahoo";

describe("resolvePriceCurrency", () => {
  it("accepts supported quote currencies (already normalised from pence etc.)", () => {
    expect(resolvePriceCurrency("GBP", "GBP")).toBe("GBP");
    expect(resolvePriceCurrency("USD", "USD")).toBe("USD");
    expect(resolvePriceCurrency("EUR", "EUR")).toBe("EUR");
  });

  it("is case-insensitive on the quote currency", () => {
    expect(resolvePriceCurrency("gbp", "GBP")).toBe("GBP");
  });

  it("falls back to the security currency when the quote currency is unusable", () => {
    expect(resolvePriceCurrency("", "GBP")).toBe("GBP");
    expect(resolvePriceCurrency(null, "USD")).toBe("USD");
    expect(resolvePriceCurrency("GBX", "GBP")).toBe("GBP"); // raw pence code shouldn't reach here, but fall back safely
  });

  it("returns null when neither currency is supported", () => {
    expect(resolvePriceCurrency("JPY", "JPY")).toBeNull();
  });
});
