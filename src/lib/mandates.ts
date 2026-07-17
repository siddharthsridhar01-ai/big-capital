/**
 * Per-fund mandate rules governing what may be added to a fund's watchlist.
 * Only geographically-restricted funds need an entry; funds with no entry are
 * unrestricted (global). Keyed by fund slug.
 */
export interface Mandate {
  /** Human label for the mandate, used in messages/hints. */
  label: string;
  /** If set, only these (normalised) currencies may be added. */
  allowedCurrencies?: string[];
  /** If set, only these internal exchange codes may be added. */
  allowedExchanges?: string[];
  /** Short hint shown in the add UI. */
  hint?: string;
}

export const FUND_MANDATES: Record<string, Mandate> = {
  "uk-equity": {
    label: "UK-listed equities",
    allowedCurrencies: ["GBP"],
    allowedExchanges: ["LSE"],
    hint: "UK-listed names only (London Stock Exchange).",
  },
  // global-equity, long-short, market-neutral, systematic-equity: unrestricted.
};

export function checkMandate(
  fundSlug: string,
  currency: string,
  exchange: string
): { ok: true } | { ok: false; reason: string } {
  const m = FUND_MANDATES[fundSlug];
  if (!m) return { ok: true };
  if (m.allowedCurrencies && !m.allowedCurrencies.includes(currency)) {
    return { ok: false, reason: `This fund's mandate is ${m.label}. A ${currency}-priced security can't be added here.` };
  }
  if (m.allowedExchanges && !m.allowedExchanges.includes(exchange)) {
    return { ok: false, reason: `This fund's mandate is ${m.label}. A listing on ${exchange} can't be added here.` };
  }
  return { ok: true };
}

export function mandateHint(fundSlug: string): string | null {
  return FUND_MANDATES[fundSlug]?.hint ?? null;
}
