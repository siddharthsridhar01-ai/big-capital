/**
 * Automatic stock split processing.
 *
 * Splits are the one corporate action that is both mechanical and reliably
 * sourced: Yahoo's chart() returns them as events with a numerator and
 * denominator, the same way it returns dividends. So they are processed the way
 * a fund administrator processes them — automatically, without review.
 *
 * WHY THIS MATTERS: prices are stored raw and positions are share counts. A
 * 10-for-1 split cuts the price by ninety per cent overnight while the share
 * count stays put, so an unprocessed split reads as a ninety per cent loss on
 * that holding — and every health check passes, because NAV still computes.
 *
 * ACCOUNTING (see src/lib/corporate-actions.ts):
 *   1. A `corporate_action` restatement on the ex-date: shares become held ×
 *      ratio, total cost basis preserved, no cash, no realised P&L.
 *   2. If that leaves a fraction (e.g. a 3-for-2 split of 25 shares = 37.5),
 *      the fraction is settled as CASH IN LIEU at the ex-date close — booked as
 *      an ordinary disposal so its realised P&L is measured against the
 *      restated cost. This is what a broker does.
 *
 * The restatement is stamped at 00:00 UTC on the ex-date, so it sorts after
 * every pre-split trade and before anything traded on the ex-date itself —
 * fills happen at exchange opens, which are never midnight UTC. Ex-date trades
 * are already in post-split shares and must not be multiplied again.
 *
 * Holders are those holding at the end of the day BEFORE the ex-date.
 *
 * Idempotent: a split already booked for that fund, security and ex-date is
 * skipped, so this is safe to run every hour.
 *
 * A split that leaves a fraction is deferred until the ex-date close exists,
 * since cash in lieu needs a reference price. Whole-share splits book at once.
 */
