/**
 * Benchmark proxies — set the long-only funds' benchmark securities to
 * accumulating (total-return) ETF proxies and VALIDATE them against Yahoo in
 * the same call. Auto-picks the first candidate per benchmark that returns a
 * live price; only writes the record on success.
 *
 *   /api/admin/set-benchmark-proxies?secret=<CRON_SECRET>
 *
 * Because the chosen proxies are LSE-listed (exchange "LSE" → symbol ".L"), the
 * existing EOD price cron (which fetches every active security whose exchange
 * isn't "INDEX") will pick them up automatically — no worker change needed.
 *
 * The synthetic cash benchmark (SOFR_CASH) used by long-short / market-neutral
 * is NOT a Yahoo fetch; its daily return is accrued in the NAV step (next
 * deliverable), so this route deliberately leaves it alone.
 *
 * Idempotent and re-runnable.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds, securities } from "@/db/schema";
import { eq } from "drizzle-orm";
import { yahooProvider } from "@/lib/intraday/yahoo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Option = {
  symbol: string;
  ticker: string;
  exchange: string;
  label: string;
};

const CANDIDATES: Record<string, { benchmarkName: string; baseCurrency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD"; options: Option[] }> = {
  "uk-equity": {
    benchmarkName: "FTSE All-Share (total-return proxy)",
    baseCurrency: "GBP",
    options: [
      { symbol: "FTAL.L", ticker: "FTAL", exchange: "LSE", label: "SPDR FTSE UK All Share UCITS ETF (Acc)" },
    ],
  },
  "global-equity": {
    benchmarkName: "MSCI World (total-return proxy)",
    baseCurrency: "USD",
    options: [
      { symbol: "IWDA.L", ticker: "IWDA", exchange: "LSE", label: "iShares Core MSCI World UCITS ETF USD (Acc), USD line" },
      { symbol: "XDWD.L", ticker: "XDWD", exchange: "LSE", label: "Xtrackers MSCI World UCITS ETF 1C (Acc)" },
      { symbol: "SWDA.L", ticker: "SWDA", exchange: "LSE", label: "iShares Core MSCI World UCITS ETF (Acc), GBP line — currency fallback only" },
    ],
  },
};

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

  // 1. Fetch every candidate symbol in one batch.
  const allSymbols = Object.values(CANDIDATES).flatMap((c) => c.options.map((o) => o.symbol));
  const quotes = await yahooProvider.fetchQuotes(allSymbols);
  const priceBySymbol = new Map<string, { price: number | null; currency: string | null }>();
  allSymbols.forEach((sym, i) => {
    const q = quotes[i];
    priceBySymbol.set(sym, {
      price: q && q.price != null && Number.isFinite(q.price) ? q.price : null,
      currency: q?.currency ?? null,
    });
  });

  const report: Array<Record<string, unknown>> = [];

  for (const [slug, cfg] of Object.entries(CANDIDATES)) {
    const checked = cfg.options.map((o) => ({
      symbol: o.symbol,
      label: o.label,
      price: priceBySymbol.get(o.symbol)?.price ?? null,
      currency: priceBySymbol.get(o.symbol)?.currency ?? null,
    }));

    const priced = cfg.options.filter((o) => priceBySymbol.get(o.symbol)?.price != null);
    // Prefer a proxy whose live currency matches the fund's base currency; only
    // fall back to a currency-mismatched one if nothing else priced.
    const matched = priced.find((o) => priceBySymbol.get(o.symbol)?.currency === cfg.baseCurrency);
    const chosen = matched ?? priced[0];

    if (!chosen) {
      report.push({ fund: slug, benchmark: cfg.benchmarkName, status: "no_valid_proxy", checked });
      continue;
    }

    const liveCurrency = priceBySymbol.get(chosen.symbol)?.currency ?? null;
    if (liveCurrency !== "GBP" && liveCurrency !== "USD" && liveCurrency !== "EUR") {
      report.push({ fund: slug, benchmark: cfg.benchmarkName, status: "unsupported_currency", chosen: chosen.symbol, liveCurrency, checked });
      continue;
    }
    const currencyWarning = liveCurrency !== cfg.baseCurrency;

    // Resolve the fund's benchmark security (create one if somehow missing).
    const fundRows = await db
      .select({ id: funds.id, benchmarkSecurityId: funds.benchmarkSecurityId })
      .from(funds)
      .where(eq(funds.slug, slug))
      .limit(1);
    if (fundRows.length === 0) {
      report.push({ fund: slug, status: "fund_not_found" });
      continue;
    }
    const fund = fundRows[0];

    if (fund.benchmarkSecurityId) {
      await db
        .update(securities)
        .set({
          ticker: chosen.ticker,
          exchange: chosen.exchange,
          currency: liveCurrency,
          name: cfg.benchmarkName,
          isBenchmark: true,
          isActive: true,
        })
        .where(eq(securities.id, fund.benchmarkSecurityId));
    } else {
      const inserted = await db
        .insert(securities)
        .values({
          ticker: chosen.ticker,
          exchange: chosen.exchange,
          currency: liveCurrency,
          name: cfg.benchmarkName,
          isBenchmark: true,
          isActive: true,
        })
        .returning({ id: securities.id });
      await db.update(funds).set({ benchmarkSecurityId: inserted[0].id }).where(eq(funds.id, fund.id));
    }

    report.push({
      fund: slug,
      benchmark: cfg.benchmarkName,
      status: "set",
      chosen: chosen.symbol,
      livePrice: priceBySymbol.get(chosen.symbol)?.price ?? null,
      currency: liveCurrency,
      fundBaseCurrency: cfg.baseCurrency,
      currencyWarning: currencyWarning ? `Proxy priced in ${liveCurrency} but fund base is ${cfg.baseCurrency} — using anyway; consider a ${cfg.baseCurrency} proxy` : null,
      checked,
    });
  }

  return NextResponse.json({
    ok: true,
    note: "Proxies that show a livePrice will be fetched by the EOD price cron automatically. SOFR_CASH (cash hurdle) is handled in the NAV step.",
    report,
  });
}
