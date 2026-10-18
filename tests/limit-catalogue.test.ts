/**
 * Validation for the admin limits editor.
 */
import { describe, it, expect } from "vitest";
import { validateLimits, LIMIT_CATALOGUE, type LimitSetting } from "../src/lib/limit-catalogue";
import { DEFAULT_LIMITS } from "../src/lib/fund-limit-defaults";

function settings(on: Partial<Record<string, { value?: number | boolean; isHard?: boolean }>>): LimitSetting[] {
  return LIMIT_CATALOGUE.map((spec) => {
    const s = on[spec.type];
    return {
      type: spec.type,
      enabled: Boolean(s),
      isHard: s?.isHard ?? spec.kind === "flag",
      value: s?.value ?? (spec.kind === "flag" ? true : 0),
    };
  });
}

describe("validateLimits", () => {
  it("accepts a sensible long-only fund", () => {
    expect(validateLimits(settings({
      universe_only: {}, long_only: {},
      max_position_pct: { value: 0.08 }, max_single_sector_pct: { value: 0.35 },
    }))).toEqual([]);
  });

  it("refuses a fund that can short without a gross exposure limit", () => {
    const e = validateLimits(settings({ universe_only: {}, max_position_pct: { value: 0.08 } }));
    expect(e.some((x) => x.includes("max gross exposure"))).toBe(true);
  });

  it("refuses a soft gross exposure limit on a fund that can short", () => {
    const e = validateLimits(settings({ max_gross_exposure: { value: 1.6, isHard: false } }));
    expect(e.some((x) => x.includes("must be hard"))).toBe(true);
  });

  it("accepts a long/short fund with a hard gross limit", () => {
    expect(validateLimits(settings({
      universe_only: {}, max_gross_exposure: { value: 1.6, isHard: true }, max_net_exposure: { value: 1, isHard: true },
    }))).toEqual([]);
  });

  it("refuses a position cap above 100%", () => {
    // Entering 8 meaning 8% is stored as 0.08; 8 itself would be 800%.
    const e = validateLimits(settings({ long_only: {}, max_position_pct: { value: 8 } }));
    expect(e.some((x) => x.startsWith("Max position"))).toBe(true);
  });

  it("refuses min cash above max cash", () => {
    const e = validateLimits(settings({ long_only: {}, min_cash_pct: { value: 0.2 }, max_cash_pct: { value: 0.1 } }));
    expect(e).toContain("Min cash cannot exceed max cash.");
  });

  it("refuses a fractional position count", () => {
    const e = validateLimits(settings({ long_only: {}, max_position_count: { value: 12.5 } }));
    expect(e.some((x) => x.includes("whole number"))).toBe(true);
  });

  it("refuses a blank value on an enabled limit", () => {
    const e = validateLimits(settings({ long_only: {}, max_position_pct: { value: NaN } }));
    expect(e.some((x) => x.includes("enter a number"))).toBe(true);
  });

  it("ignores the value of a limit that is switched off", () => {
    expect(validateLimits(settings({ long_only: {} }).map((s) =>
      s.type === "max_position_pct" ? { ...s, enabled: false, value: 99 } : s
    ))).toEqual([]);
  });
});

describe("fund defaults", () => {
  // "Reset to defaults" must always be accepted.
  for (const [slug, d] of Object.entries(DEFAULT_LIMITS)) {
    it(`${slug} defaults are valid`, () => {
      const s = LIMIT_CATALOGUE.map((spec) => {
        const c = d.constraints.find((x) => x.type === spec.type);
        return { type: spec.type, enabled: Boolean(c), isHard: c?.isHard ?? false, value: (c?.value as number | boolean) ?? 0 };
      });
      expect(validateLimits(s)).toEqual([]);
    });
  }

  it("makes Systematic Equity long/short", () => {
    const sys = DEFAULT_LIMITS["systematic-equity"].constraints;
    expect(sys.some((c) => c.type === "long_only")).toBe(false);
    expect(sys.find((c) => c.type === "max_gross_exposure")).toMatchObject({ value: 1.6, isHard: true });
    expect(sys.find((c) => c.type === "max_net_exposure")).toMatchObject({ value: 1.0, isHard: true });
  });
});
