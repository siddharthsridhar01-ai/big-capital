/**
 * Shared logic to validate a ticker live against Yahoo and add it to a fund's
 * watchlist (the `investable_universes` link). Used by the PM-facing endpoint
 * and the admin seed route so validation + mandate rules are identical.
 */
import { db } from "@/db/client";
import { securities as securitiesTable, investableUniverses, prices } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import { checkMandate } from "@/lib/mandates";
import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance();

const SUPPORTED_CURRENCIES = new Set([
  "GBP", "USD", "EUR", "JPY", "HKD", "CNY", "KRW", "SGD", "INR", "TWD",
]);

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

/**
 * Backfill ~1y of daily closes for a newly-added security so it's immediately
 * chartable and tradable (the trade ticket + security page read the `prices`
 * table). Best-effort: returns the number of days stored, 0 on any failure.
 */
export async function backfillSecurityPrices(securityId: string, rawSymbol: string, storeCcyFallback: Currency10): Promise<number> {
  const period1 = new Date(Date.now() - 365 * 86400000);
  const period2 = new Date();
  try {
    const chart = await yf.chart(rawSymbol, { period1, period2, interval: "1d" });
    const meta = (chart.meta?.currency as string | undefined) ?? "";
    const isPence = meta === "GBp" || meta === "GBX";
    const storeCurrency: Currency10 = isPence ? "GBP" : storeCcyFallback;
    const rows: Array<{ securityId: string; date: string; closePrice: string; currency: Currency10; source: string }> = [];
    for (const q of chart.quotes ?? []) {
      const close = q.close;
      if (close == null || !Number.isFinite(close) || !q.date) continue;
      const d = new Date(q.date).toISOString().slice(0, 10);
      const price = isPence ? close / 100 : close;
      rows.push({ securityId, date: d, closePrice: price.toString(), currency: storeCurrency, source: "yahoo-add" });
    }
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db
        .insert(prices)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [prices.securityId, prices.date],
          set: { closePrice: sql`excluded.close_price`, currency: sql`excluded.currency`, source: sql`excluded.source` },
        });
    }
    return rows.length;
  } catch {
    return 0;
  }
}

export type Currency10 = "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD";

export interface AddOutcome {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export async function addSecurityToWatchlist(
  fund: { id: string; slug: string },
  rawSymbol: string,
  opts: { fetchSector?: boolean; backfill?: boolean } = {}
): Promise<AddOutcome> {
  const raw = (rawSymbol ?? "").trim().toUpperCase();
  if (!raw) return { ok: false, status: 400, body: { ok: false, error: "Enter a ticker symbol" } };

  const dot = raw.lastIndexOf(".");
  const suffix = dot > 0 ? raw.slice(dot) : "";
  const ticker = dot > 0 ? raw.slice(0, dot) : raw;

  let quote: {
    quoteType?: string; regularMarketPrice?: number; currency?: string;
    shortName?: string; longName?: string; fullExchangeName?: string; exchange?: string;
    averageDailyVolume3Month?: number; averageDailyVolume10Day?: number;
  } | null;
  try {
    quote = (await yf.quote(raw)) as typeof quote;
  } catch {
    return { ok: false, status: 422, body: { ok: false, error: `Couldn't find "${raw}" on the data feed. Check the exact Yahoo symbol (e.g. AZN.L, 7203.T, 2330.TW).` } };
  }
  if (!quote || typeof quote.regularMarketPrice !== "number") {
    return { ok: false, status: 422, body: { ok: false, error: `Couldn't get a price for "${raw}". Check the symbol.` } };
  }

  const qType = (quote.quoteType ?? "").toUpperCase();
  if (qType !== "EQUITY") {
    return { ok: false, status: 422, body: { ok: false, error: `"${raw}" is a ${qType || "non-equity"} instrument. Only single-name equities can be added — no ETFs, funds, or other instruments.` } };
  }
  if (quote.regularMarketPrice <= 0) {
    return { ok: false, status: 422, body: { ok: false, error: `"${raw}" returned an invalid price.` } };
  }

  const currency = normaliseCurrency(quote.currency ?? "");
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    return { ok: false, status: 422, body: { ok: false, error: `"${raw}" is priced in ${currency || "an unknown currency"}, which isn't supported yet. If it has a US ADR, add that instead.` } };
  }

