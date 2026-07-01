/**
 * Worker: Dividend ingestion via Yahoo Finance (free, no per-symbol call cap).
 *
 * Same accounting as the EODHD version (see src/lib/dividends.ts): holder as of
 * the ex-date, shorts pay, GBX/GBp -> GBP, idempotent on (fund, security,
 * ex-date). Only the data source differs: Yahoo's chart() with events:"div"
 * returns { amount, date }[] plus meta.currency (pence for LSE names), so we
 * feed meta.currency + amount straight into the shared normaliseDividend().
 *
 * Yahoo dividend `amount` is the actual per-share cash (not split-adjusted in
 * the windows we care about); no splits have occurred over the funds' life.
 *
 * Triggers: cron /api/cron/dividends, admin /api/admin/ingest-dividends.
 */
import { db } from "../db/client";
import {
  transactions as transactionsTable,
  securities as securitiesTable,
  funds as fundsTable,
  fxRates,
  users,
} from "../db/schema";
import { and, eq, isNotNull, lte, desc } from "drizzle-orm";
import Decimal from "decimal.js";
import YahooFinance from "yahoo-finance2";
import { buildLedgerState, type Transaction, type Currency } from "../lib/performance";
import { toYahooSymbol } from "../lib/intraday/yahoo";
import {
  normalizeDividend,
  dividendCashImpact,
  shouldBookDividend,
  dividendDedupeKey,
} from "../lib/dividends";

const yf = new YahooFinance();
const SYSTEM_EMAIL = "system@bigcapital.invalid";

export interface DividendIngestResult {
  fundsProcessed: number;
  securitiesChecked: number;
  dividendsBooked: number;
  skipped: {
    notHeld: number;
    alreadyBooked: number;
    unsupportedCurrency: number;
    noFxRate: number;
    noPerShare: number;
  };
  errors: Array<{ scope: string; message: string }>;
}

async function getSystemUserId(): Promise<string> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, SYSTEM_EMAIL)).limit(1);
  if (existing.length > 0) return existing[0].id;
  const inserted = await db
    .insert(users)
    .values({ email: SYSTEM_EMAIL, fullName: "BIG Capital System", role: "analyst", isActive: true })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (inserted.length > 0) return inserted[0].id;
  const again = await db.select({ id: users.id }).from(users).where(eq(users.email, SYSTEM_EMAIL)).limit(1);
  return again[0].id;
}

async function resolveFxToBase(from: Currency, to: Currency, onOrBefore: string): Promise<string | null> {
  if (from === to) return "1";
  const direct = await db
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(and(eq(fxRates.fromCurrency, from), eq(fxRates.toCurrency, to), lte(fxRates.date, onOrBefore)))
    .orderBy(desc(fxRates.date))
    .limit(1);
  if (direct.length > 0) return direct[0].rate;
  const inverse = await db
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(and(eq(fxRates.fromCurrency, to), eq(fxRates.toCurrency, from), lte(fxRates.date, onOrBefore)))
    .orderBy(desc(fxRates.date))
    .limit(1);
  if (inverse.length > 0) {
    const r = new Decimal(inverse[0].rate);
    if (r.isZero()) return null;
    return new Decimal(1).dividedBy(r).toString();
  }
  return null;
}

export interface DividendIngestOptions {
  fundSlug?: string;
  from?: string;
  to?: string;
}

