/**
 * Seed a small standard core watchlist for the non-UK funds, so PMs don't start
 * from a blank page. Each name is validated live against Yahoo (via the shared
 * add logic) — correct currency/exchange guaranteed. Idempotent and reversible
 * (names can be removed from the watchlist afterwards).
 *
 *   /api/admin/seed-fund-cores?secret=<CRON_SECRET>[&fund=<slug>]
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { addSecurityToWatchlist } from "@/lib/universe-add";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Mandate-appropriate cores, all in supported currencies (USD/EUR + Asian).
const CORES: Record<string, string[]> = {
  // Developed Europe including the UK, spread to mirror MSCI Europe's country
  // and sector shape rather than to express a view: the PM adds names from here.
  // Switzerland and the Nordics are ~25% of the index, which is why CHF, DKK,
  // SEK and NOK had to be supported before this list was possible.
  "european-equity": [
    // United Kingdom (~23% of MSCI Europe)
    "AZN.L", "SHEL.L", "HSBA.L", "ULVR.L", "BP.L", "GSK.L", "RIO.L", "REL.L",
    "LSEG.L", "DGE.L", "BATS.L", "NG.L", "CPG.L", "EXPN.L",
    // France (~17%)
    "MC.PA", "OR.PA", "TTE.PA", "SAN.PA", "AIR.PA", "SU.PA", "BNP.PA", "AI.PA",
    "EL.PA", "RMS.PA", "DG.PA",
    // Switzerland (~15%)
    "NESN.SW", "ROG.SW", "NOVN.SW", "UBSG.SW", "ZURN.SW", "ABBN.SW", "SIKA.SW",
    "GIVN.SW",
    // Germany (~13%)
    "SAP.DE", "SIE.DE", "ALV.DE", "DTE.DE", "MUV2.DE", "BAS.DE", "IFX.DE",
    "MBG.DE", "DB1.DE", "ADS.DE",
    // Netherlands (~8%)
    "ASML.AS", "INGA.AS", "AD.AS", "PHIA.AS", "WKL.AS", "HEIA.AS", "PRX.AS",
    // Nordics (~10%)
    "NOVO-B.CO", "DSV.CO", "ATCO-A.ST", "INVE-B.ST", "VOLV-B.ST", "SAND.ST",
    "EQNR.OL", "DNB.OL",
    // Southern Europe (~8%)
    "ISP.MI", "ENI.MI", "RACE.MI", "ITX.MC", "IBE.MC", "SAN.MC",
  ],
  "global-equity": [
    "MSFT", "PG", "KO", "PEP", "JNJ", "V", "MA", "COST", "MCD", "NKE", "PM",
    "MC.PA", "OR.PA", "SAP.DE",
  ],
  "long-short": [
    "AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "JPM", "UNH", "XOM",
    "JNJ", "WMT", "HD", "PG", "V",
  ],
  "market-neutral": [
    "AAPL", "MSFT", "JPM", "SAP.DE", "MC.PA", "ASML.AS",
    "7203.T", "0700.HK", "9988.HK", "005930.KS", "2330.TW", "RELIANCE.NS",
  ],
  "systematic-equity": [
    "AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "JPM", "JNJ", "PG",
    "HD", "KO", "PEP", "WMT", "DIS",
  ],
  // Pair trades need BOTH legs of each pair in the universe, so this is built
  // as a set of natural comparables rather than a list of good companies:
  // hyperscalers against each other, foundry against IDM, fabless designers
  // against one another, and semi-cap equipment as its own cluster. Roughly 20
  // names, matching the stated coverage universe.
  "tech-relative-value": [
    // Hyperscalers and mega-cap platforms
    "MSFT", "GOOGL", "AMZN", "META", "ORCL", "AAPL",
    // Fabless designers and accelerators
    "NVDA", "AMD", "AVGO", "QCOM", "MRVL", "ARM",
    // Foundry, IDM and memory
    "TSM", "INTC", "MU", "TXN",
    // Semi-cap equipment
    "AMAT", "LRCX", "KLAC", "ASML",
    // Networking adjacency
    "ANET",
  ],
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

  const only = url.searchParams.get("fund");
  const slugs = only ? [only] : Object.keys(CORES);
  const summary: Record<string, unknown> = {};

  for (const slug of slugs) {
    const symbols = CORES[slug];
    if (!symbols) { summary[slug] = "no core defined"; continue; }
    const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
    if (fundRows.length === 0) { summary[slug] = "fund not found"; continue; }
    const fund = fundRows[0];

    const added: string[] = [];
    const skipped: Record<string, string> = {};
    for (const sym of symbols) {
      const r = await addSecurityToWatchlist({ id: fund.id, slug: fund.slug }, sym, { fetchSector: false });
      if (r.ok && (r.body.added || r.body.alreadyInWatchlist)) added.push(sym);
      else skipped[sym] = String(r.body.error ?? "skipped");
    }
    summary[slug] = { addedCount: added.length, added, skipped };
  }

  return NextResponse.json({ ok: true, summary });
}
