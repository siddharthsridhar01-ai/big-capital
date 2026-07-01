/**
 * Reconciliation checks — pure, tested. The "does today's data look sane?"
 * layer. Failure-visibility (job_runs) catches a job that *broke*; this catches
 * a job that *ran but produced something suspicious* — a bad EOD price feeding
 * NAV, a NAV that doesn't tie out, an implausible day-over-day move. Anomalies
 * are surfaced on the admin health page rather than silently compounding into
 * the track record.
 *
 * Severity: "fail" = almost certainly wrong (NAV <= 0, cash+positions != NAV).
 *           "warn" = worth a human look (big drift/move, deeply negative cash).
 */
import Decimal from "decimal.js";

export interface Anomaly {
  severity: "warn" | "fail";
  check: string;
  message: string;
}

export interface SnapshotRecon {
  fundSlug: string;
  startingNav: Decimal;
  nav: Decimal;
  cashBalance: Decimal;
  positionValue: Decimal;
  previousNav: Decimal | null;
}

export function reconcileSnapshot(
  s: SnapshotRecon,
  opts?: { maxDriftFromStart?: number; maxDailyMove?: number }
): Anomaly[] {
  const out: Anomaly[] = [];

  // 1. NAV must be positive.
  if (s.nav.lte(0)) {
    out.push({ severity: "fail", check: "nav_positive", message: `${s.fundSlug}: NAV is ${s.nav.toFixed(2)} (should be > 0).` });
  }

  // 2. NAV must reconcile: cash + positions == NAV (by construction).
  const recomputed = s.cashBalance.plus(s.positionValue);
  const tolerance = Decimal.max(new Decimal("0.01"), s.nav.abs().times("0.0001"));
  if (recomputed.minus(s.nav).abs().gt(tolerance)) {
    out.push({
      severity: "fail",
      check: "nav_reconciles",
      message: `${s.fundSlug}: cash + positions (${recomputed.toFixed(2)}) does not equal NAV (${s.nav.toFixed(2)}).`,
    });
  }

  // 3. Base-currency cash deeply negative (beyond what shorts/FX explain).
  if (s.cashBalance.lt(s.startingNav.times("-0.5"))) {
    out.push({ severity: "warn", check: "cash_negative", message: `${s.fundSlug}: base cash is ${s.cashBalance.toFixed(2)}, unusually negative.` });
  }

  // 4. Drift from opening capital.
  if (s.startingNav.gt(0)) {
    const drift = s.nav.dividedBy(s.startingNav).minus(1).abs();
    const max = new Decimal(opts?.maxDriftFromStart ?? 0.5);
    if (drift.gt(max)) {
      out.push({ severity: "warn", check: "nav_drift", message: `${s.fundSlug}: NAV ${s.nav.toFixed(2)} is ${drift.times(100).toFixed(0)}% from opening ${s.startingNav.toFixed(2)}.` });
    }
  }

  // 5. Day-over-day NAV move (a big jump often means a bad price).
  if (s.previousNav && s.previousNav.gt(0)) {
    const move = s.nav.dividedBy(s.previousNav).minus(1).abs();
    const max = new Decimal(opts?.maxDailyMove ?? 0.15);
    if (move.gt(max)) {
      out.push({ severity: "warn", check: "nav_daily_move", message: `${s.fundSlug}: NAV moved ${move.times(100).toFixed(1)}% vs the previous day.` });
    }
  }

  return out;
}

export interface PricePair {
  ticker: string;
  exchange: string;
  today: Decimal;
  prev: Decimal;
}

export function reconcilePriceJumps(pairs: PricePair[], opts?: { maxMove?: number }): Anomaly[] {
  const out: Anomaly[] = [];
  const max = new Decimal(opts?.maxMove ?? 0.5); // 50% day-over-day
  for (const p of pairs) {
    if (p.prev.lte(0) || !p.today.isFinite()) continue;
    const move = p.today.dividedBy(p.prev).minus(1).abs();
    if (move.gt(max)) {
      out.push({
        severity: "warn",
        check: "price_jump",
        message: `${p.ticker}.${p.exchange}: price moved ${move.times(100).toFixed(0)}% day-over-day (${p.prev.toFixed(2)} → ${p.today.toFixed(2)}) — check for a bad quote.`,
      });
    }
  }
  return out;
}
