/**
 * Smoke test for the EODHD client against the real API.
 * Uses the public `demo` token, which is restricted to a handful of symbols:
 *   AAPL.US, TSLA.US, AMZN.US, MCD.US, BTC-USD.CC, EURUSD.FOREX
 *
 * Run: npx tsx tests/eodhd-live.ts
 */

import { EodhdClient } from "../src/lib/eodhd";

async function main() {
  const client = new EodhdClient({ apiToken: "demo" });

  console.log("=== EOD prices for AAPL (last 5 days) ===");
  const prices = await client.getEodPrices("AAPL", "US", "2025-12-01");
  console.log(prices.slice(-5));

  console.log("\n=== Real-time quote for AAPL ===");
  const quote = await client.getRealTimeQuote("AAPL", "US");
  console.log(quote);

  console.log("\n=== Dividends for AAPL (recent) ===");
  const divs = await client.getDividends("AAPL", "US", "2024-01-01");
  console.log(divs.slice(-3));

  console.log("\n=== EUR/USD FX rate ===");
  const fx = await client.getEodPrices("EURUSD", "FOREX", "2025-12-01");
  console.log(fx.slice(-3));

  console.log("\nAll endpoints responded successfully.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