export async function runYahooDividendIngest(opts: DividendIngestOptions = {}): Promise<DividendIngestResult> {
  const result: DividendIngestResult = {
    fundsProcessed: 0,
    securitiesChecked: 0,
    dividendsBooked: 0,
    skipped: { notHeld: 0, alreadyBooked: 0, unsupportedCurrency: 0, noFxRate: 0, noPerShare: 0 },
    errors: [],
  };

  const systemUserId = await getSystemUserId();
  const today = new Date().toISOString().slice(0, 10);

  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(opts.fundSlug ? eq(fundsTable.slug, opts.fundSlug) : eq(fundsTable.isActive, true));

  for (const fund of fundRows) {
    result.fundsProcessed += 1;
    const baseCurrency = fund.baseCurrency as Currency;
    const from = opts.from ?? fund.inceptionDate;
    const to = opts.to ?? today;

    const rawTxns = await db.select().from(transactionsTable).where(eq(transactionsTable.fundId, fund.id));
    const txns: Transaction[] = rawTxns.map((t) => ({
      id: t.id,
      fundId: t.fundId,
      securityId: t.securityId,
      transactionType: t.transactionType as Transaction["transactionType"],
      quantity: t.quantity,
      price: t.price,
      currency: t.currency as Currency,
      cashImpact: t.cashImpact,
      fxRateToBase: t.fxRateToBase,
      executedAt: t.executedAt,
    }));

    const booked = new Set<string>();
    for (const t of rawTxns) {
      if (t.transactionType === "dividend" && t.securityId) {
        booked.add(dividendDedupeKey(fund.id, t.securityId, t.executedAt.toISOString().slice(0, 10)));
      }
    }

    const heldSecIds = Array.from(new Set(rawTxns.filter((t) => t.securityId).map((t) => t.securityId as string)));
    if (heldSecIds.length === 0) continue;
    const secRows = await db.select().from(securitiesTable).where(isNotNull(securitiesTable.id));
    const secById = new Map(secRows.map((s) => [s.id, s]));

    for (const secId of heldSecIds) {
      const sec = secById.get(secId);
      if (!sec) continue;
      result.securitiesChecked += 1;
      const yahooSym = toYahooSymbol(sec.ticker, sec.exchange);

      let metaCurrency: string;
      let dividends: Array<{ amount: number; date: Date }>;
      try {
        const chart = await yf.chart(yahooSym, {
          period1: from,
          period2: to,
          interval: "1mo", // events (dividends) are returned regardless of bar interval; keep payload small
          events: "div",
        });
        metaCurrency = chart.meta?.currency ?? "";
        dividends = (chart.events?.dividends ?? []) as Array<{ amount: number; date: Date }>;
      } catch (err) {
        result.errors.push({ scope: yahooSym, message: err instanceof Error ? err.message : String(err) });
        continue;
      }

      for (const d of dividends) {
        const exDate = new Date(d.date).toISOString().slice(0, 10);
        if (exDate < from || exDate > to) continue;

        const amount = d.amount;
        if (amount == null || !Number.isFinite(amount) || amount <= 0) {
          result.skipped.noPerShare += 1;
          continue;
        }

        // meta.currency carries pence (GBp/GBX) for LSE names -> normaliseDividend divides by 100.
        const norm = normalizeDividend(metaCurrency, amount, sec.currency as Currency);
        if (!norm) {
          result.skipped.unsupportedCurrency += 1;
          continue;
        }

        const key = dividendDedupeKey(fund.id, secId, exDate);
        if (booked.has(key)) {
          result.skipped.alreadyBooked += 1;
          continue;
        }

        const state = buildLedgerState(txns, new Date(`${exDate}T23:59:59Z`));
        const sharesHeld = state.positions.get(secId)?.quantity ?? new Decimal(0);
        if (!shouldBookDividend(norm.perShare, sharesHeld)) {
          result.skipped.notHeld += 1;
          continue;
        }

        const fxRateToBase = await resolveFxToBase(norm.currency, baseCurrency, exDate);
        if (fxRateToBase == null) {
          result.skipped.noFxRate += 1;
          continue;
        }

        const cashImpact = dividendCashImpact(norm.perShare, sharesHeld);
        try {
          await db.insert(transactionsTable).values({
            fundId: fund.id,
            securityId: secId,
            transactionType: "dividend",
            quantity: "0",
            price: norm.perShare.toString(),
            currency: norm.currency,
            cashImpact: cashImpact.toString(),
            fxRateToBase,
            executedAt: new Date(`${exDate}T00:00:00Z`),
            submittedAt: new Date(),
            executedByUserId: systemUserId,
            feeAmount: "0",
            rationale: `Automatic dividend (Yahoo): ${sec.ticker}.${sec.exchange} ex-date ${exDate}, ${norm.perShare.toString()} ${norm.currency}/share on ${sharesHeld.toString()} shares.`,
            memoId: null,
            thesisId: null,
          });
          booked.add(key);
          result.dividendsBooked += 1;
        } catch (err) {
          result.errors.push({ scope: `book ${sec.ticker} ${exDate}`, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  return result;
}
