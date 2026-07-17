/**
 * Ticker search API.
 *
 * GET /api/search/securities?q=<query>&fund=<fund_slug>
 *
 * If `fund` is provided, scopes results to that fund's investable universe.
 * Without `fund`, searches all securities the user has access to (admin = all,
 * others = securities in any of their member funds' universes).
 *
 * Matches against ticker (prefix), name (contains, case-insensitive), and
 * ISIN (exact). Ranks ticker prefix matches first, then name matches.
 *
 * Returns up to 20 results with current price metadata where available.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  securities,
  funds as fundsTable,
  investableUniverses,
  fundMembers,
  prices,
} from "@/db/schema";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
} from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export interface SearchResult {
  id: string;
  ticker: string;
  exchange: string;
  name: string;
  currency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
  gicsSector: string | null;
  gicsIndustry: string | null;
  /** Latest known close from the DB (yesterday-or-earlier data). */
  latestPrice: string | null;
  latestPriceDate: string | null;
  /** Live price from the intraday provider (if available). */
  livePrice: number | null;
  /** Signed daily change percentage (e.g. 0.0213 for +2.13%) — live vs previous close. */
  changePct: number | null;
  /** "REGULAR" | "CLOSED" | etc. — useful for "market: closed" labels. */
  marketState: string | null;
}

export async function GET(req: NextRequest) {
  const user = await getOrCreateUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const fundSlug = url.searchParams.get("fund");

  if (q.length === 0) {
    return NextResponse.json({ results: [] });
  }

  // Build base query for matching securities
  const qLike = `%${q}%`;
  const qPrefix = `${q}%`;

  const matchClause = or(
    ilike(securities.ticker, qPrefix),
    ilike(securities.name, qLike),
    eq(securities.isin, q.toUpperCase())
  );

  // Resolve fund scope if specified
  let fundId: string | null = null;
  if (fundSlug) {
    const fundRows = await db
      .select()
      .from(fundsTable)
      .where(eq(fundsTable.slug, fundSlug))
      .limit(1);
    if (fundRows.length === 0) {
      return NextResponse.json({ results: [], error: "Fund not found" });
    }
    fundId = fundRows[0].id;

    // Access check: admins can see all, others must be members
    if (user.role !== "admin") {
      const membership = await db
        .select()
        .from(fundMembers)
        .where(
          and(
            eq(fundMembers.fundId, fundId),
            eq(fundMembers.userId, user.id),
            isNull(fundMembers.endDate)
          )
        )
        .limit(1);
      if (membership.length === 0) {
        return new NextResponse("Forbidden", { status: 403 });
      }
    }
  }

  // Execute the search
  let results: SearchResult[];

  if (fundId) {
    // Scoped to one fund's investable universe
    const rows = await db
      .select({
        id: securities.id,
        ticker: securities.ticker,
        exchange: securities.exchange,
        name: securities.name,
        currency: securities.currency,
        gicsSector: securities.gicsSector,
        gicsIndustry: securities.gicsIndustry,
      })
      .from(securities)
      .innerJoin(
        investableUniverses,
        eq(investableUniverses.securityId, securities.id)
      )
      .where(
        and(
          eq(investableUniverses.fundId, fundId),
          isNull(investableUniverses.removedDate),
          eq(securities.isActive, true),
          eq(securities.isBenchmark, false),
          matchClause
        )
      )
      .limit(20);
    results = await attachPrices(rows);
  } else {
    // Global search across all securities user can access
    // Admins: all securities
    // Others: securities in any of their member funds' universes
    if (user.role === "admin") {
      const rows = await db
        .select({
          id: securities.id,
          ticker: securities.ticker,
          exchange: securities.exchange,
          name: securities.name,
          currency: securities.currency,
          gicsSector: securities.gicsSector,
          gicsIndustry: securities.gicsIndustry,
        })
        .from(securities)
        .where(
          and(
            eq(securities.isActive, true),
            eq(securities.isBenchmark, false),
            matchClause
          )
        )
        .limit(20);
      results = await attachPrices(rows);
    } else {
      // Non-admin: securities in any of their member funds' universes.
      // Use a join (more reliable than IN subquery with Drizzle).
      const rawRows = await db
        .selectDistinct({
          id: securities.id,
          ticker: securities.ticker,
          exchange: securities.exchange,
          name: securities.name,
          currency: securities.currency,
          gicsSector: securities.gicsSector,
          gicsIndustry: securities.gicsIndustry,
        })
        .from(securities)
        .innerJoin(
          investableUniverses,
          eq(investableUniverses.securityId, securities.id)
        )
        .innerJoin(
          fundMembers,
          eq(fundMembers.fundId, investableUniverses.fundId)
        )
        .where(
          and(
            eq(securities.isActive, true),
            eq(securities.isBenchmark, false),
            matchClause,
            eq(fundMembers.userId, user.id),
            isNull(fundMembers.endDate),
            isNull(investableUniverses.removedDate)
          )
        )
        .limit(20);
      results = await attachPrices(rawRows);
    }
  }

  // Rank: ticker prefix matches first
  const qUpper = q.toUpperCase();
  results.sort((a, b) => {
    const aPrefix = a.ticker.toUpperCase().startsWith(qUpper) ? 0 : 1;
    const bPrefix = b.ticker.toUpperCase().startsWith(qUpper) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    return a.ticker.localeCompare(b.ticker);
  });

  return NextResponse.json({ results });
}

