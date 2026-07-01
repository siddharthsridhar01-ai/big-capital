/**
 * Admin/one-off: expand the UK Equity Fund's investable universe to a realistic
 * FTSE 100 set, to stress-test the universe table + batched live pricing before
 * launch.
 *
 *   /api/admin/seed-uk-universe?secret=<CRON_SECRET>          (defaults to uk-equity)
 *   /api/admin/seed-uk-universe?secret=...&slug=uk-equity
 *
 * Idempotent: securities are matched on (ticker, exchange) and skipped if they
 * already exist; universe links are skipped if already present. Safe to re-run.
 *
 * Tickers are stored WITHOUT any trailing dot (e.g. "BA", "RR", "NG") so the
 * Yahoo mapper produces the correct symbol (BA.L, RR.L, NG.L). No prices are
 * seeded here — real prices flow via the Yahoo EOD/intraday path. After running
 * this, run /api/admin/ingest-prices to fetch EOD closes; any ticker that comes
 * back without a price is likely wrong/stale and can be corrected.
 *
 * NOTE: the list is curated from general knowledge; a handful of tickers or
 * sector labels may need correcting. The price ingest is the validation step.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { securities as securitiesTable, funds as fundsTable, investableUniverses } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface UkName {
  ticker: string;
  name: string;
  sector: string;
}

// Curated FTSE 100 large-caps (LSE, GBP). ~80 stable, well-known names.
const UK_UNIVERSE: UkName[] = [
  // Energy
  { ticker: "SHEL", name: "Shell PLC", sector: "Energy" },
  { ticker: "BP", name: "BP PLC", sector: "Energy" },
  // Health Care
  { ticker: "AZN", name: "AstraZeneca PLC", sector: "Health Care" },
  { ticker: "GSK", name: "GSK PLC", sector: "Health Care" },
  { ticker: "SN", name: "Smith & Nephew PLC", sector: "Health Care" },
  { ticker: "CTEC", name: "ConvaTec Group PLC", sector: "Health Care" },
  { ticker: "HLN", name: "Haleon PLC", sector: "Consumer Staples" },
  // Financials
  { ticker: "HSBA", name: "HSBC Holdings PLC", sector: "Financials" },
  { ticker: "BARC", name: "Barclays PLC", sector: "Financials" },
  { ticker: "LLOY", name: "Lloyds Banking Group PLC", sector: "Financials" },
  { ticker: "NWG", name: "NatWest Group PLC", sector: "Financials" },
  { ticker: "STAN", name: "Standard Chartered PLC", sector: "Financials" },
  { ticker: "PRU", name: "Prudential PLC", sector: "Financials" },
  { ticker: "LGEN", name: "Legal & General Group PLC", sector: "Financials" },
  { ticker: "AV", name: "Aviva PLC", sector: "Financials" },
  { ticker: "ADM", name: "Admiral Group PLC", sector: "Financials" },
  { ticker: "III", name: "3i Group PLC", sector: "Financials" },
  { ticker: "SDR", name: "Schroders PLC", sector: "Financials" },
  { ticker: "STJ", name: "St. James's Place PLC", sector: "Financials" },
  { ticker: "PHNX", name: "Phoenix Group Holdings PLC", sector: "Financials" },
  { ticker: "HSX", name: "Hiscox Ltd", sector: "Financials" },
  { ticker: "BEZ", name: "Beazley PLC", sector: "Financials" },
  { ticker: "LSEG", name: "London Stock Exchange Group PLC", sector: "Financials" },
  // Consumer Staples
  { ticker: "ULVR", name: "Unilever PLC", sector: "Consumer Staples" },
  { ticker: "DGE", name: "Diageo PLC", sector: "Consumer Staples" },
  { ticker: "BATS", name: "British American Tobacco PLC", sector: "Consumer Staples" },
  { ticker: "IMB", name: "Imperial Brands PLC", sector: "Consumer Staples" },
  { ticker: "RKT", name: "Reckitt Benckiser Group PLC", sector: "Consumer Staples" },
  { ticker: "TSCO", name: "Tesco PLC", sector: "Consumer Staples" },
  { ticker: "SBRY", name: "J Sainsbury PLC", sector: "Consumer Staples" },
  { ticker: "ABF", name: "Associated British Foods PLC", sector: "Consumer Staples" },
  { ticker: "CCH", name: "Coca-Cola HBC AG", sector: "Consumer Staples" },
  { ticker: "MKS", name: "Marks & Spencer Group PLC", sector: "Consumer Staples" },
  { ticker: "OCDO", name: "Ocado Group PLC", sector: "Consumer Staples" },
  // Materials
  { ticker: "RIO", name: "Rio Tinto PLC", sector: "Materials" },
  { ticker: "GLEN", name: "Glencore PLC", sector: "Materials" },
  { ticker: "AAL", name: "Anglo American PLC", sector: "Materials" },
  { ticker: "ANTO", name: "Antofagasta PLC", sector: "Materials" },
  { ticker: "FRES", name: "Fresnillo PLC", sector: "Materials" },
  { ticker: "MNDI", name: "Mondi PLC", sector: "Materials" },
  // Industrials
  { ticker: "REL", name: "RELX PLC", sector: "Industrials" },
  { ticker: "EXPN", name: "Experian PLC", sector: "Industrials" },
  { ticker: "BA", name: "BAE Systems PLC", sector: "Industrials" },
  { ticker: "RR", name: "Rolls-Royce Holdings PLC", sector: "Industrials" },
  { ticker: "BNZL", name: "Bunzl PLC", sector: "Industrials" },
  { ticker: "DCC", name: "DCC PLC", sector: "Industrials" },
  { ticker: "SMIN", name: "Smiths Group PLC", sector: "Industrials" },
  { ticker: "ITRK", name: "Intertek Group PLC", sector: "Industrials" },
  { ticker: "RTO", name: "Rentokil Initial PLC", sector: "Industrials" },
  { ticker: "HLMA", name: "Halma PLC", sector: "Industrials" },
  { ticker: "IMI", name: "IMI PLC", sector: "Industrials" },
  { ticker: "WEIR", name: "Weir Group PLC", sector: "Industrials" },
  { ticker: "MRO", name: "Melrose Industries PLC", sector: "Industrials" },
  { ticker: "DPLM", name: "Diploma PLC", sector: "Industrials" },
  // Consumer Discretionary
  { ticker: "CPG", name: "Compass Group PLC", sector: "Consumer Discretionary" },
  { ticker: "NXT", name: "Next PLC", sector: "Consumer Discretionary" },
  { ticker: "JD", name: "JD Sports Fashion PLC", sector: "Consumer Discretionary" },
  { ticker: "KGF", name: "Kingfisher PLC", sector: "Consumer Discretionary" },
  { ticker: "WTB", name: "Whitbread PLC", sector: "Consumer Discretionary" },
  { ticker: "IHG", name: "InterContinental Hotels Group PLC", sector: "Consumer Discretionary" },
  { ticker: "BKG", name: "Berkeley Group Holdings PLC", sector: "Consumer Discretionary" },
  { ticker: "PSN", name: "Persimmon PLC", sector: "Consumer Discretionary" },
  { ticker: "TW", name: "Taylor Wimpey PLC", sector: "Consumer Discretionary" },
  { ticker: "GAW", name: "Games Workshop Group PLC", sector: "Consumer Discretionary" },
  { ticker: "HWDN", name: "Howden Joinery Group PLC", sector: "Consumer Discretionary" },
  { ticker: "ENT", name: "Entain PLC", sector: "Consumer Discretionary" },
  { ticker: "PSON", name: "Pearson PLC", sector: "Consumer Discretionary" },
  // Real Estate
  { ticker: "LAND", name: "Landsec (Land Securities Group) PLC", sector: "Real Estate" },
  { ticker: "BLND", name: "British Land Company PLC", sector: "Real Estate" },
  { ticker: "SGRO", name: "Segro PLC", sector: "Real Estate" },
  { ticker: "UTG", name: "Unite Group PLC", sector: "Real Estate" },
  // Utilities
  { ticker: "NG", name: "National Grid PLC", sector: "Utilities" },
  { ticker: "SSE", name: "SSE PLC", sector: "Utilities" },
  { ticker: "UU", name: "United Utilities Group PLC", sector: "Utilities" },
  { ticker: "SVT", name: "Severn Trent PLC", sector: "Utilities" },
  { ticker: "CNA", name: "Centrica PLC", sector: "Utilities" },
  // Communication Services
  { ticker: "VOD", name: "Vodafone Group PLC", sector: "Communication Services" },
  { ticker: "AUTO", name: "Auto Trader Group PLC", sector: "Communication Services" },
  { ticker: "RMV", name: "Rightmove PLC", sector: "Communication Services" },
  { ticker: "ITV", name: "ITV PLC", sector: "Communication Services" },
  { ticker: "WPP", name: "WPP PLC", sector: "Communication Services" },
  { ticker: "INF", name: "Informa PLC", sector: "Communication Services" },
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

  const slug = url.searchParams.get("slug") ?? "uk-equity";
  const today = new Date().toISOString().slice(0, 10);

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json({ ok: false, error: `Fund '${slug}' not found` }, { status: 404 });
  }
  const fund = fundRows[0];

  const result = {
    ok: true,
    fund: fund.slug,
    securitiesCreated: 0,
    securitiesExisting: 0,
    universeLinksCreated: 0,
    universeLinksExisting: 0,
    total: UK_UNIVERSE.length,
    tickers: [] as string[],
  };

  for (const s of UK_UNIVERSE) {
    // Upsert security (match on ticker + exchange)
    let secId: string;
    const existing = await db
      .select({ id: securitiesTable.id })
      .from(securitiesTable)
      .where(and(eq(securitiesTable.ticker, s.ticker), eq(securitiesTable.exchange, "LSE")))
      .limit(1);
    if (existing.length > 0) {
      secId = existing[0].id;
      result.securitiesExisting += 1;
    } else {
      const inserted = await db
        .insert(securitiesTable)
        .values({
          ticker: s.ticker,
          exchange: "LSE",
          name: s.name,
          currency: "GBP",
          securityType: "equity",
          gicsSector: s.sector,
          isBenchmark: false,
          isActive: true,
        })
        .returning({ id: securitiesTable.id });
      secId = inserted[0].id;
      result.securitiesCreated += 1;
    }
    result.tickers.push(s.ticker);

    // Link into the fund's investable universe (skip if already linked & active)
    const link = await db
      .select({ id: investableUniverses.securityId })
      .from(investableUniverses)
      .where(
        and(eq(investableUniverses.fundId, fund.id), eq(investableUniverses.securityId, secId))
      )
      .limit(1);
    if (link.length > 0) {
      result.universeLinksExisting += 1;
    } else {
      await db.insert(investableUniverses).values({
        fundId: fund.id,
        securityId: secId,
        addedDate: today,
      });
      result.universeLinksCreated += 1;
    }
  }

  return NextResponse.json(result);
}
