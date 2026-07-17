/**
 * Yahoo FX ingest — fills the currencies ECB does NOT publish (Taiwan's TWD,
 * and any others added to YAHOO_FX_CURRENCIES). Fetches the USD cross from
 * Yahoo, then derives the EUR/GBP crosses using the ECB rates already stored
 * for the same date, and upserts everything into `fx_rates` (source "YAHOO")
 * — so the rest of the system (compute-nav, resolveFxToBase) reads it exactly
 * like an ECB rate, no special-casing downstream.
 *
 *   /api/admin/ingest-yahoo-fx?secret=<CRON_SECRET>[&days=90]
 *
 * Run AFTER the ECB ingest so the USD->EUR / USD->GBP anchors exist for the
 * cross-derivation (if an anchor is missing for a date, that cross is skipped;
 * the USD cross is always stored regardless).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { fxRates } from "@/db/schema";
import { and, eq, gte } from "drizzle-orm";
import YahooFinance from "yahoo-finance2";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const yf = new YahooFinance();

// Currencies ECB does not publish, sourced from Yahoo instead.
const YAHOO_FX_CURRENCIES = ["TWD"];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice("Bearer ".length)
      : null);
  if (!provided || provided !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const days = Math.min(Number(url.searchParams.get("days") ?? 90) || 90, 400);
  const period1 = new Date(Date.now() - days * 86400000);
  const period2 = new Date();

  const rows: Array<{ fromCurrency: string; toCurrency: string; date: string; rate: number }> = [];
  const detail: Record<string, unknown> = {};

  for (const ccy of YAHOO_FX_CURRENCIES) {
    try {
      // Yahoo "USD{CCY}=X" close = units of CCY per 1 USD.
      const chart = await yf.chart(`USD${ccy}=X`, {
        period1,
        period2,
        interval: "1d",
      });
      const quotes = (chart?.quotes ?? []).filter(
        (q) => q.date && typeof q.close === "number" && q.close > 0
      );
      detail[ccy] = quotes.length;

      // Pull the ECB USD->EUR and USD->GBP anchors for the covered dates.
      const dateStrs = quotes.map((q) => q.date!.toISOString().slice(0, 10));
      const minDate = dateStrs.length ? dateStrs[0] : period1.toISOString().slice(0, 10);
      const anchors = await db
        .select({ from: fxRates.fromCurrency, to: fxRates.toCurrency, date: fxRates.date, rate: fxRates.rate })
        .from(fxRates)
        .where(and(eq(fxRates.fromCurrency, "USD"), gte(fxRates.date, minDate)));
      const usdTo = new Map<string, number>(); // "EUR/2026-06-01" -> rate
      for (const a of anchors) {
        if (a.to === "EUR" || a.to === "GBP") usdTo.set(`${a.to}/${String(a.date).slice(0, 10)}`, Number(a.rate));
      }

      for (const q of quotes) {
        const dateStr = q.date!.toISOString().slice(0, 10);
        const usdPerBaseCcy = q.close!; // CCY per USD
        const ccyToUsd = 1 / usdPerBaseCcy;
        // CCY <-> USD (always)
        rows.push({ fromCurrency: ccy, toCurrency: "USD", date: dateStr, rate: ccyToUsd });
        rows.push({ fromCurrency: "USD", toCurrency: ccy, date: dateStr, rate: usdPerBaseCcy });
        // CCY <-> EUR / GBP via the USD anchor (USD->X), if present
        for (const base of ["EUR", "GBP"] as const) {
          const usdToBase = usdTo.get(`${base}/${dateStr}`);
          if (usdToBase == null) continue;
          const ccyToBase = ccyToUsd * usdToBase; // 1 CCY = ccyToUsd USD = ccyToUsd*usdToBase base
          rows.push({ fromCurrency: ccy, toCurrency: base, date: dateStr, rate: ccyToBase });
          rows.push({ fromCurrency: base, toCurrency: ccy, date: dateStr, rate: 1 / ccyToBase });
        }
      }
    } catch (err) {
      detail[ccy] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, upserted: 0, detail });
  }

  const CHUNK = 200;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK).map((r) => ({
      fromCurrency: r.fromCurrency as "TWD" | "USD" | "EUR" | "GBP",
      toCurrency: r.toCurrency as "TWD" | "USD" | "EUR" | "GBP",
      date: r.date,
      rate: r.rate.toString(),
      source: "YAHOO",
    }));
    await db
      .insert(fxRates)
      .values(batch)
      .onConflictDoUpdate({
        target: [fxRates.fromCurrency, fxRates.toCurrency, fxRates.date],
        set: { rate: sql`excluded.rate`, source: sql`excluded.source` },
      });
    upserted += batch.length;
  }

  return NextResponse.json({ ok: true, upserted, detail });
}
