/**
 * Price-sanity guardrail — pure, tested. Protects the immutable ledger from a
 * bad execution price (the one failure that can't be undone: a wrong price
 * stamped on a trade is permanent, and every downstream NAV faithfully repeats
 * it).
 *
 * The check is INDEPENDENT of what the user reviewed: it compares the execution
 * price against the last stored EOD close (a separate reference from the daily
 * feed). This catches the dangerous cases the "vs expected" check can't —
 * because those come from the same live feed and would agree with each other:
 *   - pence/pounds (GBX) unit errors  -> ~100x the reference
 *   - wrong-symbol or garbage quotes  -> wildly off the reference
 *   - non-positive / non-finite feed values
 *
 * Thresholds are deliberately wide (default 4x / 0.25x) so genuine large moves
 * (earnings gaps, volatile names) pass, while unit/symbol errors — which are an
 * order of magnitude or more off — are caught. When there is no reference close
 * yet (a security never priced), the check passes but reports checked:false so
 * the caller can record that no independent check was possible.
 */
import Decimal from "decimal.js";

export interface PriceSanityResult {
  ok: boolean;
  checked: boolean;
  ratio?: string;
  reason?: string;
}

export function checkPriceSanity(
  execPrice: Decimal,
  referenceClose: Decimal | null,
  opts?: { maxRatio?: number; minRatio?: number }
): PriceSanityResult {
  if (!execPrice.isFinite() || execPrice.lte(0)) {
    return { ok: false, checked: true, reason: "Execution price is not a positive, finite number." };
  }
  if (referenceClose == null || !referenceClose.isFinite() || referenceClose.lte(0)) {
    return { ok: true, checked: false }; // nothing to compare against
  }

  const maxR = new Decimal(opts?.maxRatio ?? 4);
  const minR = new Decimal(opts?.minRatio ?? 0.25);
  const ratio = execPrice.dividedBy(referenceClose);

  if (ratio.gt(maxR)) {
    return {
      ok: false,
      checked: true,
      ratio: ratio.toFixed(2),
      reason: `Execution price is ${ratio.toFixed(1)}x the last close — likely a unit (pence/pounds) or wrong-symbol error.`,
    };
  }
  if (ratio.lt(minR)) {
    return {
      ok: false,
      checked: true,
      ratio: ratio.toFixed(4),
      reason: `Execution price is only ${ratio.times(100).toFixed(1)}% of the last close — likely a unit or wrong-symbol error.`,
    };
  }
  return { ok: true, checked: true, ratio: ratio.toFixed(4) };
}
