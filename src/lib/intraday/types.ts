/**
 * Intraday quote provider interface.
 *
 * Abstracts the data source (Yahoo, EODHD, Twelve Data, etc.) so the rest of
 * the system doesn't care where prices come from. The current implementation
 * uses Yahoo Finance for free-tier proof of concept; switching to a paid
 * provider replaces only this file's import binding (see ./provider.ts).
 *
 * Design notes:
 *  - All amounts are in the security's NATIVE currency. FX conversion lives
 *    higher up in the stack.
 *  - `asOf` is a server-side timestamp of when the quote was fetched.
 *    For 15-min delayed providers, the actual market time is asOf - 15min.
 *  - Returns `null` per ticker on failure rather than throwing — partial
 *    success is the common case (some tickers resolve, others don't).
 */

export interface IntradayQuote {
  /** Provider-specific symbol used in the lookup (e.g. "AZN.L", "AAPL"). */
  symbol: string;
  /** Latest known price in the security's native currency. */
  price: number;
  /** Previous market session's closing price. */
  previousClose: number | null;
  /** Absolute change vs previousClose, signed. */
  change: number | null;
  /** Percentage change vs previousClose, signed. e.g. 0.0081 for +0.81%. */
  changePct: number | null;
  /** Currency code of the price (e.g. "GBP", "USD"). */
  currency: string;
  /** Trading state from the provider: "REGULAR", "PRE", "POST", "CLOSED". */
  marketState: "REGULAR" | "PRE" | "POST" | "CLOSED" | "UNKNOWN";
  /** When this quote was fetched server-side. */
  asOf: Date;
}

export interface IntradayProvider {
  name: string;
  /**
   * Display label shown in the UI, e.g. "Yahoo Finance · 15 min delayed".
   */
  displayLabel: string;
  /**
   * Fetch quotes for a batch of symbols. Symbols are the provider-specific
   * format (e.g. Yahoo uses "AZN.L"). Returns one entry per requested symbol
   * (null on per-symbol failure).
   */
  fetchQuotes(symbols: string[]): Promise<Array<IntradayQuote | null>>;
}
