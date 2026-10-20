/**
 * The two exchange tables must agree.
 *
 * SUFFIX_TO_EXCHANGE (adding a security) and EXCHANGE_SUFFIX (building a Yahoo
 * symbol) drifted apart once already: the second had no Copenhagen, Stockholm,
 * Oslo or Madrid, so an unknown exchange fell through to "" — a US lookup — and
 * every Nordic and Spanish name in the European universe was refused at seed.
 */
import { describe, it, expect } from "vitest";
import { SUFFIX_TO_EXCHANGE, SUPPORTED_CURRENCIES } from "../src/lib/universe-add";
import { EXCHANGE_SUFFIX, toYahooSymbol } from "../src/lib/intraday/yahoo";
import { CURRENCIES } from "../src/lib/currency";

describe("exchange tables", () => {
  it("every canonical exchange maps back to its own suffix", () => {
    for (const [suffix, exchange] of Object.entries(SUFFIX_TO_EXCHANGE)) {
      expect(EXCHANGE_SUFFIX[exchange], `${exchange} should map to ${suffix}`).toBe(suffix);
    }
  });

  it("round-trips every European listing in the universe", () => {
    for (const sym of ["NESN.SW", "UBSG.SW", "NOVO-B.CO", "ATCO-A.ST", "EQNR.OL", "SAN.MC", "ITX.MC", "IBE.MC"]) {
      const dot = sym.lastIndexOf(".");
      const exchange = SUFFIX_TO_EXCHANGE[sym.slice(dot)];
      expect(exchange, `${sym} needs an exchange`).toBeTruthy();
      expect(toYahooSymbol(sym.slice(0, dot), exchange)).toBe(sym);
    }
  });

  it("keeps the exchange names already stored on existing securities", () => {
    // Changing these would duplicate held securities, since rows match on
    // (ticker, exchange).
    expect(SUFFIX_TO_EXCHANGE[".T"]).toBe("TSE");
    expect(SUFFIX_TO_EXCHANGE[".L"]).toBe("LSE");
    expect(SUFFIX_TO_EXCHANGE[".KS"]).toBe("KRX");
  });
});

describe("currencies", () => {
  it("adding a security accepts every currency the system supports", () => {
    for (const c of CURRENCIES) expect(SUPPORTED_CURRENCIES.has(c), c).toBe(true);
  });
  it("includes the Swiss franc and Nordic currencies", () => {
    for (const c of ["CHF", "DKK", "SEK", "NOK"]) expect(SUPPORTED_CURRENCIES.has(c), c).toBe(true);
  });
});

import { checkMandate } from "../src/lib/mandates";

describe("European Equity mandate", () => {
  const ccyOf: Record<string, string> = {
    ".L": "GBP", ".DE": "EUR", ".PA": "EUR", ".AS": "EUR", ".MI": "EUR", ".MC": "EUR",
    ".SW": "CHF", ".CO": "DKK", ".ST": "SEK", ".OL": "NOK",
  };

  it("accepts every listing in the European universe", () => {
    for (const sym of [
      "AZN.L", "SAP.DE", "MC.PA", "ASML.AS", "ISP.MI", "SAN.MC",
      "NESN.SW", "UBSG.SW", "NOVO-B.CO", "ATCO-A.ST", "EQNR.OL",
    ]) {
      const suffix = sym.slice(sym.lastIndexOf("."));
      const r = checkMandate("european-equity", ccyOf[suffix], SUFFIX_TO_EXCHANGE[suffix]);
      expect(r.ok, sym).toBe(true);
    }
  });

  it("refuses a US listing", () => {
    expect(checkMandate("european-equity", "USD", "NASDAQ").ok).toBe(false);
  });

  it("refuses an Asian listing", () => {
    expect(checkMandate("european-equity", "JPY", "TSE").ok).toBe(false);
  });

  it("leaves the global funds unrestricted", () => {
    expect(checkMandate("global-equity", "USD", "NASDAQ").ok).toBe(true);
    expect(checkMandate("global-equity", "CHF", "SIX").ok).toBe(true);
  });
});

import { EXCHANGE_COUNTRY, exchangeToCountry } from "../src/lib/exchange-country";

describe("country of listing", () => {
  it("has a country for every exchange the system can list", () => {
    for (const exchange of Object.keys(EXCHANGE_SUFFIX)) {
      expect(EXCHANGE_COUNTRY[exchange], exchange).toBeTruthy();
    }
  });
  it("maps the European venues", () => {
    expect(exchangeToCountry("MADRID")).toBe("Spain");
    expect(exchangeToCountry("COPENHAGEN")).toBe("Denmark");
    expect(exchangeToCountry("STOCKHOLM")).toBe("Sweden");
    expect(exchangeToCountry("OSLO")).toBe("Norway");
  });
  it("never shows a raw exchange code", () => {
    expect(exchangeToCountry("SOMEWHERE NEW")).toBe("Other");
  });
});
