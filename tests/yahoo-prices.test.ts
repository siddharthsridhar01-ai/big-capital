import { describe, it, expect } from "vitest";
import { resolvePriceCurrency } from "../src/workers/fetch-prices-yahoo";
import { toYahooSymbol } from "../src/lib/intraday/yahoo";

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

describe("toYahooSymbol", () => {
  it("suffixes non-US exchanges", () => {
    expect(toYahooSymbol("AZN", "LSE")).toBe("AZN.L");
    expect(toYahooSymbol("MC", "EURONEXT PARIS")).toBe("MC.PA");
  });

  it("leaves plain US tickers unsuffixed", () => {
    expect(toYahooSymbol("AAPL", "NASDAQ")).toBe("AAPL");
    expect(toYahooSymbol("JPM", "NYSE")).toBe("JPM");
  });

  it("converts US class shares from dot to hyphen (BRK.B -> BRK-B)", () => {
    // A dotted US ticker returns an empty Yahoo quote rather than an error, so
    // the security silently never gets priced. Regression test for that.
    expect(toYahooSymbol("BRK.B", "NYSE")).toBe("BRK-B");
    expect(toYahooSymbol("BF.B", "NYSE")).toBe("BF-B");
  });

  it("does not touch the dot in a non-US exchange suffix", () => {
    expect(toYahooSymbol("0700", "HKEX")).toBe("0700.HK");
    expect(toYahooSymbol("7203", "TSE")).toBe("7203.T");
  });
});