import { db } from "../db/client";
import {
  funds as fundsTable,
  transactions as transactionsTable,
  securities as securitiesTable,
  prices as pricesTable,
  fxRates,
  users,
} from "../db/schema";
import { and, eq, lte, desc, inArray, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import YahooFinance from "yahoo-finance2";
import { buildLedgerState, type Transaction, type Currency } from "../lib/performance";
import { toYahooSymbol } from "../lib/intraday/yahoo";
import {
  planSplit,
  cashInLieu,
  describeSplit,
  splitDedupeKey,
} from "../lib/corporate-actions";

const yf = new YahooFinance();
const SYSTEM_EMAIL = "system@bigcapital.invalid";

export interface SplitProcessResult {
  fundsProcessed: number;
  securitiesChecked: number;
  splitsBooked: number;
  cashInLieuBooked: number;
  booked: Array<{ fund: string; ticker: string; exDate: string; ratio: string; before: string; after: string }>;
  skipped: {
    notHeld: number;
    alreadyBooked: number;
    awaitingClose: number;
    noFxRate: number;
    invalidRatio: number;
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

async function fxToBase(from: Currency, to: Currency, onOrBefore: string): Promise<string | null> {
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
  if (inverse.length === 0) return null;
  const r = new Decimal(inverse[0].rate);
  return r.isZero() ? null : new Decimal(1).dividedBy(r).toString();
}

export async function runSplitProcessing(opts: { fundSlug?: string } = {}): Promise<SplitProcessResult> {
  const result: SplitProcessResult = {
    fundsProcessed: 0,
    securitiesChecked: 0,
    splitsBooked: 0,
    cashInLieuBooked: 0,
    booked: [],
    skipped: { notHeld: 0, alreadyBooked: 0, awaitingClose: 0, noFxRate: 0, invalidRatio: 0 },
    errors: [],
  };

  const systemUserId = await getSystemUserId();
  const today = new Date().toISOString().slice(0, 10);

  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(opts.fundSlug ? eq(fundsTable.slug, opts.fundSlug) : eq(fundsTable.isActive, true));

  // Pass 1: each fund's ledger, already-booked splits, and held securities.
  type Ctx = { fund: (typeof fundRows)[number]; raw: Array<typeof transactionsTable.$inferSelect>; txns: Transaction[]; booked: Set<string>; held: string[] };
  const ctxs: Ctx[] = [];
  const heldUnion = new Set<string>();
  for (const fund of fundRows) {
    const raw = await db
      .select()
      .from(transactionsTable)
      .where(and(eq(transactionsTable.fundId, fund.id), isNull(transactionsTable.voidedAt)));
    const txns: Transaction[] = raw.map((t) => ({
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
    for (const t of raw) {
      if (t.transactionType === "corporate_action" && t.securityId) {
        booked.add(splitDedupeKey(fund.id, t.securityId, t.executedAt.toISOString().slice(0, 10)));
      }
    }
    const held = Array.from(new Set(raw.filter((t) => t.securityId).map((t) => t.securityId as string)));
    held.forEach((id) => heldUnion.add(id));
    ctxs.push({ fund, raw, txns, booked, held });
  }

  const allHeld = Array.from(heldUnion);
  if (allHeld.length === 0) {
    result.fundsProcessed = ctxs.length;
    return result;
  }

  const secRows = await db.select().from(securitiesTable).where(inArray(securitiesTable.id, allHeld));
  const secById = new Map(secRows.map((s) => [s.id, s]));

  // Fetch each held security's split events from Yahoo once.
  const earliest = ctxs.reduce((min, c) => (c.fund.inceptionDate < min ? c.fund.inceptionDate : min), today);
  // Fetched in parallel batches, NOT one at a time. Once every fund is invested
  // there are well over a hundred held securities; sequential calls at a few
  // hundred milliseconds each would exceed Vercel's 60-second limit, which is
  // precisely how the nightly NAV job timed out and froze every fund in August.
  const splitCache = new Map<string, Array<{ date: Date; numerator: number; denominator: number }>>();
  const CONCURRENCY = 8;
  for (let i = 0; i < allHeld.length; i += CONCURRENCY) {
    await Promise.all(
      allHeld.slice(i, i + CONCURRENCY).map(async (secId) => {
        const sec = secById.get(secId);
        if (!sec) return;
        const sym = toYahooSymbol(sec.ticker, sec.exchange);
        try {
          const chart = await yf.chart(sym, {
            period1: earliest,
            period2: today,
            interval: "1mo", // events are returned regardless of bar interval
            events: "split",
          });
          splitCache.set(
            secId,
            (chart.events?.splits ?? []) as Array<{ date: Date; numerator: number; denominator: number }>
          );
        } catch (err) {
          result.errors.push({ scope: sym, message: err instanceof Error ? err.message : String(err) });
        }
      })
    );
  }

  // Pass 2: book per fund.
  for (const ctx of ctxs) {
    result.fundsProcessed += 1;
    const { fund, txns, booked, held } = ctx;
    const base = fund.baseCurrency as Currency;

    for (const secId of held) {
      const sec = secById.get(secId);
      const splits = splitCache.get(secId);
      if (!sec || !splits) continue;
      result.securitiesChecked += 1;

      for (const s of splits) {
        const exDate = new Date(s.date).toISOString().slice(0, 10);
        if (exDate < fund.inceptionDate || exDate > today) continue;

        if (!(s.numerator > 0) || !(s.denominator > 0) || s.numerator === s.denominator) {
          result.skipped.invalidRatio += 1;
          continue;
        }

        const key = splitDedupeKey(fund.id, secId, exDate);
        if (booked.has(key)) {
          result.skipped.alreadyBooked += 1;
          continue;
        }

        // Holders at the end of the day BEFORE the ex-date.
        const recordAsOf = new Date(new Date(`${exDate}T00:00:00Z`).getTime() - 1);
        const state = buildLedgerState(txns, recordAsOf);
        const heldQty = state.positions.get(secId)?.quantity ?? new Decimal(0);
        if (heldQty.isZero()) {
          result.skipped.notHeld += 1;
          continue;
        }

        const plan = planSplit(heldQty, s.numerator, s.denominator);
        const currency = sec.currency as Currency;
        const fx = await fxToBase(currency, base, exDate);
        if (fx == null) {
          result.skipped.noFxRate += 1;
          continue;
        }

        // A fraction needs the ex-date close to settle; defer until it exists.
        let refPrice: Decimal | null = null;
        if (!plan.fractional.isZero()) {
          const close = await db
            .select({ close: pricesTable.closePrice })
            .from(pricesTable)
            .where(and(eq(pricesTable.securityId, secId), eq(pricesTable.date, exDate)))
            .limit(1);
          if (close.length === 0) {
            result.skipped.awaitingClose += 1;
            continue;
          }
          refPrice = new Decimal(close[0].close);
        }

        const label = describeSplit(s.numerator, s.denominator);
        const exStamp = new Date(`${exDate}T00:00:00Z`);

        try {
          await db.insert(transactionsTable).values({
            fundId: fund.id,
            securityId: secId,
            transactionType: "corporate_action",
            quantity: plan.restateDelta.toString(),
            price: "0",
            currency,
            cashImpact: "0",
            fxRateToBase: fx,
            executedAt: exStamp,
            submittedAt: new Date(),
            executedByUserId: systemUserId,
            feeAmount: "0",
            rationale:
              `Automatic ${label} stock split (Yahoo), ex-date ${exDate}: ` +
              `${heldQty.toString()} shares restated to ${plan.exactShares.toString()}, ` +
              `total cost basis unchanged.`,
            memoId: null,
            thesisId: null,
          });
          booked.add(key);
          result.splitsBooked += 1;

          if (refPrice && !plan.fractional.isZero()) {
            const cil = cashInLieu(plan.fractional, refPrice);
            await db.insert(transactionsTable).values({
              fundId: fund.id,
              securityId: secId,
              transactionType: cil.transactionType,
              quantity: cil.quantity.toString(),
              price: refPrice.toString(),
              currency,
              cashImpact: cil.cashImpact.toString(),
              fxRateToBase: fx,
              // A millisecond after the restatement, so it applies to restated shares.
              executedAt: new Date(exStamp.getTime() + 1),
              submittedAt: new Date(),
              executedByUserId: systemUserId,
              feeAmount: "0",
              rationale:
                `Cash in lieu of ${plan.fractional.abs().toString()} fractional share(s) ` +
                `from the ${label} split, settled at the ex-date close of ${refPrice.toString()} ${currency}.`,
              memoId: null,
              thesisId: null,
            });
            result.cashInLieuBooked += 1;
          }

          result.booked.push({
            fund: fund.slug,
            ticker: sec.ticker,
            exDate,
            ratio: label,
            before: heldQty.toString(),
            after: plan.wholeShares.toString(),
          });
        } catch (err) {
          result.errors.push({
            scope: `book split ${sec.ticker} ${exDate}`,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return result;
}
