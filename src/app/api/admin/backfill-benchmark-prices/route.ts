/**
 * One-off — backfill historical daily closes for the priceable benchmark ETF
 * proxies (e.g. FTAL.L, IWDA.L) so the benchmark comparison has history back to
 * inception instead of only building forward from today.
 *
 *   /api/admin/backfill-benchmark-prices?secret=<CRON_SECRET>
 *   optional &from=YYYY-MM-DD  (default 2026-06-01, the fund inception)
 *
 * After running this, re-run the NAV backfill
 * (/api/admin/compute-nav?...&from=2026-06-01) so each snapshot picks up the
 * now-present benchmark prices and computes benchmarkDailyReturn.
 *
 * Only touches securities with isBenchmark=true AND a real exchange (not the
 * synthetic "INDEX" cash hurdle). Idempotent — upserts by (security, date).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { prices, securities } from "@/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import YahooFinance from "yahoo-finance2";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const yf = new YahooFinance();

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

  const from = url.searchParams.get("from") ?? "2026-06-01";
  const to = new Date().toISOString().slice(0, 10);

  // Priceable benchmark securities only (skip the synthetic cash hurdle).
  const benchSecs = await db
    .select({ id: securities.id, ticker: securities.ticker, exchange: securities.exchange, currency: securities.currency })
    .from(securities)
    .where(and(eq(securities.isBenchmark, true), ne(securities.exchange, "INDEX")));

  const report: Array<Record<string, unknown>> = [];

  for (const sec of benchSecs) {
    const sym = toYahooSymbol(sec.ticker, sec.exchange);
    try {
      const chart = await yf.chart(sym, { period1: from, period2: to, interval: "1d" });
      const meta = (chart.meta?.currency as string | undefined) ?? "";
      const isPence = meta === "GBp" || meta === "GBX";
      const storeCurrency = isPence ? "GBP" : sec.currency;

      if (storeCurrency !== "GBP" && storeCurrency !== "USD" && storeCurrency !== "EUR") {
        report.push({ symbol: sym, status: "unsupported_currency", metaCurrency: meta });
        continue;
      }

      const rows: Array<{ securityId: string; date: string; closePrice: string; currency: "GBP" | "USD" | "EUR"; source: string }> = [];
      for (const q of chart.quotes ?? []) {
        const close = q.close;
        if (close == null || !Number.isFinite(close) || !q.date) continue;
        const d = new Date(q.date).toISOString().slice(0, 10);
        const price = isPence ? close / 100 : close;
        rows.push({ securityId: sec.id, date: d, closePrice: price.toString(), currency: storeCurrency, source: "yahoo-backfill" });
      }

      if (rows.length > 0) {
        // Upsert in chunks to stay well within statement limits.
        const CHUNK = 200;
        for (let i = 0; i < rows.length; i += CHUNK) {
          await db
            .insert(prices)
            .values(rows.slice(i, i + CHUNK))
            .onConflictDoUpdate({
              target: [prices.securityId, prices.date],
              set: {
                closePrice: sql`excluded.close_price`,
                currency: sql`excluded.currency`,
                source: sql`excluded.source`,
              },
            });
        }
      }

      report.push({
        symbol: sym,
        status: "ok",
        currency: storeCurrency,
        metaCurrency: meta,
        daysStored: rows.length,
        firstDate: rows[0]?.date ?? null,
        lastDate: rows[rows.length - 1]?.date ?? null,
        lastClose: rows[rows.length - 1]?.closePrice ?? null,
      });
    } catch (err) {
      report.push({ symbol: sym, status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    ok: report.every((r) => r.status === "ok"),
    from,
    to,
    note: "Now re-run /api/admin/compute-nav?...&from=" + from + " so snapshots pick up these benchmark prices.",
    report,
  });
}
