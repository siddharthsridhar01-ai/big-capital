/**
 * Book a merger, takeover or spin-off across every fund that holds the security.
 *
 * PREVIEW BY DEFAULT. With apply=false nothing is written: the caller gets each
 * fund's before and after — shares, cost, cash, realised P&L — to check before
 * committing. A corporate action rewrites holdings, so an admin should always
 * see the result first.
 *
 * ATOMIC. With apply=true every fund's entries, and the feed record, are written
 * in a single database transaction. If any part fails, nothing is booked — a
 * corporate action half-applied across funds would be worse than none.
 *
 * ONCE. The same event (kind, security, effective date) cannot be booked twice.
 *
 * Holders are those holding at the end of the day before the effective date,
 * and entries are stamped at its midnight so they apply before anything traded
 * that day. See src/lib/corporate-action-booking.ts for the accounting.
 *
 * Resolving the security received may create its row and backfill its prices,
 * even in preview: that is harmless, idempotent, and needed to know its currency.
 * It is never added to a fund's universe — see ensureSecurityForCorporateAction.
 */
import { db } from "../db/client";
import {
  funds as fundsTable,
  transactions as transactionsTable,
  securities as securitiesTable,
  corporateActionEvents,
} from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import { buildLedgerState, type Transaction, type Currency } from "../lib/performance";
import { resolveFxToBase } from "../lib/fx";
import { planMerger, planSpinOff, type Leg } from "../lib/corporate-action-booking";
import { ensureSecurityForCorporateAction } from "../lib/universe-add";

export interface BookingRequest {
  kind: "merger" | "spin_off";
  /** The security held: the target of a merger, or the parent of a spin-off. */
  securityId: string;
  effectiveDate: string;
  /** Shares received per share held. 0 for an all-cash takeover. */
  ratio: string;
  /** Merger only: cash per share held, in the held security's currency. */
  cashPerShare?: string;
  /** Ticker of the shares received (acquirer or spin-off), when there are any. */
  receivedSymbol?: string;
  /** Price of the shares received on the effective date. */
  receivedPrice?: string;
  /** Spin-off only: the parent's price on the ex-date. */
  parentPrice?: string;
  /** The feed event this resolves, if booked from the feed. */
  eventId?: string;
  apply: boolean;
  userId: string;
}

export interface FundImpact {
  fund: string;
  before: { heldShares: string; avgCost: string };
  after: { heldShares: string; receivedShares: string; cashChange: string };
  realisedPnl: string;
  entries: number;
}

export type BookingResult =
  | {
      ok: true;
      applied: boolean;
      title: string;
      summary: string;
      impacts: FundImpact[];
      receivedTicker: string | null;
    }
  | { ok: false; error: string };

const D = (v: string | undefined, name: string): Decimal => {
  if (v == null || v.trim() === "") throw new Error(`${name} is required`);
  const d = new Decimal(v);
  if (!d.isFinite()) throw new Error(`${name} is not a number`);
  return d;
};

