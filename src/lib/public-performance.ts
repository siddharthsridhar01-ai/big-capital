/**
 * Public-site performance helpers.
 *
 * All figures here are derived ONLY from nav_snapshots (aggregate fund-level
 * NAV time series) — never from live positions. This is the privacy boundary
 * for the public site: it shows performance, never current holdings.
 */

import Decimal from "decimal.js";
import {
  timeWeightedReturn,
  annualiseReturn,
  annualisedVolatility,
  sharpeRatio,
  maxDrawdown,
} from "@/lib/performance";

export interface SnapshotRow {
  date: string;
  dailyReturn: string | null;
  benchmarkDailyReturn: string | null;
}

export interface FundPerformance {
  hasData: boolean;
  // Since-inception cumulative returns (fractions, e.g. 0.072 = 7.2%)
  cumulativeReturn: number | null;
  benchmarkCumulative: number | null;
  excess: number | null;
  // Annualised figures — only meaningful (and only computed) at >= 1 year
  annualisedReturn: number | null;
  annualisedVol: number | null;
  sharpe: number | null;
  calendarDays: number;
  isAnnualised: boolean;
  // Rebased cumulative-return series (%) for charting
  fundSeries: { date: string; pct: number }[];
  benchmarkSeries: { date: string; pct: number }[];
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function computeFundPerformance(
  snaps: SnapshotRow[],
  inceptionDate: string
): FundPerformance {
  if (snaps.length === 0) {
    return {
      hasData: false,
      cumulativeReturn: null,
      benchmarkCumulative: null,
      excess: null,
      annualisedReturn: null,
      annualisedVol: null,
      sharpe: null,
      calendarDays: 0,
      isAnnualised: false,
      fundSeries: [],
      benchmarkSeries: [],
    };
  }

  const dailyReturns = snaps.map((s) =>
    s.dailyReturn != null ? new Decimal(s.dailyReturn) : null
  );
  const hasBenchmark = snaps.some((s) => s.benchmarkDailyReturn != null);
  const benchReturns = snaps.map((s) =>
    s.benchmarkDailyReturn != null ? new Decimal(s.benchmarkDailyReturn) : null
  );

  const cum = timeWeightedReturn(dailyReturns);
  const benchCum = hasBenchmark ? timeWeightedReturn(benchReturns) : null;
  const excess = benchCum != null ? cum.minus(benchCum) : null;

  const latestDate = snaps[snaps.length - 1].date;
  const calendarDays = daysBetween(inceptionDate, latestDate);
  const isAnnualised = calendarDays >= 365;

  let annualisedReturn: Decimal | null = null;
  let sharpe: Decimal | null = null;
  const annualisedVol = annualisedVolatility(dailyReturns);
  if (isAnnualised) {
    annualisedReturn = annualiseReturn(cum, calendarDays);
    sharpe = sharpeRatio(annualisedReturn, new Decimal(0), annualisedVol);
  }

  // Rebased cumulative series (start at 0%)
  const buildSeries = (returns: (Decimal | null)[]) => {
    let acc = new Decimal(1);
    return snaps.map((s, i) => {
      const r = returns[i];
      if (r) acc = acc.times(r.plus(1));
      return { date: s.date, pct: acc.minus(1).times(100).toNumber() };
    });
  };

  return {
    hasData: true,
    cumulativeReturn: cum.toNumber(),
    benchmarkCumulative: benchCum != null ? benchCum.toNumber() : null,
    excess: excess != null ? excess.toNumber() : null,
    annualisedReturn: annualisedReturn != null ? annualisedReturn.toNumber() : null,
    annualisedVol: annualisedVol.toNumber(),
    sharpe: sharpe != null ? sharpe.toNumber() : null,
    calendarDays,
    isAnnualised,
    fundSeries: buildSeries(dailyReturns),
    benchmarkSeries: hasBenchmark ? buildSeries(benchReturns) : [],
  };
}

export function pctLabel(v: number | null, withSign = true): string {
  if (v == null) return "—";
  const pct = v * 100;
  const sign = withSign && pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Period returns + drawdown (public factsheet)
// ---------------------------------------------------------------------------

export interface PeriodReturns {
  oneMonth: number | null;
  threeMonth: number | null;
  sixMonth: number | null;
  ytd: number | null;
  sinceInception: number | null;
}

function subMonths(ymd: string, months: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** TWR over the window (startExclusive, asOf], or null if no returns fall in it. */
function periodReturn(snaps: SnapshotRow[], startExclusive: string, asOf: string): number | null {
  const rets = snaps
    .filter((s) => s.date > startExclusive && s.date <= asOf)
    .map((s) => (s.dailyReturn != null ? new Decimal(s.dailyReturn) : null));
  if (rets.length === 0) return null;
  return timeWeightedReturn(rets).toNumber();
}

/** Trailing-period and YTD/since-inception cumulative returns from the NAV series. */
export function computePeriodReturns(snaps: SnapshotRow[]): PeriodReturns {
  if (snaps.length === 0) {
    return { oneMonth: null, threeMonth: null, sixMonth: null, ytd: null, sinceInception: null };
  }
  const asOf = snaps[snaps.length - 1].date;
  const prevYearEnd = `${Number(asOf.slice(0, 4)) - 1}-12-31`;
  return {
    oneMonth: periodReturn(snaps, subMonths(asOf, 1), asOf),
    threeMonth: periodReturn(snaps, subMonths(asOf, 3), asOf),
    sixMonth: periodReturn(snaps, subMonths(asOf, 6), asOf),
    ytd: periodReturn(snaps, prevYearEnd, asOf),
    sinceInception: periodReturn(snaps, "0000-01-01", asOf),
  };
}

/** Maximum peak-to-trough drawdown (positive fraction, e.g. 0.021 = 2.1%). */
export function computeMaxDrawdownPct(snaps: SnapshotRow[]): number | null {
  if (snaps.length === 0) return null;
  let level = new Decimal(1);
  const series: Decimal[] = [level];
  for (const s of snaps) {
    if (s.dailyReturn != null) level = level.times(new Decimal(1).plus(s.dailyReturn));
    series.push(level);
  }
  return maxDrawdown(series).toNumber();
}
