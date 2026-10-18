/**
 * Resolve FX (from -> to) for a given date using the stored daily ECB rates,
 * falling back to the hardened static table only if no stored rate exists.
 * This is the accurate path used at trade time so each transaction captures a
 * real market rate (important for volatile non-major currencies).
 */
import { db } from "@/db/client";
import { fxRates } from "@/db/schema";
import { and, eq, lte, desc } from "drizzle-orm";
import Decimal from "decimal.js";
import { staticFxFallback } from "@/lib/portfolio";
import type { Currency } from "@/lib/performance";

export async function resolveFxToBase(from: Currency, to: Currency, dateStr: string): Promise<Decimal> {
  if (from === to) return new Decimal(1);
  const rows = await db
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(and(eq(fxRates.fromCurrency, from), eq(fxRates.toCurrency, to), lte(fxRates.date, dateStr)))
    .orderBy(desc(fxRates.date))
    .limit(1);
  if (rows.length > 0) return new Decimal(rows[0].rate);
  return staticFxFallback(from, to);
}

/**
 * Current rate to the base currency for each of `currencies`: the latest stored
 * ECB rate, falling back to the static table only if none is stored.
 *
 * For valuing a portfolio TODAY. Holdings and cash in the same currency must be
 * converted at the same current rate, or a fund that bought euro stocks with
 * pounds — long euro shares, short euro cash — would show currency gains and
 * losses that do not exist.
 */
export async function currentFxToBase(
  currencies: Iterable<string>,
  base: Currency
): Promise<Map<string, Decimal>> {
  const today = new Date().toISOString().slice(0, 10);
  const out = new Map<string, Decimal>();
  for (const c of new Set(currencies)) {
    out.set(c, await resolveFxToBase(c as Currency, base, today));
  }
  return out;
}

/**
 * The FX map the compliance engine needs: a rate to base for EVERY currency the
 * fund holds or has cash in, keyed "FROM/BASE/YYYY-MM-DD".
 *
 * The engine values every position and every cash balance in base currency, and
 * throws on a missing rate. Callers used to supply only the TRADE's currency —
 * fine while no fund held two foreign currencies, but once the European fund
 * held euros, buying a Swiss stock needed the euro rate to value what it already
 * owned, and the trade failed. Every currency in play has to be present.
 *
 * `fixed` pins a currency to a known rate — the trade's own currency at its fill
 * rate — so the check and the booking use the same number.
 */
export async function fxRateMapForEngine(
  currencies: Iterable<string>,
  base: Currency,
  dateStr: string,
  fixed?: { currency: string; rate: Decimal }
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const c of new Set(currencies)) {
    if (c === base) continue;
    const rate =
      fixed && fixed.currency === c ? fixed.rate : await resolveFxToBase(c as Currency, base, dateStr);
    out.set(`${c}/${base}/${dateStr}`, rate.toString());
  }
  return out;
}
