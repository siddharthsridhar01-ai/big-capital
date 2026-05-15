/**
 * Typography tokens for BIG Capital.
 *
 * Two main type families:
 *
 *   serif:    Source Serif Pro — for headlines, brand wordmark, fund names
 *   numeric:  Inter with tabular figures — for prices, weights, percentages,
 *             any displayed numbers. Tabular figures make digits align in
 *             columns and read like institutional financial output.
 *
 * Use these via the css variables defined in the root layout.
 */

import type { CSSProperties } from "react";

// Brand serif. Used for headlines, section titles, fund/security names.
export const serif: CSSProperties = {
  fontFamily: "var(--font-serif), Georgia, 'Source Serif Pro', serif",
};

// Numeric font: Inter with tabular (monospaced) lining figures.
// Apply this anywhere a numeric value is displayed.
export const numeric: CSSProperties = {
  fontFamily: "var(--font-sans), -apple-system, system-ui, sans-serif",
  fontVariantNumeric: "tabular-nums lining-nums",
  fontFeatureSettings: '"tnum" 1, "lnum" 1, "cv11" 1',
  letterSpacing: "-0.005em",
};

// For mono-style identifiers (tickers, ISINs, code-like content)
export const mono: CSSProperties = {
  fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  fontFeatureSettings: '"tnum" 1',
};
