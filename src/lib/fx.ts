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
