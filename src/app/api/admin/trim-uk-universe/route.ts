/**
 * Trim the UK Equity Fund's investable universe down to a lean core of the
 * largest / most standard FTSE names. Everything else is retired (removedDate
 * set) — NOT deleted — so it's fully reversible, and PMs can re-add any name
 * on demand via the universe page.
 *
 *   /api/admin/trim-uk-universe?secret=<CRON_SECRET>          -> trim
 *   /api/admin/trim-uk-universe?secret=<CRON_SECRET>&restore=1 -> un-trim (reactivate all)
 *
 * Safety: any ticker the fund has actually traded is force-kept regardless of
 * the core list, so trimming can never orphan a held/traded name.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, securities, investableUniverses, transactions } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Core: ~15 largest / most-standard FTSE 100 names, spread across sectors.
const CORE = [
  "AZN",  // AstraZeneca — Health Care
  "SHEL", // Shell — Energy
  "HSBA", // HSBC — Financials
  "ULVR", // Unilever — Consumer Staples
  "BP",   // BP — Energy
  "RIO",  // Rio Tinto — Materials
  "GSK",  // GSK — Health Care
  "DGE",  // Diageo — Consumer Staples
  "REL",  // RELX — Industrials
  "BATS", // British American Tobacco — Consumer Staples
  "GLEN", // Glencore — Materials
  "BA",   // BAE Systems — Industrials
  "RR",   // Rolls-Royce — Industrials
  "LSEG", // London Stock Exchange Group — Financials
  "NG",   // National Grid — Utilities
];

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
  const restore = url.searchParams.get("restore") === "1";

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, "uk-equity")).limit(1);
  if (fundRows.length === 0) return NextResponse.json({ ok: false, error: "uk-equity fund not found" }, { status: 404 });
  const fund = fundRows[0];
  const today = new Date().toISOString().slice(0, 10);

  // RESTORE: reactivate everything previously retired for this fund.
  if (restore) {
    const restored = await db
      .update(investableUniverses)
      .set({ removedDate: null })
      .where(and(eq(investableUniverses.fundId, fund.id)))
      .returning({ securityId: investableUniverses.securityId });
    return NextResponse.json({ ok: true, mode: "restore", reactivated: restored.length });
  }

  // Active universe entries (ticker via join)
  const active = await db
    .select({ securityId: investableUniverses.securityId, ticker: securities.ticker })
    .from(investableUniverses)
    .innerJoin(securities, eq(investableUniverses.securityId, securities.id))
    .where(and(eq(investableUniverses.fundId, fund.id), isNull(investableUniverses.removedDate)));

  // Force-keep anything the fund has traded
  const traded = await db
    .selectDistinct({ securityId: transactions.securityId })
    .from(transactions)
    .where(eq(transactions.fundId, fund.id));
  const tradedIds = new Set(traded.map((t) => t.securityId).filter((x): x is string => !!x));

  const keepTickers = new Set(CORE);
  const kept: string[] = [];
  const retired: string[] = [];

  for (const row of active) {
    const keep = keepTickers.has(row.ticker) || tradedIds.has(row.securityId);
    if (keep) {
      kept.push(row.ticker);
    } else {
      await db
        .update(investableUniverses)
        .set({ removedDate: today })
        .where(and(eq(investableUniverses.fundId, fund.id), eq(investableUniverses.securityId, row.securityId)));
      retired.push(row.ticker);
    }
  }

  return NextResponse.json({
    ok: true,
    mode: "trim",
    keptCount: kept.length,
    retiredCount: retired.length,
    kept: kept.sort(),
    retired: retired.sort(),
  });
}
