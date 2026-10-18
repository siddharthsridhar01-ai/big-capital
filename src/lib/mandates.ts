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
  // Replaces the old "uk-equity" rule, which was keyed to a slug that no longer
  // exists after the conversion — leaving the European fund with no geographic
  // restriction at all. Shares received in a corporate action bypass this, as
  // they must: a fund receives an acquirer's shares whatever its mandate says.
  "european-equity": {
    label: "developed European equities",
    allowedCurrencies: ["GBP", "EUR", "CHF", "DKK", "SEK", "NOK"],
    allowedExchanges: [
      "LSE", "XETRA", "FRANKFURT", "EURONEXT PARIS", "EURONEXT AMSTERDAM",
      "EURONEXT BRUSSELS", "EURONEXT LISBON", "EURONEXT DUBLIN", "BORSA ITALIANA",
      "SIX", "COPENHAGEN", "STOCKHOLM", "OSLO", "HELSINKI", "MADRID", "VIENNA",
    ],
    hint: "European listings only — London, Euronext, Xetra, SIX, the Nordics, Madrid, Milan or Vienna.",
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
