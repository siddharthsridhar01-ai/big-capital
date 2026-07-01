/**
 * Manual trigger — run the EODHD price ingest once and report what landed.
 *   /api/admin/ingest-prices?secret=<CRON_SECRET>
 *   optional &date=YYYY-MM-DD  (default: EODHD's latest available day)
 *
 * Read-only intent aside from writing real prices: it runs the same job the
 * nightly cron runs, then reads back the latest price for every security the
 * funds have actually traded — so you can SEE whether real (EODHD) prices now
 * resolve, versus the seed data currently in place.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { prices, securities, transactions } from "@/db/schema";
import { eq, isNotNull, inArray, desc } from "drizzle-orm";
import { runPriceIngest } from "@/workers/fetch-prices";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  const date = url.searchParams.get("date") ?? undefined;

  try {
    const ingest = await runPriceIngest(date);

    // Read back: latest price per traded security, so the result is legible.
    const tradedRows = await db
      .selectDistinct({ securityId: transactions.securityId })
      .from(transactions)
      .where(isNotNull(transactions.securityId));
    const heldIds = tradedRows.map((r) => r.securityId as string);

    const heldSecurityPrices: Array<{
      ticker: string;
      exchange: string;
      latestPriceDate: string | null;
      close: string | null;
      source: string | null;
    }> = [];

    if (heldIds.length > 0) {
      const secRows = await db
        .select({ id: securities.id, ticker: securities.ticker, exchange: securities.exchange })
        .from(securities)
        .where(inArray(securities.id, heldIds));

      for (const s of secRows) {
        const latest = await db
          .select({ date: prices.date, close: prices.closePrice, source: prices.source })
          .from(prices)
          .where(eq(prices.securityId, s.id))
          .orderBy(desc(prices.date))
          .limit(1);
        heldSecurityPrices.push({
          ticker: s.ticker,
          exchange: s.exchange,
          latestPriceDate: latest[0]?.date ?? null,
          close: latest[0]?.close ?? null,
          source: latest[0]?.source ?? null,
        });
      }
    }

    return NextResponse.json({
      ok: ingest.errors.length === 0,
      ingest,
      heldSecurityPrices,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
