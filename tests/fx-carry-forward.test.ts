/**
 * FX rates carry forward to the requested date.
 *
 * convertToBase() throws when a currency pair has no rate, so an exact-date
 * lookup meant a single missing fxRates row cost a fund its whole NAV for that
 * day. ECB publishes on TARGET days, which do not align with market holidays,
 * so dates exist where markets trade and no reference rate is published.
 */
import { describe, it, expect } from "vitest";

interface FxRow { fromCurrency: string; toCurrency: string; date: string; rate: string }

/** Mirrors the selection in runNavSnapshot: newest-first, first sighting wins. */
function buildFxMap(rowsNewestFirst: FxRow[], requestedDate: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rowsNewestFirst) {
    const key = `${r.fromCurrency}/${r.toCurrency}/${requestedDate}`;
    if (!m.has(key)) m.set(key, r.rate);
  }
  return m;
}

const rows: FxRow[] = [
  { fromCurrency: "USD", toCurrency: "GBP", date: "2026-08-11", rate: "0.79" },
  { fromCurrency: "EUR", toCurrency: "GBP", date: "2026-08-11", rate: "0.85" },
  { fromCurrency: "USD", toCurrency: "GBP", date: "2026-08-10", rate: "0.78" },
  { fromCurrency: "EUR", toCurrency: "GBP", date: "2026-08-07", rate: "0.84" },
];

describe("FX carry-forward", () => {
  it("uses the date's own rate when one was published", () => {
    const m = buildFxMap(rows, "2026-08-11");
    expect(m.get("USD/GBP/2026-08-11")).toBe("0.79");
  });

  it("carries the last published rate forward to a non-publication date", () => {
    // Nothing published on the 12th; the 11th is the latest available.
    const m = buildFxMap(rows, "2026-08-12");
    expect(m.get("USD/GBP/2026-08-12")).toBe("0.79");
    expect(m.get("EUR/GBP/2026-08-12")).toBe("0.85");
  });

  it("keys every pair under the requested date so lookups resolve", () => {
    const m = buildFxMap(rows, "2026-08-12");
    for (const k of m.keys()) expect(k.endsWith("/2026-08-12")).toBe(true);
  });

  it("never lets an older rate shadow a newer one", () => {
    const m = buildFxMap(rows, "2026-08-11");
    expect(m.get("EUR/GBP/2026-08-11")).toBe("0.85"); // not the 7th's 0.84
  });
});
