/**
 * Sector labels must resolve to one taxonomy.
 *
 * max_single_sector_pct groups by the exact string, so "Consumer Staples" and
 * "Consumer Defensive" sitting side by side split one position into two buckets
 * and cause the cap to under-report concentration.
 */
import { describe, it, expect } from "vitest";
import { normaliseSector, isGicsSector, GICS_SECTORS } from "../src/lib/sectors";

describe("normaliseSector", () => {
  it("maps Morningstar labels onto GICS", () => {
    expect(normaliseSector("Consumer Defensive")).toBe("Consumer Staples");
    expect(normaliseSector("Consumer Cyclical")).toBe("Consumer Discretionary");
    expect(normaliseSector("Financial Services")).toBe("Financials");
    expect(normaliseSector("Technology")).toBe("Information Technology");
    expect(normaliseSector("Basic Materials")).toBe("Materials");
  });

  it("leaves GICS labels untouched", () => {
    for (const s of GICS_SECTORS) expect(normaliseSector(s)).toBe(s);
  });

  it("collapses the two labels that caused the split", () => {
    expect(normaliseSector("Consumer Defensive")).toBe(normaliseSector("Consumer Staples"));
    expect(normaliseSector("Consumer Cyclical")).toBe(normaliseSector("Consumer Discretionary"));
  });

  it("is case and whitespace insensitive", () => {
    expect(normaliseSector("  consumer defensive ")).toBe("Consumer Staples");
    expect(normaliseSector("ENERGY")).toBe("Energy");
  });

  it("returns null for no sector", () => {
    expect(normaliseSector(null)).toBeNull();
    expect(normaliseSector("")).toBeNull();
  });

  it("passes through an unknown label rather than discarding it", () => {
    // Better an odd bucket on the panel than a silently blank sector.
    expect(normaliseSector("Frontier Widgets")).toBe("Frontier Widgets");
    expect(isGicsSector("Frontier Widgets")).toBe(false);
  });
});
