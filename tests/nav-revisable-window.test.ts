/**
 * The two most recent days are always re-struck; older ones are left alone.
 *
 * Closing prices are provisional until the auction settles, so a snapshot taken
 * between 16:30 and the LSE auction print uses a pre-auction price. Computing
 * only MISSING days froze that provisional value permanently.
 */
import { describe, it, expect } from "vitest";

/** Mirrors the filter in runNavSnapshot. */
function datesToCompute(
  candidateDates: string[],
  lastDone: string | null,
  targetDate: string,
  revisableDays = 2
): string[] {
  if (!lastDone) return candidateDates;
  const from = new Date(`${targetDate}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (revisableDays - 1));
  const revisableFrom = from.toISOString().slice(0, 10);
  return candidateDates.filter((d) => d > lastDone || d >= revisableFrom);
}

const week = ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"];

describe("NAV revisable window", () => {
  it("re-strikes today even when a snapshot already exists", () => {
    // Struck earlier today, possibly before the closing auction settled.
    expect(datesToCompute(week, "2026-08-13", "2026-08-13")).toEqual(["2026-08-12", "2026-08-13"]);
  });

  it("leaves settled history alone", () => {
    const out = datesToCompute(week, "2026-08-13", "2026-08-13");
    expect(out).not.toContain("2026-08-10");
    expect(out).not.toContain("2026-08-11");
  });

  it("still fills a genuine gap ahead of the revisable window", () => {
    expect(datesToCompute(week, "2026-08-10", "2026-08-13")).toEqual([
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
    ]);
  });

  it("computes everything when the fund has no snapshots yet", () => {
    expect(datesToCompute(week, null, "2026-08-13")).toEqual(week);
  });
});
