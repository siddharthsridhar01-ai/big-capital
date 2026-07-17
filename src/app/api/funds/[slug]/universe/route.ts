/**
 * POST /api/funds/[slug]/universe
 * Add a security to this fund's investable universe on demand.
 *
 * The PM enters the full Yahoo symbol (e.g. "AAPL", "AZN.L", "7203.T",
 * "2330.TW"). We validate it live against Yahoo and, if it passes, upsert it
 * into the securities library and link it into this fund's universe.
 *
 * Realistic reference-data checks (a real desk's onboarding gate):
 *   - resolves to a live EQUITY or ETF (rejects crypto, FX, indices, futures…)
 *   - returns a valid price in a currency we can value (supported FX)
 *   - maps to a recognised exchange (so the daily price cron can fetch it)
 *   - soft liquidity flag (thin volume) — warns, does not block
 *
 * Permission: admin, or a current member of this fund. (Analysts who are not
 * fund members are rejected.)
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  funds as fundsTable,
  securities as securitiesTable,
  investableUniverses,
  fundMembers,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import YahooFinance from "yahoo-finance2";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const yf = new YahooFinance();

const SUPPORTED_CURRENCIES = new Set([
  "GBP", "USD", "EUR", "JPY", "HKD", "CNY", "KRW", "SGD", "INR", "TWD",
]);

// Yahoo symbol suffix -> our internal exchange code (reverse of
// exchangeToYahooSuffix). No suffix = US; NYSE vs NASDAQ resolved from the quote.
const SUFFIX_TO_EXCHANGE: Record<string, string> = {
  ".L": "LSE", ".DE": "XETRA", ".F": "FRANKFURT", ".PA": "EURONEXT PARIS",
  ".AS": "EURONEXT AMSTERDAM", ".BR": "EURONEXT BRUSSELS", ".MI": "BORSA ITALIANA",
  ".SW": "SIX", ".TO": "TSX", ".HK": "HKEX", ".NS": "NSE", ".BO": "BSE",
  ".T": "TSE", ".AX": "ASX", ".JO": "JSE", ".SA": "B3",
  ".MX": "BOLSA MEXICANA DE VALORES", ".TW": "TWSE", ".KS": "KRX",
};

function normaliseCurrency(c: string): string {
  const u = c.trim();
  if (u === "GBp" || u === "GBX") return "GBP";
  if (u === "ZAc") return "ZAR";
  if (u === "ILA") return "ILS";
  return u.toUpperCase();
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });

  const { slug } = await ctx.params;
  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  const fund = fundRows[0];

  // Permission: admin or current member of this fund
  if (user.role !== "admin") {
    const membership = await db
      .select()
      .from(fundMembers)
      .where(and(eq(fundMembers.fundId, fund.id), eq(fundMembers.userId, user.id), isNull(fundMembers.endDate)))
      .limit(1);
    if (membership.length === 0) {
      return NextResponse.json({ ok: false, error: "You are not a member of this fund" }, { status: 403 });
    }
  }

  let body: { symbol?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 }); }
  const raw = (body.symbol ?? "").trim().toUpperCase();
  if (!raw) return NextResponse.json({ ok: false, error: "Enter a ticker symbol" }, { status: 400 });

  // Parse ticker + exchange from the Yahoo symbol
  const dot = raw.lastIndexOf(".");
  const suffix = dot > 0 ? raw.slice(dot) : "";
  const ticker = dot > 0 ? raw.slice(0, dot) : raw;

  // Validate live against Yahoo
  let quote: {
    quoteType?: string; regularMarketPrice?: number; currency?: string;
    shortName?: string; longName?: string; fullExchangeName?: string; exchange?: string;
    averageDailyVolume3Month?: number; averageDailyVolume10Day?: number;
  } | null;
  try {
    quote = (await yf.quote(raw)) as typeof quote;
  } catch {
    return NextResponse.json({ ok: false, error: `Couldn't find "${raw}" on the data feed. Check the exact Yahoo symbol (e.g. AZN.L, 7203.T, 2330.TW).` }, { status: 422 });
  }
  if (!quote || typeof quote.regularMarketPrice !== "number") {
    return NextResponse.json({ ok: false, error: `Couldn't get a price for "${raw}". Check the symbol.` }, { status: 422 });
  }

  const qType = (quote.quoteType ?? "").toUpperCase();
  if (qType !== "EQUITY" && qType !== "ETF") {
    return NextResponse.json({ ok: false, error: `"${raw}" is a ${qType || "non-equity"} instrument. Only equities and ETFs can be added.` }, { status: 422 });
  }
  if (quote.regularMarketPrice <= 0) {
    return NextResponse.json({ ok: false, error: `"${raw}" returned an invalid price.` }, { status: 422 });
  }

  const currency = normaliseCurrency(quote.currency ?? "");
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    return NextResponse.json({ ok: false, error: `"${raw}" is priced in ${currency || "an unknown currency"}, which isn't supported yet. If it has a US ADR, add that instead.` }, { status: 422 });
  }

  // Resolve internal exchange
  let exchange: string;
  if (suffix === "") {
    const ex = (quote.fullExchangeName ?? quote.exchange ?? "").toUpperCase();
    exchange = ex.includes("NAS") ? "NASDAQ" : "NYSE";
  } else {
    const mapped = SUFFIX_TO_EXCHANGE[suffix];
    if (!mapped) {
      return NextResponse.json({ ok: false, error: `Exchange "${suffix}" isn't supported yet. Supported venues include US, London (.L), Tokyo (.T), Hong Kong (.HK), Taiwan (.TW), Korea (.KS), India (.NS/.BO) and major European exchanges.` }, { status: 422 });
    }
    exchange = mapped;
  }

  // Round-trip guard: the stored (ticker, exchange) must rebuild the exact
  // Yahoo symbol, or the daily price cron would fetch the wrong thing.
  if (toYahooSymbol(ticker, exchange) !== raw) {
    return NextResponse.json({ ok: false, error: `Could not map "${raw}" to a supported venue cleanly. Double-check the symbol.` }, { status: 422 });
  }

  const name = quote.longName || quote.shortName || ticker;

  // Optional GICS sector (best-effort; null if unavailable)
  let sector: string | null = null;
  try {
    const profile = await yf.quoteSummary(raw, { modules: ["assetProfile"] });
    sector = (profile?.assetProfile?.sector as string | undefined) ?? null;
  } catch { /* sector is optional */ }

  // Upsert security (match on ticker + exchange)
  let securityId: string;
  let securityCreated = false;
  const existing = await db
    .select({ id: securitiesTable.id })
    .from(securitiesTable)
    .where(and(eq(securitiesTable.ticker, ticker), eq(securitiesTable.exchange, exchange)))
    .limit(1);
  if (existing.length > 0) {
    securityId = existing[0].id;
  } else {
    const inserted = await db
      .insert(securitiesTable)
      .values({
        ticker,
        exchange,
        name,
        currency: currency as "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD",
        securityType: "equity", // ETFs stored as equity (only enum value today)
        gicsSector: sector,
        isBenchmark: false,
        isActive: true,
      })
      .returning({ id: securitiesTable.id });
    securityId = inserted[0].id;
    securityCreated = true;
  }

  // Link into this fund's universe (reactivate if previously removed; dedup if active)
  const link = await db
    .select({ securityId: investableUniverses.securityId, removedDate: investableUniverses.removedDate })
    .from(investableUniverses)
    .where(and(eq(investableUniverses.fundId, fund.id), eq(investableUniverses.securityId, securityId)))
    .limit(1);
  const today = new Date().toISOString().slice(0, 10);
  let alreadyInUniverse = false;
  if (link.length > 0) {
    if (link[0].removedDate === null) {
      alreadyInUniverse = true;
    } else {
      // Reactivate a previously-removed name
      await db
        .update(investableUniverses)
        .set({ removedDate: null, addedDate: today })
        .where(and(eq(investableUniverses.fundId, fund.id), eq(investableUniverses.securityId, securityId)));
    }
  } else {
    await db.insert(investableUniverses).values({ fundId: fund.id, securityId, addedDate: today });
  }

  // Soft liquidity flag (does not block)
  const adv = quote.averageDailyVolume3Month ?? quote.averageDailyVolume10Day ?? null;
  const warning = adv != null && adv < 20000
    ? "Thinly traded (low average volume) — check liquidity before sizing a position."
    : null;

  if (alreadyInUniverse) {
    return NextResponse.json({ ok: true, alreadyInUniverse: true, security: { ticker, name, exchange, currency, type: qType }, warning });
  }
  return NextResponse.json({
    ok: true,
    added: true,
    securityCreated,
    security: { ticker, name, exchange, currency, type: qType, sector },
    warning,
  });
}
