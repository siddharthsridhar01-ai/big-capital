/**
 * Corporate action accounting — pure functions, no database.
 *
 * A corporate action is a RESTATEMENT, not a trade. A split changes how many
 * shares represent the same holding; it does not buy or sell anything, so it
 * must preserve the position's total cost basis and book no realised P&L.
 *
 * This matters because both position reconstructions in the system would
 * otherwise treat a corporate_action row as a trade:
 *
 *   - performance.ts keeps the old per-share cost on a REDUCTION, so a 1-for-10
 *     reverse split would leave a tenth of the shares at the old cost — every
 *     P&L figure wrong by a factor of ten.
 *   - portfolio.ts (the live dashboard) would treat the reduction as a SALE at a
 *     price of zero, booking a fake realised loss equal to the cost basis of the
 *     shares removed.
 *
 * Restating with cost basis preserved is correct for forward and reverse splits
 * alike, for long and short positions.
 */
import Decimal from "decimal.js";

export interface Restated {
  quantity: Decimal;
  avgCostNative: Decimal;
}

/**
 * Apply a share-count change while preserving total cost basis.
 * Returns null when the position is restated to zero.
 */
export function restatePosition(
  quantity: Decimal,
  avgCostNative: Decimal,
  delta: Decimal
): Restated | null {
  const newQty = quantity.plus(delta);
  if (newQty.isZero()) return null;
  const totalCost = avgCostNative.times(quantity.abs());
  return { quantity: newQty, avgCostNative: totalCost.dividedBy(newQty.abs()) };
}

export interface SplitPlan {
  /** New shares per old share, e.g. 10 for a 10-for-1, 0.1 for a 1-for-10. */
  ratio: Decimal;
  /** Exact post-split holding, which may be fractional. */
  exactShares: Decimal;
  /** Whole shares actually held after fractions are cashed out. */
  wholeShares: Decimal;
  /** Fractional entitlement settled as cash in lieu (signed like the position). */
  fractional: Decimal;
  /** Share change for the restatement entry: exactShares - held. */
  restateDelta: Decimal;
}

/**
 * Plan a split of `held` shares at `numerator`-for-`denominator`.
 *
 * Mirrors what a broker does: every share becomes `ratio` shares, and any
 * fraction left over is not held but paid out as cash in lieu at a reference
 * price. A 3-for-2 split of 25 shares gives 37.5; the holder keeps 37 and is
 * paid for the half. Truncation is toward zero, so shorts behave identically.
 */
export function planSplit(held: Decimal, numerator: number, denominator: number): SplitPlan {
  if (!(numerator > 0) || !(denominator > 0)) {
    throw new Error(`Invalid split ratio ${numerator}:${denominator}`);
  }
  const ratio = new Decimal(numerator).dividedBy(denominator);
  const exactShares = held.times(ratio);
  const wholeShares = exactShares.truncated();
  const fractional = exactShares.minus(wholeShares);
  return {
    ratio,
    exactShares,
    wholeShares,
    fractional,
    restateDelta: exactShares.minus(held),
  };
}

/**
 * The cash-in-lieu settlement for a fractional entitlement.
 *
 * Removes the fraction from the position and pays (or, for a short, charges)
 * its value at the reference price. Booked as an ordinary disposal so realised
 * P&L on the fraction is computed against the restated cost basis.
 */
export function cashInLieu(fractional: Decimal, referencePrice: Decimal) {
  return {
    quantity: fractional.negated(),
    cashImpact: fractional.times(referencePrice),
    transactionType: (fractional.greaterThan(0) ? "sell" : "cover") as "sell" | "cover",
  };
}

/** Human-readable ratio for ledger narratives: "10-for-1", "1-for-10", "3-for-2". */
export function describeSplit(numerator: number, denominator: number): string {
  return `${numerator}-for-${denominator}`;
}

/** Stable key so a split is never booked twice for the same fund and ex-date. */
export function splitDedupeKey(fundId: string, securityId: string, exDate: string): string {
  return `${fundId}|${securityId}|${exDate}|split`;
}

// ---------------------------------------------------------------------------
// Detection — the events that cannot be safely automated
// ---------------------------------------------------------------------------
//
// Takeovers, mergers, spin-offs and rights issues are not processed
// automatically, and deliberately so: their terms involve elections, proration
// and cash-in-lieu that no free data feed carries reliably, which is why fund
// administrators route them to a corporate actions team rather than automating
// them. What CAN be automated is noticing them.
//
// They share two signatures, both visible in prices alone:
//   - A large one-day move with no booked corporate action. Large caps
//     essentially never move 25% in a day without a split, spin-off, rights
//     issue, takeover bid or bad data.
//   - A holding that stops being priced. A completed takeover delists the
//     target; the system would otherwise carry its last price forward
//     indefinitely, with the cash never credited and the position never closed.

/** One-day move, in either direction, treated as a likely corporate action. */
export const LARGE_MOVE_THRESHOLD = 0.25;

/**
 * Calendar days without a price before a holding is flagged. Seven covers the
 * longest exchange holiday runs (Easter, Christmas) without false alarms.
 */
export const STALE_PRICE_DAYS = 7;

export interface HeldPriceObservation {
  fund: string;
  securityId: string;
  ticker: string;
  latestDate: string | null;
  latestClose: Decimal | null;
  previousClose: Decimal | null;
}

export type CorporateActionAlert =
  | { kind: "large_move"; fund: string; ticker: string; date: string; move: number; message: string }
  | { kind: "stale_price"; fund: string; ticker: string; lastPriced: string | null; days: number; message: string };

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);
}

