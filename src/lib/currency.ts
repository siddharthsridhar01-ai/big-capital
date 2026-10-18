/**
 * The single source of truth for supported currencies.
 *
 * This union was previously copy-pasted inline across ten component files, the
 * schema, the ECB client and the FX worker. Adding a currency meant finding
 * every copy, and missing one produced a type that silently disagreed with the
 * database enum.
 *
 * The Nordic and Swiss currencies were added when the UK fund became a European
 * one: Switzerland is roughly 15% of MSCI Europe, Sweden 5%, Denmark 4%, so
 * without them a quarter of the benchmark — Nestle, Roche, Novartis, Novo
 * Nordisk, Atlas Copco — was structurally unbuyable, and the tracking error
 * would have come from the platform rather than from anyone's decisions.
 *
 * Order matters: append only. Postgres enum values cannot be reordered or
 * removed without rebuilding the type.
 */

export const CURRENCIES = [
  "GBP",
  "USD",
  "EUR",
  "JPY",
  "HKD",
  "CNY",
  "KRW",
  "SGD",
  "INR",
  "TWD",
  "CHF",
  "DKK",
  "SEK",
  "NOK",
] as const;

export type Currency = (typeof CURRENCIES)[number];

/** ECB publishes a daily reference rate for each of these against EUR. */
export const ECB_CURRENCIES: Currency[] = [
  "GBP",
  "USD",
  "EUR",
  "JPY",
  "HKD",
  "CNY",
  "KRW",
  "SGD",
  "INR",
  "CHF",
  "DKK",
  "SEK",
  "NOK",
];

/**
 * Display prefix for each currency.
 *
 * Typed as Record<Currency, string>, so adding a currency to CURRENCIES without
 * a symbol is a COMPILE ERROR rather than a silent "$". That is exactly what
 * happened: sixteen hand-written ternaries knew only pounds and euros and called
 * everything else dollars, so Swiss franc prices showed as "$".
 *
 * The Swiss franc and the three Nordic krone/krona use the ISO code with a
 * space — "CHF 102.40", "DKK 650.00" — which is standard practice: "kr" alone
 * cannot distinguish Danish, Swedish and Norwegian, and the franc has no
 * widely used symbol.
 */
export const CURRENCY_SYMBOL: Record<Currency, string> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
  JPY: "¥",
  HKD: "HK$",
  CNY: "CN¥",
  KRW: "₩",
  SGD: "S$",
  INR: "₹",
  TWD: "NT$",
  CHF: "CHF ",
  DKK: "DKK ",
  SEK: "SEK ",
  NOK: "NOK ",
};

/**
 * The display prefix for a currency. An unrecognised code falls back to the code
 * itself, never to "$": showing the wrong currency is worse than showing a code.
 */
export function currencySymbol(ccy: string | null | undefined): string {
  if (!ccy) return "";
  return CURRENCY_SYMBOL[ccy as Currency] ?? `${ccy} `;
}

/**
 * Last-resort exchange rates, units per 1 EUR. Used ONLY when no stored ECB rate
 * exists — never as the rate a trade or valuation should normally use.
 *
 * Typed Record<Currency, number> for the same reason as the symbols: a currency
 * missing here used to make the lookup throw, and one caller caught that and
 * substituted a rate of 1 — so a Danish krone (about 11p) was valued as a pound.
 * Approximate levels; the Danish krone is pegged near 7.46.
 */
export const FALLBACK_PER_EUR: Record<Currency, number> = {
  EUR: 1,
  USD: 1.08,
  GBP: 0.84,
  JPY: 170,
  HKD: 8.4,
  CNY: 7.8,
  KRW: 1480,
  SGD: 1.45,
  INR: 90,
  TWD: 35,
  CHF: 0.94,
  DKK: 7.46,
  SEK: 11.2,
  NOK: 11.6,
};
