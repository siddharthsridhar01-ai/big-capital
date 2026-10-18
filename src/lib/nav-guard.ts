/**
 * The NAV valuation-point guard.
 *
 * A NAV must be struck at the same valuation point every day: every holding at
 * its own official close for that date. So for a RECENT date, the fund waits
 * until every holding has closed. For a SETTLED date (two days or older), a
 * missing close means the security genuinely did not trade, and carrying the
 * previous close forward is correct.
 *
 * DORMANT HOLDINGS. That rule had a failure mode: a holding that will NEVER
 * close again. A completed takeover delists the target, so a recent date can
 * never have every holding closed, and the fund's NAV could only ever strike
 * once a date was two days old. It ran permanently two days behind, the
 * freshness watchdog fired on every Market tick — an email every hour,
 * indefinitely — and the public page showed a visibly stale NAV. One dead
 * holding froze the whole fund.
 *
 * So a holding with no official close for more than DORMANT_AFTER_DAYS is
 * excluded from the wait — but only while other holdings ARE closing. If nothing
 * closed at all, that is a data outage, and waiting (so the watchdog fires) is
 * still the right response. It is still valued, at its last price, and the
 * corporate action check flags it nightly until someone books what happened.
 * Five days clears the longest normal market closures (Easter, Christmas), so a
 * holiday is never mistaken for a delisting.
 *
 * This lived inline in compute-nav, and its test re-implemented the logic
 * rather than importing it — so the test could pass while the real guard
 * drifted. It is a single exported function now, used by both.
 */

export const SETTLED_AFTER_DAYS = 2;
export const DORMANT_AFTER_DAYS = 5;

export interface NavGuardInput {
  /** Securities whose closes prove the day is finished — normally the holdings. */
  evidenceIds: string[];
  /** Securities with an official close ON the date being valued. */
  closedForDate: Set<string>;
  /** Each security's most recent official close on or before the date. */
  lastCloseDate: Map<string, string>;
  /** The date being valued, YYYY-MM-DD. */
  date: string;
  /** How many days old that date is, relative to today. */
  ageDays: number;
}

export interface NavGuardResult {
  /** True when NAV for this date should not be struck yet. */
  wait: boolean;
  /** Holdings excluded from the wait because they have stopped closing. */
  dormant: string[];
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000
  );
}

export function navGuard(input: NavGuardInput): NavGuardResult {
  const { evidenceIds, closedForDate, lastCloseDate, date, ageDays } = input;
  if (evidenceIds.length === 0) return { wait: false, dormant: [] };

  // DORMANCY APPLIES ONLY WHILE DATA IS FLOWING.
  //
  // A delisting looks like ONE holding going quiet while the rest keep closing.
  // A data outage looks like EVERYTHING going quiet. If nothing closed on this
  // date, it is an outage or a market holiday, and the fund must keep waiting so
  // the freshness watchdog fires — treating every holding as dormant would strike
  // NAV at stale prices and turn a loud failure into a silent flat line.
  const anyClosed = evidenceIds.some((id) => closedForDate.has(id));

  // A holding is dormant only if we have seen it close before and that was long
  // ago. One with no close history at all is NOT dormant: that is missing data,
  // and the missing-price check downstream must still catch it.
  const dormant = anyClosed
    ? evidenceIds.filter((id) => {
        if (closedForDate.has(id)) return false;
        const last = lastCloseDate.get(id);
        return last != null && daysBetween(last, date) > DORMANT_AFTER_DAYS;
      })
    : [];
  const dormantSet = new Set(dormant);
  const active = evidenceIds.filter((id) => !dormantSet.has(id));

  // Every holding has stopped closing: nothing to wait for. Value at last prices.
  if (active.length === 0) return { wait: false, dormant };

  const missing = active.filter((id) => !closedForDate.has(id));
  const settled = ageDays >= SETTLED_AFTER_DAYS;
  const wait = settled
    ? missing.length === active.length // settled: wait only if nothing closed at all
    : missing.length > 0; // recent: every active holding must have closed

  return { wait, dormant };
}