/**
 * Flag held securities whose prices suggest an event nobody has processed.
 *
 * `booked` holds "securityId|YYYY-MM-DD" for every corporate action already in
 * the ledger, so a split the processor has handled is not reported again.
 */
export function detectCorporateActions(
  observations: HeldPriceObservation[],
  booked: Set<string>,
  today: string
): CorporateActionAlert[] {
  const alerts: CorporateActionAlert[] = [];

  for (const o of observations) {
    if (!o.latestDate || !o.latestClose) {
      alerts.push({
        kind: "stale_price",
        fund: o.fund,
        ticker: o.ticker,
        lastPriced: null,
        days: Infinity,
        message: `${o.ticker} (held by ${o.fund}) has no price in the last 30 days — likely delisted, taken over or renamed.`,
      });
      continue;
    }

    const age = daysBetween(o.latestDate, today);
    if (age > STALE_PRICE_DAYS) {
      alerts.push({
        kind: "stale_price",
        fund: o.fund,
        ticker: o.ticker,
        lastPriced: o.latestDate,
        days: age,
        message:
          `${o.ticker} (held by ${o.fund}) has not been priced for ${age} days. ` +
          `Likely a completed takeover, delisting or ticker change. It is being valued ` +
          `at its last price, and any cash due has not been credited.`,
      });
      continue;
    }

    if (o.previousClose && !o.previousClose.isZero()) {
      const move = o.latestClose.dividedBy(o.previousClose).minus(1).toNumber();
      if (Math.abs(move) > LARGE_MOVE_THRESHOLD && !booked.has(`${o.securityId}|${o.latestDate}`)) {
        alerts.push({
          kind: "large_move",
          fund: o.fund,
          ticker: o.ticker,
          date: o.latestDate,
          move,
          message:
            `${o.ticker} (held by ${o.fund}) moved ${(move * 100).toFixed(1)}% on ${o.latestDate} ` +
            `with no corporate action booked. Check for a spin-off, rights issue, takeover ` +
            `bid or unprocessed split before trusting today's NAV.`,
        });
      }
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Early warning — what SEC filings and headlines mean
// ---------------------------------------------------------------------------
//
// Yahoo has no structured takeover event, but for US-listed securities it does
// expose SEC filings, and those are the official paper trail of a deal from
// first stake to delisting. Form 25-NSE in particular is the exchange
// confirming the stock has been removed — the one signal that distinguishes a
// completed takeover from a ticker change or data outage, which prices alone
// cannot. European stocks file nothing with the SEC, so for them the best
// available signal is headlines.

export type WarningSeverity = "info" | "warning" | "critical";

export interface FilingMeaning {
  severity: WarningSeverity;
  meaning: string;
}

/**
 * SEC filing types that bear on a corporate action, and what each means for a
 * holder. Anything not listed (10-K, 10-Q, routine 8-Ks) is ignored.
 */
export const SEC_FILING_MEANINGS: Record<string, FilingMeaning> = {
  "25-NSE": {
    severity: "critical",
    meaning: "The exchange has filed to delist this security — a deal has completed or the listing is ending.",
  },
  "SC 13D": {
    severity: "warning",
    meaning: "An investor has taken a stake of 5% or more with intent to influence — often the first sign of a bid.",
  },
  "SC 13D/A": {
    severity: "info",
    meaning: "An activist or strategic holder has changed its stake.",
  },
  "425": {
    severity: "warning",
    meaning: "A business combination has been announced and its communications filed.",
  },
  "S-4": {
    severity: "warning",
    meaning: "Shares are being registered for a merger — likely a stock-for-stock deal.",
  },
  "S4": {
    severity: "warning",
    meaning: "Shares are being registered for a merger — likely a stock-for-stock deal.",
  },
  "S-4/A": {
    severity: "info",
    meaning: "The merger registration has been amended.",
  },
  "SC14D9C": {
    severity: "warning",
    meaning: "The company is responding to a tender offer for its shares.",
  },
  "DEFA14A": {
    severity: "info",
    meaning: "Additional proxy material — may relate to a shareholder vote on a deal.",
  },
};

export function classifyFiling(type: string): FilingMeaning | null {
  return SEC_FILING_MEANINGS[type] ?? null;
}

/**
 * Headline phrases that indicate a corporate action. Deliberately specific
 * phrases rather than single words: "acquisition" alone matches every company
 * that bought a smaller one, which is noise for its shareholders. What matters
 * is the HELD company being acquired, merging, or spinning something off.
 */
const NEWS_PATTERNS: Array<{ pattern: RegExp; severity: WarningSeverity; label: string }> = [
  { pattern: /\b(to be acquired|agrees? to be (bought|acquired)|takeover (bid|offer|approach)|tender offer|buyout offer)\b/i, severity: "warning", label: "possible takeover" },
  { pattern: /\b(recommended (cash )?offer|firm offer|possible offer|rule 2\.[47])\b/i, severity: "warning", label: "UK takeover code announcement" },
  { pattern: /\b(merger agreement|agree(s|d)? to merge|all-share (merger|deal)|stock-for-stock)\b/i, severity: "warning", label: "possible merger" },
  { pattern: /\b(spin[- ]?off|spins? off|demerger|demerge[sd]?|separation of)\b/i, severity: "warning", label: "possible spin-off" },
  { pattern: /\b(rights issue|rights offering)\b/i, severity: "info", label: "possible rights issue" },
  { pattern: /\b(delist(ed|ing)?|taken private|go(es|ing)? private)\b/i, severity: "warning", label: "possible delisting" },
];

export function classifyHeadline(title: string): { severity: WarningSeverity; label: string } | null {
  for (const p of NEWS_PATTERNS) {
    if (p.pattern.test(title)) return { severity: p.severity, label: p.label };
  }
  return null;
}
