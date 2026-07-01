import { describe, it, expect } from "vitest";
import {
  computePeriodReturns,
  computeMaxDrawdownPct,
  type SnapshotRow,
} from "../src/lib/public-performance";

// Build a daily series with constant daily return r over `days` ending at asOf.
function series(startDate: string, dailyReturns: (number | null)[]): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  const d = new Date(`${startDate}T00:00:00Z`);
  for (const r of dailyReturns) {
    rows.push({
      date: d.toISOString().slice(0, 10),
      dailyReturn: r === null ? null : String(r),
      benchmarkDailyReturn: null,
    });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return rows;
}

describe("computePeriodReturns", () => {
  it("returns nulls for an empty series", () => {
    const r = computePeriodReturns([]);
    expect(r.sinceInception).toBeNull();
    expect(r.oneMonth).toBeNull();
  });

  it("since-inception chains all daily returns (TWR)", () => {
    // Two days of +10% each -> (1.1 * 1.1) - 1 = 0.21
    const snaps = series("2026-06-01", [null, 0.1, 0.1]);
    expect(computePeriodReturns(snaps).sinceInception).toBeCloseTo(0.21, 6);
  });

  it("one-month window excludes returns older than a month", () => {
    // 40 days of ~0; last ~30 days carry a single +5% on the final day.
    const rets: (number | null)[] = new Array(40).fill(0);
    rets[39] = 0.05;
    const snaps = series("2026-05-01", rets);
    const r = computePeriodReturns(snaps);
    // The +5% is within the last month -> ~0.05
    expect(r.oneMonth).toBeCloseTo(0.05, 6);
  });
});

describe("computeMaxDrawdownPct", () => {
  it("is zero for a monotonically rising series", () => {
    const snaps = series("2026-06-01", [null, 0.01, 0.01, 0.01]);
    expect(computeMaxDrawdownPct(snaps)).toBeCloseTo(0, 6);
  });

  it("captures the largest peak-to-trough decline", () => {
    // up 10%, then down 20% -> drawdown from 1.1 to 0.88 = 0.2
    const snaps = series("2026-06-01", [null, 0.1, -0.2]);
    expect(computeMaxDrawdownPct(snaps)).toBeCloseTo(0.2, 6);
  });

  it("returns null for an empty series", () => {
    expect(computeMaxDrawdownPct([])).toBeNull();
  });
});
