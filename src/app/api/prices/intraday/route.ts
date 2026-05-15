/**
 * GET /api/prices/intraday?securityIds=id1,id2,id3
 *
 * Returns live (or near-live) intraday quotes for the requested securities.
 * Server reads from the in-process cache, refreshing from the provider when
 * cached entries are stale. Cache TTL is 30s.
 *
 * Response:
 *   {
 *     ok: true,
 *     fetchedAt: "2026-05-15T21:47:08.123Z",
 *     providerLabel: "Yahoo Finance · ~15 min delayed",
 *     quotes: [
 *       {
 *         securityId: "uuid",
 *         price: 105.40,
 *         previousClose: 104.55,
 *         change: 0.85,
 *         changePct: 0.00813,
 *         currency: "GBP",
 *         marketState: "REGULAR" | "CLOSED" | ...,
 *         stale: false,
 *         asOf: "2026-05-15T21:46:38.000Z"
 *       },
 *       { securityId: "uuid", price: null, ... }  // null = lookup failed
 *     ]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { securities as securitiesTable } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { getQuotes } from "@/lib/intraday/cache";
import { activeProvider } from "@/lib/intraday/provider";
import { toYahooSymbol } from "@/lib/intraday/yahoo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const idsParam = req.nextUrl.searchParams.get("securityIds");
  if (!idsParam) {
    return NextResponse.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      providerLabel: activeProvider.displayLabel,
      quotes: [],
    });
  }
  const securityIds = idsParam.split(",").filter(Boolean).slice(0, 200);
  if (securityIds.length === 0) {
    return NextResponse.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      providerLabel: activeProvider.displayLabel,
      quotes: [],
    });
  }

  // Look up tickers + exchanges to build provider-specific symbols
  const rows = await db
    .select({
      id: securitiesTable.id,
      ticker: securitiesTable.ticker,
      exchange: securitiesTable.exchange,
    })
    .from(securitiesTable)
    .where(inArray(securitiesTable.id, securityIds));

  const list = rows.map((r) => ({
    securityId: r.id,
    symbol: toYahooSymbol(r.ticker, r.exchange),
  }));

  const results = await getQuotes(activeProvider, list);

  return NextResponse.json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    providerLabel: activeProvider.displayLabel,
    quotes: results.map((r) => ({
      securityId: r.securityId,
      symbol: r.symbol,
      price: r.quote?.price ?? null,
      previousClose: r.quote?.previousClose ?? null,
      change: r.quote?.change ?? null,
      changePct: r.quote?.changePct ?? null,
      currency: r.quote?.currency ?? null,
      marketState: r.quote?.marketState ?? "UNKNOWN",
      stale: r.stale,
      asOf: r.quote?.asOf?.toISOString() ?? null,
    })),
  });
}
