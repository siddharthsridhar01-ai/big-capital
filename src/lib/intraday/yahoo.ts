/**
 * Yahoo Finance intraday quote adapter.
 *
 * Uses the unofficial `yahoo-finance2` library. This is the demo-tier
 * implementation — when EODHD intraday subscription is sorted, the
 * provider binding in ./provider.ts swaps to an EODHD adapter and the
 * rest of the system doesn't change.
 *
 * Known quirks of Yahoo:
 *  - 15-min delayed on most international exchanges
 *  - Real-time during US market hours for US-listed names
 *  - Returns data 24/7 (just stops moving when market closed)
 *  - May rate-limit aggressive callers — the cache layer is what keeps us safe
 *  - Unofficial API: occasionally breaks when Yahoo changes cookie/CSRF flow
 */

import YahooFinance from "yahoo-finance2";
import type { IntradayProvider, IntradayQuote } from "./types";

// yahoo-finance2 v3 requires instantiation rather than using a default singleton
const yahooFinance = new YahooFinance();

/**
 * Map our internal exchange codes to Yahoo's symbol-suffix convention.
 * Our exchange codes: "LSE", "NYSE", "NASDAQ", "XETRA", "Euronext Paris", etc.
 * Yahoo conventions: tickers on non-US exchanges are suffixed (e.g. AZN.L).
 *
 * Comprehensive list at https://help.yahoo.com/kb/SLN2310.html — adding the
 * exchanges we actually have in our seeded universe.
 */
export function exchangeToYahooSuffix(exchange: string): string {
  const norm = exchange.toUpperCase().trim();
  const map: Record<string, string> = {
    LSE: ".L",
    "LONDON STOCK EXCHANGE": ".L",
    NYSE: "",
    NASDAQ: "",
    XETRA: ".DE",
    "FRANKFURT": ".F",
    "EURONEXT PARIS": ".PA",
    "EURONEXT AMSTERDAM": ".AS",
    "EURONEXT BRUSSELS": ".BR",
    "BORSA ITALIANA": ".MI",
    "MILAN": ".MI",
    SIX: ".SW",
    "SWISS EXCHANGE": ".SW",
    TSX: ".TO",
    "TORONTO STOCK EXCHANGE": ".TO",
    HKEX: ".HK",
    "HONG KONG STOCK EXCHANGE": ".HK",
    NSE: ".NS",
    "BSE": ".BO",
    "TOKYO STOCK EXCHANGE": ".T",
    TSE: ".T",
    "AUSTRALIAN SECURITIES EXCHANGE": ".AX",
    ASX: ".AX",
    "JOHANNESBURG STOCK EXCHANGE": ".JO",
    JSE: ".JO",
    "B3": ".SA",
    "BOLSA DE VALORES DE SAO PAULO": ".SA",
    "BOLSA MEXICANA DE VALORES": ".MX",
    "TAIWAN STOCK EXCHANGE": ".TW",
    TWSE: ".TW",
    "KOREA EXCHANGE": ".KS",
    KOSPI: ".KS",
    KRX: ".KS",
  };
  return map[norm] ?? "";
}

/**
 * Build the Yahoo symbol from our (ticker, exchange) pair.
 * Examples:
 *   ("AZN", "LSE") → "AZN.L"
 *   ("AAPL", "NASDAQ") → "AAPL"
 *   ("SHEL", "LSE") → "SHEL.L"
 */
export function toYahooSymbol(ticker: string, exchange: string): string {
  const suffix = exchangeToYahooSuffix(exchange);
  // US class shares: market convention writes Berkshire's B share as "BRK.B",
  // but Yahoo uses a hyphen — "BRK-B". A dotted US ticker does not error, it
  // returns an EMPTY quote, so the security silently never receives a price.
  // Only rewrite for the un-suffixed (US) exchanges: on every other exchange the
  // dot is the exchange suffix itself and must be left alone.
  const base = suffix === "" ? ticker.replace(/\./g, "-") : ticker;
  return base + suffix;
}

