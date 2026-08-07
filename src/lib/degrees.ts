/**
 * Degree programmes, as a fixed list.
 *
 * Members were writing their degree into the free-text bio ("BSc Economics"),
 * which meant no two entries matched and the public team pages could not group
 * or display them consistently. A fixed list also keeps the pages looking like
 * a firm's rather than a form's.
 *
 * Shared by the editor and the API so the two cannot drift. "Other" exists so a
 * programme missing from the list never blocks someone from completing their
 * profile; if it is chosen often, add the programme here.
 */

export const DEGREES = [
  "BSc Accounting and Finance",
  "BSc Actuarial Science",
  "BSc Data Science",
  "BSc Econometrics and Mathematical Economics",
  "BSc Economics",
  "BSc Economics and Economic History",
  "BSc Economics with Economic History",
  "BSc Finance",
  "BSc Financial Mathematics and Statistics",
  "BSc Management",
  "BSc Mathematics and Economics",
  "BSc Mathematics with Data Science",
  "BSc Mathematics, Statistics and Business",
  "BSc Philosophy, Politics and Economics",
  "BSc Politics and Economics",
  "BSc Statistics with Finance",
  "MSc Accounting and Finance",
  "MSc Economics",
  "MSc Finance",
  "MSc Finance and Economics",
  "MSc Financial Mathematics",
  "MSc Financial Statistics",
  "MSc Management",
  "MSc Operations Research and Analytics",
  "MSc Quantitative Methods for Risk Management",
  "MSc Risk and Finance",
  "MSc Statistics",
  "Other",
] as const;

export type Degree = (typeof DEGREES)[number];

export function isValidDegree(v: string): v is Degree {
  return (DEGREES as readonly string[]).includes(v);
}

/** Graduation years offered in the picker: this cycle plus the next six. */
export function graduationYears(from = new Date().getUTCFullYear()): number[] {
  return Array.from({ length: 7 }, (_, i) => from + i);
}
