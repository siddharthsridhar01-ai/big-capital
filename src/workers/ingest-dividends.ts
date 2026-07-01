/**
 * Worker: Dividend ingestion (total-return accounting).
 *
 * For every security a fund has ever held, pull its dividend history from
 * EODHD and, for each ex-date the fund actually held shares, book a `dividend`
 * transaction (cash in, no share-count change). The ledger already treats a
 * dividend as pure cash, so once these rows exist NAV/returns become total
 * return automatically.
 *
 * Design decisions (see src/lib/dividends.ts):
 *   - Holder as of the EX-DATE (shares replayed from the immutable ledger).
 *   - Per-share = unadjustedValue (actual cash paid then), GBX/GBp -> GBP.
 *   - Shorts pay (sign carried by signed share count).
 *   - Idempotent: dedupe on (fund, security, ex-date); safe to re-run/backfill.
 *
 * Triggers: cron /api/cron/dividends, admin /api/admin/ingest-dividends.
 * Coverage depends on EODHD returning dividends for each security's symbol.
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
import { EodhdClient } from "../lib/eodhd";
import { buildLedgerState, type Transaction, type Currency } from "../lib/performance";
import {
  selectPerShareRaw,
  normalizeDividend,
  dividendCashImpact,
  shouldBookDividend,
  dividendDedupeKey,
} from "../lib/dividends";

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

/** Ensure a single system user to attribute auto-booked dividends to. */
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

/**
 * FX rate from `from` to `to` on or before a date. Ex-dates land on arbitrary
 * calendar days (weekends, holidays), so we take the most recent rate at/prior
 * to the ex-date rather than requiring an exact match. Returns null if none.
 */
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
  fundSlug?: string; // limit to one fund
  from?: string; // ex-date lower bound (default: fund inception)
  to?: string; // ex-date upper bound (default: today)
}

export async function runDividendIngest(opts: DividendIngestOptions = {}): Promise<DividendIngestResult> {
  const apiToken = process.env.EODHD_API_TOKEN;
  if (!apiToken) throw new Error("EODHD_API_TOKEN not set");
  const client = new EodhdClient({ apiToken });

  const result: DividendIngestResult = {
    fundsProcessed: 0,
    securitiesChecked: 0,
    dividendsBooked: 0,
    skipped: { notHeld: 0, alreadyBooked: 0, unsupportedCurrency: 0, noFxRate: 0, noPerShare: 0 },
    errors: [],
  };

  const systemUserId = await getSystemUserId();

  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(opts.fundSlug ? eq(fundsTable.slug, opts.fundSlug) : eq(fundsTable.isActive, true));

  const today = new Date().toISOString().slice(0, 10);

  for (const fund of fundRows) {
    result.fundsProcessed += 1;
    const baseCurrency = fund.baseCurrency as Currency;
    const from = opts.from ?? fund.inceptionDate;
    const to = opts.to ?? today;

    // Immutable ledger for this fund (replayed per ex-date).
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

    // Dedupe set: dividends already booked for this fund.
    const booked = new Set<string>();
    for (const t of rawTxns) {
      if (t.transactionType === "dividend" && t.securityId) {
        booked.add(dividendDedupeKey(fund.id, t.securityId, t.executedAt.toISOString().slice(0, 10)));
      }
    }

    // Securities the fund has ever held.
    const heldSecIds = Array.from(new Set(rawTxns.filter((t) => t.securityId).map((t) => t.securityId as string)));
    if (heldSecIds.length === 0) continue;
    const secRows = await db.select().from(securitiesTable).where(isNotNull(securitiesTable.id));
    const secById = new Map(secRows.map((s) => [s.id, s]));

    for (const secId of heldSecIds) {
      const sec = secById.get(secId);
      if (!sec) continue;
      result.securitiesChecked += 1;

      let divs;
      try {
        divs = await client.getDividends(sec.ticker, sec.exchange, from, to);
      } catch (err) {
        result.errors.push({ scope: `${sec.ticker}.${sec.exchange}`, message: err instanceof Error ? err.message : String(err) });
        continue;
      }

      for (const d of divs) {
        const exDate = d.date;
        if (exDate < from || exDate > to) continue;

        const perShareRaw = selectPerShareRaw(d);
        if (perShareRaw == null) {
          result.skipped.noPerShare += 1;
          continue;
        }
        const norm = normalizeDividend(d.currency, perShareRaw, sec.currency as Currency);
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
        const nowTs = new Date();
        try {
          await db.insert(transactionsTable).values({
            fundId: fund.id,
            securityId: secId,
            transactionType: "dividend",
            quantity: "0", // dividends never change the share count
            price: norm.perShare.toString(), // per-share amount, for the record
            currency: norm.currency,
            cashImpact: cashImpact.toString(),
            fxRateToBase,
            executedAt: new Date(`${exDate}T00:00:00Z`),
            submittedAt: nowTs,
            executedByUserId: systemUserId,
            feeAmount: "0",
            rationale: `Automatic dividend: ${sec.ticker}.${sec.exchange} ex-date ${exDate}, ${norm.perShare.toString()} ${norm.currency}/share on ${sharesHeld.toString()} shares.`,
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
