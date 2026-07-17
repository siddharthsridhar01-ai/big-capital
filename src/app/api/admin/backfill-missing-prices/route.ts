/**
 * Backfill price history for any active-watchlist security that has no price
 * rows yet (e.g. names added before inline backfill existed, or seeded cores).
 *   /api/admin/backfill-missing-prices?secret=<CRON_SECRET>
 * Idempotent — only touches securities with zero price rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { securities, investableUniverses, prices } from "@/db/schema";
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import { backfillSecurityPrices, type Currency10 } from "@/lib/universe-add";

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

  // Distinct securities currently on some fund's active watchlist.
  const active = await db
    .selectDistinct({
      id: securities.id, ticker: securities.ticker, exchange: securities.exchange, currency: securities.currency,
    })
    .from(investableUniverses)
    .innerJoin(securities, eq(investableUniverses.securityId, securities.id))
    .where(isNull(investableUniverses.removedDate));

  // Which of those already have at least one price row?
  const priced = await db
    .selectDistinct({ securityId: prices.securityId })
    .from(prices)
    .where(isNotNull(prices.securityId));
  const pricedSet = new Set(priced.map((p) => p.securityId));

  const report: Array<{ ticker: string; exchange: string; daysStored: number }> = [];
  for (const s of active) {
    if (pricedSet.has(s.id)) continue;
    const sym = toYahooSymbol(s.ticker, s.exchange);
    const days = await backfillSecurityPrices(s.id, sym, s.currency as Currency10);
    report.push({ ticker: s.ticker, exchange: s.exchange, daysStored: days });
  }

  return NextResponse.json({ ok: true, backfilled: report.length, report });
}
