/**
 * The limits an admin can set on a fund, and the rules a configuration must meet.
 *
 * Pure: shared by the editor UI and the API, and tested directly. Values are
 * stored as fractions (0.08 = 8%) and shown as percentages, so a typo cannot set
 * a position cap of 800% by entering "8" meaning eight percent.
 */
import type { ConstraintType } from "./constraints";

export type LimitKind = "flag" | "percent" | "count";

export interface LimitSpec {
  type: ConstraintType;
  label: string;
  description: string;
  kind: LimitKind;
  group: "Mandate" | "Concentration" | "Exposure" | "Cash";
  /** Inclusive bounds on the stored value (a fraction for percentages). */
  min?: number;
  max?: number;
}

export const LIMIT_CATALOGUE: LimitSpec[] = [
  { type: "universe_only", group: "Mandate", kind: "flag", label: "Universe only",
    description: "New positions must be in the fund's investable universe. Sales are always allowed." },
  { type: "long_only", group: "Mandate", kind: "flag", label: "Long only",
    description: "No short positions. Purchases cannot exceed available cash." },
  { type: "max_position_pct", group: "Concentration", kind: "percent", min: 0.001, max: 1, label: "Max position",
    description: "Largest single holding, as a share of NAV." },
  { type: "max_single_sector_pct", group: "Concentration", kind: "percent", min: 0.01, max: 1, label: "Max sector",
    description: "Largest sector exposure, as a share of NAV." },
  { type: "max_position_count", group: "Concentration", kind: "count", min: 1, max: 500, label: "Max positions",
    description: "Number of names held, long and short combined." },
  { type: "max_gross_exposure", group: "Exposure", kind: "percent", min: 0.01, max: 5, label: "Max gross exposure",
    description: "Longs plus shorts, as a share of NAV. The fund's leverage limit." },
  { type: "max_net_exposure", group: "Exposure", kind: "percent", min: 0, max: 2, label: "Max net exposure",
    description: "Longs minus shorts, as a share of NAV, in either direction." },
  { type: "min_cash_pct", group: "Cash", kind: "percent", min: 0, max: 1, label: "Min cash",
    description: "Cash floor, as a share of NAV. Suspended for the first 90 days." },
  { type: "max_cash_pct", group: "Cash", kind: "percent", min: 0, max: 1, label: "Max cash",
    description: "Cash ceiling, as a share of NAV. Suspended for the first 90 days." },
];

export const SPEC_BY_TYPE = new Map(LIMIT_CATALOGUE.map((s) => [s.type, s]));

export interface LimitSetting {
  type: ConstraintType;
  enabled: boolean;
  isHard: boolean;
  /** true for flags; a fraction for percentages; an integer for counts. */
  value: number | boolean;
}

/** Every problem with a configuration, or an empty list if it can be saved. */
export function validateLimits(settings: LimitSetting[]): string[] {
  const errors: string[] = [];
  const on = new Map(settings.filter((s) => s.enabled).map((s) => [s.type, s]));

  for (const s of settings) {
    const spec = SPEC_BY_TYPE.get(s.type);
    if (!spec) {
      errors.push(`Unknown limit "${s.type}".`);
      continue;
    }
    if (!s.enabled || spec.kind === "flag") continue;
    const v = Number(s.value);
    if (!Number.isFinite(v)) {
      errors.push(`${spec.label}: enter a number.`);
      continue;
    }
    if (spec.kind === "count" && !Number.isInteger(v)) errors.push(`${spec.label}: must be a whole number.`);
    const show = (x: number) => (spec.kind === "percent" ? `${+(x * 100).toFixed(2)}%` : String(x));
    if (spec.min != null && v < spec.min) errors.push(`${spec.label}: at least ${show(spec.min)}.`);
    if (spec.max != null && v > spec.max) errors.push(`${spec.label}: at most ${show(spec.max)}.`);
  }

  const minCash = on.get("min_cash_pct");
  const maxCash = on.get("max_cash_pct");
  if (minCash && maxCash && Number(minCash.value) > Number(maxCash.value)) {
    errors.push("Min cash cannot exceed max cash.");
  }

  // A fund that can short must have a hard leverage limit. Without it, turning
  // off long-only leaves the fund free to lever up without bound.
  if (!on.has("long_only")) {
    const gross = on.get("max_gross_exposure");
    if (!gross) errors.push("A fund that can short needs a max gross exposure limit.");
    else if (!gross.isHard) errors.push("Max gross exposure must be hard for a fund that can short.");
  }

  return errors;
}
