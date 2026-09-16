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
