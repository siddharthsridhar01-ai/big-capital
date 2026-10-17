/**
 * Sharpe is measured against the cash rate, from daily returns.
 *
 * It previously used a risk-free rate of zero, which overstates Sharpe whenever
 * cash pays anything at all.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { sharpeFromDaily } from "../src/lib/performance";

const RF = 0.0365;
const days = (n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => new Decimal(f(i)));

describe("sharpeFromDaily", () => {
  it("is withheld below the minimum history", () => {
    expect(sharpeFromDaily(days(10, () => 0.001), RF, 20)).toBeNull();
  });

  it("reports the number of days it covers", () => {
    const r = sharpeFromDaily(days(60, (i) => (i % 2 ? 0.004 : -0.002)), RF, 20);
    expect(r?.days).toBe(60);
  });

  it("is lower against the cash rate than against zero", () => {
    const series = days(120, (i) => (i % 3 === 0 ? 0.006 : -0.0015));
    const vsCash = sharpeFromDaily(series, RF, 20)!.sharpe;
    const vsZero = sharpeFromDaily(series, 0, 20)!.sharpe;
    expect(vsCash).toBeLessThan(vsZero);
  });

  it("is roughly zero for a fund that only earns the cash rate", () => {
    // Earning exactly the daily cash rate, with small symmetric noise.
    const rfDaily = RF / 252;
    const series = days(200, (i) => rfDaily + (i % 2 ? 0.003 : -0.003));
    expect(Math.abs(sharpeFromDaily(series, RF, 20)!.sharpe)).toBeLessThan(0.2);
  });

  it("is negative when the fund trails cash", () => {
    const series = days(100, (i) => (i % 2 ? 0.001 : -0.0015));
    expect(sharpeFromDaily(series, RF, 20)!.sharpe).toBeLessThan(0);
  });

  it("ignores missing days rather than treating them as zero returns", () => {
    const withGaps = [...days(30, (i) => (i % 2 ? 0.004 : -0.002)), null, null];
    expect(sharpeFromDaily(withGaps, RF, 20)?.days).toBe(30);
  });
});
