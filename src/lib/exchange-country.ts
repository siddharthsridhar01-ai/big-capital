/**
 * Country of LISTING for each exchange. Not country of revenue, which needs
 * paid data.
 *
 * Shared and complete by test: tests/exchanges.test.ts checks every exchange the
 * system can list has a country here. This was a hand-written table inside the
 * exposures panel that predated the Nordic and Iberian exchanges, so Spanish
 * holdings showed as "MADRID" instead of Spain.
 */
export const EXCHANGE_COUNTRY: Record<string, string> = {
  LSE: "United Kingdom",
  "LONDON STOCK EXCHANGE": "United Kingdom",
  NYSE: "United States",
  NASDAQ: "United States",
  XETRA: "Germany",
  FRANKFURT: "Germany",
  "EURONEXT PARIS": "France",
  "EURONEXT AMSTERDAM": "Netherlands",
  "EURONEXT BRUSSELS": "Belgium",
  "EURONEXT LISBON": "Portugal",
  "EURONEXT DUBLIN": "Ireland",
  "BORSA ITALIANA": "Italy",
  MILAN: "Italy",
  MADRID: "Spain",
  SIX: "Switzerland",
  "SWISS EXCHANGE": "Switzerland",
  COPENHAGEN: "Denmark",
  STOCKHOLM: "Sweden",
  OSLO: "Norway",
  HELSINKI: "Finland",
  VIENNA: "Austria",
  TSX: "Canada",
  "TORONTO STOCK EXCHANGE": "Canada",
  HKEX: "Hong Kong",
  "HONG KONG STOCK EXCHANGE": "Hong Kong",
  NSE: "India",
  BSE: "India",
  "TOKYO STOCK EXCHANGE": "Japan",
  TSE: "Japan",
  "AUSTRALIAN SECURITIES EXCHANGE": "Australia",
  ASX: "Australia",
  JSE: "South Africa",
  "JOHANNESBURG STOCK EXCHANGE": "South Africa",
  B3: "Brazil",
  "BOLSA DE VALORES DE SAO PAULO": "Brazil",
  "BOLSA MEXICANA DE VALORES": "Mexico",
  TWSE: "Taiwan",
  "TAIWAN STOCK EXCHANGE": "Taiwan",
  KRX: "South Korea",
  KOSPI: "South Korea",
  "KOREA EXCHANGE": "South Korea",
};

/** Country of listing; an unknown exchange is shown as "Other" rather than its code. */
export function exchangeToCountry(exchange: string): string {
  return EXCHANGE_COUNTRY[exchange.toUpperCase().trim()] ?? "Other";
}