  let exchange: string;
  if (suffix === "") {
    const ex = (quote.fullExchangeName ?? quote.exchange ?? "").toUpperCase();
    exchange = ex.includes("NAS") ? "NASDAQ" : "NYSE";
  } else {
    const mapped = SUFFIX_TO_EXCHANGE[suffix];
    if (!mapped) {
      return { ok: false, status: 422, body: { ok: false, error: `Exchange "${suffix}" isn't supported yet. Supported venues include US, London (.L), Tokyo (.T), Hong Kong (.HK), Taiwan (.TW), Korea (.KS), India (.NS/.BO) and major European exchanges.` } };
    }
    exchange = mapped;
  }

  // Mandate gate (e.g. UK fund → UK listings only)
  const mandate = checkMandate(fund.slug, currency, exchange);
  if (!mandate.ok) {
    return { ok: false, status: 422, body: { ok: false, error: mandate.reason } };
  }

  if (toYahooSymbol(ticker, exchange) !== raw) {
    return { ok: false, status: 422, body: { ok: false, error: `Could not map "${raw}" to a supported venue cleanly. Double-check the symbol.` } };
  }

  const name = quote.longName || quote.shortName || ticker;

  let sector: string | null = null;
  if (opts.fetchSector !== false) {
    try {
      const profile = await yf.quoteSummary(raw, { modules: ["assetProfile"] });
      sector = (profile?.assetProfile?.sector as string | undefined) ?? null;
    } catch { /* optional */ }
  }

  // Upsert security (match ticker + exchange)
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
        ticker, exchange, name,
        currency: currency as Currency10,
        securityType: "equity",
        gicsSector: sector,
        isBenchmark: false,
        isActive: true,
      })
      .returning({ id: securitiesTable.id });
    securityId = inserted[0].id;
    securityCreated = true;
  }

  // Backfill price history for any security with no price rows yet (new, or a
  // previously-added name that never got priced) so it's immediately chartable
  // and tradable. Skipped if the security already has prices.
  let daysStored = 0;
  if (opts.backfill !== false) {
    const hasPrice = await db.select({ d: prices.date }).from(prices).where(eq(prices.securityId, securityId)).limit(1);
    if (hasPrice.length === 0) {
      daysStored = await backfillSecurityPrices(securityId, raw, currency as Currency10);
    }
  }

  // Link into this fund's watchlist (reactivate if previously removed; dedup if active)
  const today = new Date().toISOString().slice(0, 10);
  const link = await db
    .select({ securityId: investableUniverses.securityId, removedDate: investableUniverses.removedDate })
    .from(investableUniverses)
    .where(and(eq(investableUniverses.fundId, fund.id), eq(investableUniverses.securityId, securityId)))
    .limit(1);
  let alreadyInWatchlist = false;
  if (link.length > 0) {
    if (link[0].removedDate === null) {
      alreadyInWatchlist = true;
    } else {
      await db
        .update(investableUniverses)
        .set({ removedDate: null, addedDate: today })
        .where(and(eq(investableUniverses.fundId, fund.id), eq(investableUniverses.securityId, securityId)));
    }
  } else {
    await db.insert(investableUniverses).values({ fundId: fund.id, securityId, addedDate: today });
  }

  const adv = quote.averageDailyVolume3Month ?? quote.averageDailyVolume10Day ?? null;
  const warning = adv != null && adv < 20000
    ? "Thinly traded (low average volume) — check liquidity before sizing a position."
    : null;

  if (alreadyInWatchlist) {
    return { ok: true, status: 200, body: { ok: true, alreadyInWatchlist: true, security: { ticker, name, exchange, currency, type: qType }, warning } };
  }
  return {
    ok: true, status: 200,
    body: { ok: true, added: true, securityCreated, daysStored, security: { ticker, name, exchange, currency, type: qType, sector }, warning },
  };
}
