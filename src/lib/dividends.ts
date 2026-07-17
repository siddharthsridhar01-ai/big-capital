/**
 * Pure dividend logic — no DB, no network. Tested in tests/dividends.test.ts.
 *
 * Fund-accounting model:
 *   - A cash dividend is booked as a `dividend` transaction: cash in, no change
 *     to the share count. Positions stay valued at UNADJUSTED close, so booking
 *     the cash here is what turns price-return into total-return (booking cash
 *     AND using adjusted-close would double-count).
 *   - Holder is determined as of the ex-date (shares held then earn it).
 *   - A short position (negative shares) PAYS the dividend — the sign falls out
 *     of perShare * sharesHeld automatically.
 */
import Decimal from "decimal.js";

export type Currency = "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD";

export interface RawDividend {
  date: string; // ex-date, YYYY-MM-DD
  value: number; // may be split-adjusted
  unadjustedValue: number | null; // actual cash paid per share at the time
  currency: string | null;
}

/**
 * Per-share cash to book. Prefer `unadjustedValue` — the actual cash paid per
 * share on the date — because `value` is back-adjusted for later splits and
 * would misstate the cash a historical holding received.
 */
export function selectPerShareRaw(div: RawDividend): number | null {
  const v = div.unadjustedValue ?? div.value;
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

/**
 * Map an EODHD dividend's currency + amount onto a supported base-enum currency.
 * London-listed names frequently report dividends in pence (GBX / GBp) — those
 * must be divided by 100 to become GBP, or the fund is credited 100x too much.
 * Returns null for a currency we can't represent (caller skips + logs).
 */
export function normalizeDividend(
  rawCurrency: string | null,
  perShareRaw: number,
  securityCurrency: Currency
): { currency: Currency; perShare: Decimal } | null {
  const raw = (rawCurrency ?? "").trim();

  // Pence variants — check the raw string BEFORE upper-casing, because
  // "GBp".toUpperCase() collides with "GBP" (pounds).
  if (raw === "GBX" || raw === "GBp") {
    return { currency: "GBP", perShare: new Decimal(perShareRaw).dividedBy(100) };
  }

  const up = raw.toUpperCase();
  if (up === "GBP" || up === "USD" || up === "EUR") {
    return { currency: up as Currency, perShare: new Decimal(perShareRaw) };
  }

  // No currency reported — fall back to the security's own currency.
  if (raw === "") {
    return { currency: securityCurrency, perShare: new Decimal(perShareRaw) };
  }

  return null; // unsupported (e.g. JPY, CHF) — cannot book to a GBP/USD/EUR book
}

/** Signed cash impact in the dividend's currency. Sign carried by sharesHeld. */
export function dividendCashImpact(perShare: Decimal, sharesHeld: Decimal): Decimal {
  return perShare.times(sharesHeld);
}

/** Book only when there's a real per-share amount and a non-zero holding. */
export function shouldBookDividend(perShare: Decimal, sharesHeld: Decimal): boolean {
  return perShare.greaterThan(0) && !sharesHeld.isZero();
}

/** Idempotency key: one dividend per (fund, security, ex-date). */
export function dividendDedupeKey(fundId: string, securityId: string, exDate: string): string {
  return `${fundId}|${securityId}|${exDate}`;
}
