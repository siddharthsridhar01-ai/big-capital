/**
 * Normalise sector labels to a single taxonomy.
 *
 * Yahoo returns Morningstar sector names from `assetProfile` ("Consumer
 * Defensive", "Financial Services", "Technology"), while the original UK seed
 * used GICS names ("Consumer Staples", "Financials", "Information Technology").
 * Holding both meant the same sector appeared under two labels.
 *
 * That is not cosmetic. max_single_sector_pct groups by the exact string, so a
 * book with 20% tagged "Consumer Staples" and 20% tagged "Consumer Defensive"
 * reads as two 20% buckets rather than one 40% position — the cap under-reports
 * concentration, which is the wrong direction for a risk limit to fail in.
 *
 * The column is named gicsSector, so GICS is the target.
 */

/** Morningstar (and other common variants) mapped onto GICS sector names. */
const TO_GICS: Record<string, string> = {
  // Morningstar labels returned by Yahoo assetProfile
  "consumer defensive": "Consumer Staples",
  "consumer cyclical": "Consumer Discretionary",
  "financial services": "Financials",
  financial: "Financials",
  technology: "Information Technology",
  "basic materials": "Materials",
  healthcare: "Health Care",
  "communication services": "Communication Services",
  industrials: "Industrials",
  energy: "Energy",
  utilities: "Utilities",
  "real estate": "Real Estate",

  // Spellings of GICS names that differ only by case or spacing
  "consumer staples": "Consumer Staples",
  "consumer discretionary": "Consumer Discretionary",
  financials: "Financials",
  "information technology": "Information Technology",
  materials: "Materials",
  "health care": "Health Care",
};

/** The eleven GICS sectors, for display and validation. */
export const GICS_SECTORS = [
  "Communication Services",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Financials",
  "Health Care",
  "Industrials",
  "Information Technology",
  "Materials",
  "Real Estate",
  "Utilities",
] as const;

/**
 * Map any recognised sector label onto its GICS name. Unrecognised values are
 * returned unchanged rather than discarded: a label we have not seen before is
 * still more useful than null, and it will show up as an odd bucket on the
 * exposures panel, which is the signal to add it here.
 */
export function normaliseSector(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return TO_GICS[key] ?? raw.trim();
}

/** True when a label is already one of the eleven GICS sectors. */
export function isGicsSector(value: string): boolean {
  return (GICS_SECTORS as readonly string[]).includes(value);
}