export async function bookCorporateAction(req: BookingRequest): Promise<BookingResult> {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.effectiveDate)) {
      return { ok: false, error: "Effective date must be YYYY-MM-DD" };
    }
    const ratio = D(req.ratio, "Ratio");
    const isSpin = req.kind === "spin_off";
    const cashPerShare = isSpin ? new Decimal(0) : new Decimal(req.cashPerShare?.trim() || "0");

    const [held] = await db.select().from(securitiesTable).where(eq(securitiesTable.id, req.securityId)).limit(1);
    if (!held) return { ok: false, error: "Security not found" };
    const heldCcy = held.currency as Currency;

    // The security received, if any shares change hands.
    const needsReceived = isSpin || ratio.greaterThan(0);
    let received: { securityId: string; ticker: string; currency: Currency } | null = null;
    if (needsReceived) {
      if (!req.receivedSymbol?.trim()) {
        return { ok: false, error: isSpin ? "Enter the spin-off's ticker" : "Enter the acquirer's ticker" };
      }
      const r = await ensureSecurityForCorporateAction(req.receivedSymbol);
      if (!r.ok) return { ok: false, error: r.error };
      received = { securityId: r.securityId, ticker: r.ticker, currency: r.currency as Currency };
    }
    const receivedPrice = needsReceived ? D(req.receivedPrice, "Price of the shares received") : new Decimal(0);
    const parentPrice = isSpin ? D(req.parentPrice, "Parent's ex-date price") : new Decimal(0);

    const fxIn = received ? await resolveFxToBase(received.currency, heldCcy, req.effectiveDate) : new Decimal(1);

    const dedupeKey = `booked|${req.kind}|${req.securityId}|${req.effectiveDate}`;
    if (req.apply) {
      const already = await db
        .select({ id: corporateActionEvents.id })
        .from(corporateActionEvents)
        .where(eq(corporateActionEvents.dedupeKey, dedupeKey))
        .limit(1);
      if (already.length > 0) {
        return { ok: false, error: "This corporate action has already been booked." };
      }
    }

    const recordAsOf = new Date(Date.parse(`${req.effectiveDate}T00:00:00Z`) - 1);
    const midnight = Date.parse(`${req.effectiveDate}T00:00:00Z`);
    const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.isActive, true));

    type Planned = { fund: (typeof fundRows)[number]; legs: Leg[]; impact: FundImpact };
    const planned: Planned[] = [];

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
      const pos = buildLedgerState(txns, recordAsOf).positions.get(req.securityId);
      if (!pos || pos.quantity.isZero()) continue;

      let legs: Leg[];
      let realised = new Decimal(0);
      let receivedShares = new Decimal(0);
      let cashChange = new Decimal(0);
      let heldAfter = new Decimal(0);

      if (isSpin) {
        const p = planSpinOff({
          held: pos.quantity,
          avgCost: pos.avgCostNative,
          ratio,
          parentPrice,
          spincoPrice: receivedPrice,
          fxSpincoToParent: fxIn,
        });
        legs = p.legs;
        receivedShares = p.spincoShares;
        heldAfter = pos.quantity;
      } else {
        const p = planMerger({
          held: pos.quantity,
          avgCost: pos.avgCostNative,
          ratio,
          cashPerShare,
          receivedPrice,
          fxReceivedToTarget: fxIn,
        });
        legs = p.legs;
        realised = p.realisedPnl;
        receivedShares = p.receivedShares;
      }
      cashChange = legs.reduce((s, l) => s.plus(l.cashImpact), new Decimal(0));

      planned.push({
        fund,
        legs,
        impact: {
          fund: fund.slug,
          before: { heldShares: pos.quantity.toString(), avgCost: pos.avgCostNative.toFixed(4) },
          after: {
            heldShares: heldAfter.toString(),
            receivedShares: receivedShares.toString(),
            cashChange: cashChange.toFixed(2),
          },
          realisedPnl: realised.toFixed(2),
          entries: legs.length,
        },
      });
    }

    if (planned.length === 0) {
      return { ok: false, error: `No fund held ${held.ticker} at the end of the day before ${req.effectiveDate}.` };
    }

    const title = isSpin
      ? `${held.ticker}: spin-off of ${received?.ticker}`
      : ratio.isZero()
        ? `${held.ticker}: cash takeover at ${cashPerShare.toString()} ${heldCcy}`
        : `${held.ticker}: merger into ${received?.ticker}`;
    const summary = isSpin
      ? `${ratio.toString()} ${received?.ticker} per ${held.ticker} share; cost basis split by relative value, nothing realised.`
      : ratio.isZero()
        ? `Closed at ${cashPerShare.toString()} ${heldCcy} a share; gain or loss realised.`
        : `${ratio.toString()} ${received?.ticker}` +
          (cashPerShare.greaterThan(0) ? ` plus ${cashPerShare.toString()} ${heldCcy}` : "") +
          ` per ${held.ticker} share, at fair value.`;

    if (!req.apply) {
      return {
        ok: true,
        applied: false,
        title,
        summary,
        impacts: planned.map((p) => p.impact),
        receivedTicker: received?.ticker ?? null,
      };
    }

    // ----- Apply: every fund, and the feed record, in one transaction -----
    await db.transaction(async (tx) => {
      const allIds: string[] = [];
      for (const p of planned) {
        const base = p.fund.baseCurrency as Currency;
        for (const leg of p.legs) {
          const isHeldLeg = leg.role === "target" || leg.role === "parent";
          const securityId = isHeldLeg ? req.securityId : received!.securityId;
          const currency = isHeldLeg ? heldCcy : received!.currency;
          const fx = await resolveFxToBase(currency, base, req.effectiveDate);
          const rows = await tx
            .insert(transactionsTable)
            .values({
              fundId: p.fund.id,
              securityId,
              transactionType: leg.transactionType,
              quantity: leg.quantity.toString(),
              price: leg.price.toString(),
              currency,
              cashImpact: leg.cashImpact.toString(),
              fxRateToBase: fx.toString(),
              executedAt: new Date(midnight + leg.offsetMs),
              submittedAt: new Date(),
              executedByUserId: req.userId,
              feeAmount: "0",
              rationale: `${title}. ${leg.note}.`,
              memoId: null,
              thesisId: null,
            })
            .returning({ id: transactionsTable.id });
          rows.forEach((r) => allIds.push(r.id));
        }
      }

      await tx.insert(corporateActionEvents).values({
        securityId: req.securityId,
        kind: isSpin ? "spin_off" : ratio.isZero() ? "takeover_cash" : "merger_stock",
        status: "booked",
        source: "admin",
        title,
        detail: summary,
        eventDate: req.effectiveDate,
        dedupeKey,
        impact: { severity: "info", funds: planned.map((p) => p.impact) },
        transactionIds: allIds,
        resolvedAt: new Date(),
        resolvedByUserId: req.userId,
      });

      // The warning that prompted this is now resolved.
      if (req.eventId) {
        await tx
          .update(corporateActionEvents)
          .set({ status: "booked", resolvedAt: new Date(), resolvedByUserId: req.userId })
          .where(eq(corporateActionEvents.id, req.eventId));
      }
    });

    return {
      ok: true,
      applied: true,
      title,
      summary,
      impacts: planned.map((p) => p.impact),
      receivedTicker: received?.ticker ?? null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