/**
 * Attach the latest known close price to each result.
 */
async function attachPrices(
  rows: Array<{
    id: string;
    ticker: string;
    exchange: string;
    name: string;
    currency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
    gicsSector: string | null;
    gicsIndustry: string | null;
  }>
): Promise<SearchResult[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  // Latest price per security from the DB
  const latestPrices = await db
    .select({
      securityId: prices.securityId,
      closePrice: prices.closePrice,
      date: prices.date,
    })
    .from(prices)
    .where(inArray(prices.securityId, ids))
    .orderBy(desc(prices.date));

  // Reduce to "first price per securityId" (because orderBy is DESC date)
  const priceMap = new Map<
    string,
    { closePrice: string; date: string }
  >();
  for (const p of latestPrices) {
    if (!priceMap.has(p.securityId)) {
      priceMap.set(p.securityId, { closePrice: p.closePrice, date: p.date });
    }
  }

  // Live price overlay from intraday provider. Batched + cached, so typing
  // a sequence of queries (e.g. "b", "bp") reuses cached quotes for the
  // overlapping results.
  const liveMap = new Map<
    string,
    { price: number; changePct: number | null; marketState: string | null }
  >();
  try {
    const { getQuotes } = await import("@/lib/intraday/cache");
    const { activeProvider } = await import("@/lib/intraday/provider");
    const { toYahooSymbol } = await import("@/lib/intraday/yahoo");
    const quoteRequests = rows.map((r) => ({
      securityId: r.id,
      symbol: toYahooSymbol(r.ticker, r.exchange),
    }));
    const quotes = await getQuotes(activeProvider, quoteRequests);
    for (const r of quotes) {
      if (r.quote?.price != null) {
        liveMap.set(r.securityId, {
          price: r.quote.price,
          changePct: r.quote.changePct,
          marketState: r.quote.marketState,
        });
      }
    }
  } catch (err) {
    // Live overlay failed — silently fall back to DB prices in the response
    console.error("[search] live price overlay failed:", err);
  }

  return rows.map((r) => {
    const p = priceMap.get(r.id);
    const live = liveMap.get(r.id);
    return {
      id: r.id,
      ticker: r.ticker,
      exchange: r.exchange,
      name: r.name,
      currency: r.currency,
      gicsSector: r.gicsSector,
      gicsIndustry: r.gicsIndustry,
      latestPrice: p?.closePrice ?? null,
      latestPriceDate: p?.date ?? null,
      livePrice: live?.price ?? null,
      changePct: live?.changePct ?? null,
      marketState: live?.marketState ?? null,
    };
  });
}