function mapMarketState(state: string | undefined): IntradayQuote["marketState"] {
  if (!state) return "UNKNOWN";
  const s = state.toUpperCase();
  if (s === "REGULAR") return "REGULAR";
  // Exact-match the "fully closed" states BEFORE the pre/post prefix checks —
  // PREPRE/POSTPOST mean the market is past its pre/post window (effectively
  // closed, price frozen at the last close), and must not be treated as an
  // active pre/post session.
  if (s === "CLOSED" || s === "PREPRE" || s === "POSTPOST") return "CLOSED";
  if (s === "PRE") return "PRE";
  if (s === "POST") return "POST";
  return "UNKNOWN";
}

/**
 * Some exchanges quote in minor currency units (pence, cents) rather than the
 * major unit. LSE is the major one we hit: AZN.L returns 13632 GBp, meaning
 * 13,632 pence = £136.32. Our system stores and displays everything in major
 * units, so we normalise here at the adapter boundary.
 *
 * Yahoo identifies pence quotes with currency = "GBp" (lowercase 'p').
 * Add other exchanges here as we encounter them (e.g. JSE quotes ZAc).
 */
function normaliseMinorCurrencyUnits(
  price: number,
  previousClose: number | null,
  change: number | null,
  yahooCurrency: string
): { price: number; previousClose: number | null; change: number | null; currency: string } {
  // GBp (pence) → GBP (pounds): divide by 100
  if (yahooCurrency === "GBp" || yahooCurrency === "GBX") {
    return {
      price: price / 100,
      previousClose: previousClose != null ? previousClose / 100 : null,
      change: change != null ? change / 100 : null,
      currency: "GBP",
    };
  }
  // ZAc (South African cents) → ZAR
  if (yahooCurrency === "ZAc") {
    return {
      price: price / 100,
      previousClose: previousClose != null ? previousClose / 100 : null,
      change: change != null ? change / 100 : null,
      currency: "ZAR",
    };
  }
  // ILA (Israeli agorot) → ILS
  if (yahooCurrency === "ILA") {
    return {
      price: price / 100,
      previousClose: previousClose != null ? previousClose / 100 : null,
      change: change != null ? change / 100 : null,
      currency: "ILS",
    };
  }
  // Default: pass through unchanged
  return { price, previousClose, change, currency: yahooCurrency.toUpperCase() };
}

export const yahooProvider: IntradayProvider = {
  name: "yahoo",
  displayLabel: "Yahoo Finance · ~15 min delayed",

  async fetchQuotes(symbols: string[]): Promise<Array<IntradayQuote | null>> {
    if (symbols.length === 0) return [];

    // Yahoo's quote() takes an array and returns an array. We pass our symbols
    // and map results back position-by-position via the requestedSymbol field.
    let results: unknown;
    try {
      results = await yahooFinance.quote(symbols, undefined, {
        validateResult: false,
      });
    } catch (err) {
      console.error("[yahoo] fetchQuotes failed:", err);
      // Whole batch failed — return all-null
      return symbols.map(() => null);
    }

    const resultArray = (Array.isArray(results)
      ? results
      : [results]) as Array<Record<string, unknown>>;
    const bySymbol = new Map<string, Record<string, unknown>>();
    for (const r of resultArray) {
      const sym = r?.symbol;
      if (typeof sym === "string") bySymbol.set(sym, r);
    }

    const now = new Date();
    return symbols.map((sym) => {
      const r = bySymbol.get(sym);
      if (!r) return null;
      const rawPrice = r.regularMarketPrice as number | undefined;
      if (rawPrice == null) return null;
      const rawPrevClose = (r.regularMarketPreviousClose as number | undefined) ?? null;
      const rawChange = (r.regularMarketChange as number | undefined) ?? null;
      const rawCurrency = (r.currency as string) ?? "USD";
      const rawChangePct = r.regularMarketChangePercent as number | undefined;
      const changePct = rawChangePct != null ? rawChangePct / 100 : null;

      // Normalise minor currency units (e.g. LSE returns GBp, not GBP)
      const normalised = normaliseMinorCurrencyUnits(
        rawPrice,
        rawPrevClose,
        rawChange,
        rawCurrency
      );

      return {
        symbol: sym,
        price: normalised.price,
        previousClose: normalised.previousClose,
        change: normalised.change,
        changePct, // percentage doesn't need unit normalisation
        currency: normalised.currency,
        marketState: mapMarketState(r.marketState as string),
        asOf: now,
      };
    });
  },
};
