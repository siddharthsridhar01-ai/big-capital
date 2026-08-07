/**
 * Graduation years offered in the team profile picker.
 *
 * A fixed degree list was tried and removed: LSE runs too many programmes, and
 * joint honours multiply them further, so the list was never complete and
 * "Other" was being chosen often enough to defeat the point. Degree is free text.
 */

/** This cycle plus the next six. */
export function graduationYears(from = new Date().getUTCFullYear()): number[] {
  return Array.from({ length: 7 }, (_, i) => from + i);
}
