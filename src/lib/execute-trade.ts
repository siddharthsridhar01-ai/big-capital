/**
 * Shared trade execution — the authoritative, lock-protected path that turns a
 * priced order into a ledger transaction: re-reads fund state under a per-fund
 * advisory lock, runs the constraint engine, and (if it passes) inserts the
 * transaction, thesis note, position lifecycle, and thesis close.
 *
 * Extracted verbatim from the submit-trade route so the immediate-fill path and
 * the next-close fill job execute through exactly the same, battle-tested code.
 * Returns a discriminated result rather than throwing HTTP responses.
 */
import { db } from "@/db/client";
import {
  fundConstraints as fundConstraintsTable,
  transactions as transactionsTable,
  positions as positionsTable,
  tradeAttachments,
  investableUniverses,
} from "@/db/schema";
import { theses as thesesTable, thesisUpdates } from "@/db/schema-theses";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  checkTrade,
  type FundConstraint,
  type ProposedTrade,
  type PortfolioContext,
} from "@/lib/constraints";
import {
  computePortfolioState,
  FALLBACK_FX_SOURCE,
  type Currency,
} from "@/lib/portfolio";

// Thrown inside the trade transaction to reject cleanly (rolls back any writes)
// while carrying the exact HTTP status + payload the caller should return.
export class TradeHalt extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: Record<string, unknown>
  ) {
    super("trade-halt");
  }
}

export interface ExecuteTradeParams {
  fund: { id: string; baseCurrency: string; tradingFeesBps: number };
  security: { id: string; ticker: string; currency: string; gicsSector: string | null };
  side: "buy" | "sell" | "short" | "cover";
  shares: number;
  priceNative: Decimal;
  fxToBase: Decimal;
  userId: string;
  executedAt: Date;
  rationale: string;
  priceProviderLabel: string;
  linkedThesis: { id: string; direction: string | null; status: string } | null;
  updateNote?: string | null;
  softOverrideJustification?: string | null;
  memo?: { url: string; filename: string; sizeBytes: number } | null;
}

export type ExecuteTradeResult =
  | { ok: true; transactionId: string; closedThesisId: string | null }
  | { ok: false; status: number; payload: Record<string, unknown> };

export async function executeTrade(p: ExecuteTradeParams): Promise<ExecuteTradeResult> {
  const { fund, security, priceNative, fxToBase, executedAt } = p;
  try {
    const writeResult = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${fund.id}))`);

      const state = await computePortfolioState(fund.id, undefined, {
        skipLivePrices: true,
      });

      const investableUniverseRows = await tx
        .select({ securityId: investableUniverses.securityId })
        .from(investableUniverses)
        .where(
          and(
            eq(investableUniverses.fundId, fund.id),
            isNull(investableUniverses.removedDate)
          )
        );
      const investableUniverse = new Set(
        investableUniverseRows.map((r) => r.securityId)
      );

      const securityMeta = new Map<
        string,
        { ticker: string; sector: string | null; currency: Currency }
      >();
      securityMeta.set(security.id, {
        ticker: security.ticker,
        sector: security.gicsSector,
        currency: security.currency as Currency,
      });
      for (const [id, pos] of state.positions) {
        securityMeta.set(id, {
          ticker: pos.ticker,
          sector: pos.gicsSector,
          currency: pos.currency,
        });
      }

      const fxRates = new Map<string, string>();
      const dateStr = executedAt.toISOString().slice(0, 10);
      fxRates.set(
        `${security.currency}/${fund.baseCurrency}/${dateStr}`,
        fxToBase.toString()
      );

      const enginePositions = new Map();
      for (const [id, pos] of state.positions) {
        enginePositions.set(id, {
          securityId: id,
          quantity: pos.quantity,
          avgCostNative: pos.avgCostNative,
          currency: pos.currency,
        });
      }

      const cashByCurrency = new Map();
      for (const [ccy, amt] of state.cashByCurrency) {
        cashByCurrency.set(ccy, amt);
      }

      const allConstraints = await tx
        .select()
        .from(fundConstraintsTable)
        .where(
          and(
            eq(fundConstraintsTable.fundId, fund.id),
            eq(fundConstraintsTable.isActive, true)
          )
        );
      const dedupedConstraintsMap = new Map<
        string,
        (typeof allConstraints)[number]
      >();
      for (const c of allConstraints) {
        if (!dedupedConstraintsMap.has(c.constraintType)) {
          dedupedConstraintsMap.set(c.constraintType, c);
        }
      }
      const constraints: FundConstraint[] = Array.from(
        dedupedConstraintsMap.values()
      ).map((c) => ({
        id: c.id,
        constraintType: c.constraintType as FundConstraint["constraintType"],
        value: c.value,
        isHard: c.isHard,
      }));

      const trade: ProposedTrade = {
        securityId: security.id,
        side: p.side,
        quantity: new Decimal(p.shares),
        price: priceNative,
        currency: security.currency as Currency,
      };

      const pricesPostTrade = new Map<string, Decimal>([[security.id, priceNative]]);
      for (const [id, pos] of state.positions) {
        if (pos.latestPriceNative) {
          pricesPostTrade.set(id, pos.latestPriceNative);
        }
      }

      const ctx: PortfolioContext = {
        navBase: state.navBase,
        cashByCurrency,
        positions: enginePositions,
        fxRates,
        baseCurrency: fund.baseCurrency as Currency,
        date: dateStr,
        securityMeta,
        investableUniverse,
      };

      let check;
      try {
        check = checkTrade(constraints, trade, ctx, pricesPostTrade);
      } catch (err) {
        throw new TradeHalt(500, {
          ok: false,
          error:
            err instanceof Error ? err.message : "Constraint check failed unexpectedly",
        });
      }

      if (check.hardViolations.length > 0) {
        throw new TradeHalt(409, {
          ok: false,
          error:
            "Trade rejected: it breaches a hard constraint against the fund's current state.",
          hardViolations: check.hardViolations.map((v) => ({
            constraintType: v.constraintType,
            message: v.message,
          })),
        });
      }

      if (check.softViolations.length > 0) {
        const just = (p.softOverrideJustification ?? "").trim();
        if (just.length < 20) {
          throw new TradeHalt(400, {
            ok: false,
            error:
              "Soft constraint breaches require a written justification of at least 20 characters",
            softViolations: check.softViolations.map((v) => ({
              constraintType: v.constraintType,
              message: v.message,
            })),
          });
        }
      }

      const signedQuantity =
        p.side === "buy" || p.side === "cover"
          ? new Decimal(p.shares)
          : new Decimal(p.shares).negated();

      const notionalNative = new Decimal(p.shares).times(priceNative);
      const feeBase = notionalNative
        .times(fxToBase)
        .times(fund.tradingFeesBps)
        .dividedBy(10000);
      const feeNative = feeBase.dividedBy(fxToBase);

      const isOutflow = p.side === "buy" || p.side === "cover";
      const cashImpactNative = isOutflow
        ? notionalNative.plus(feeNative).negated()
        : notionalNative.minus(feeNative);

      const txnInsert = await tx
        .insert(transactionsTable)
        .values({
          fundId: fund.id,
          securityId: security.id,
          transactionType: p.side,
          quantity: signedQuantity.toString(),
          price: priceNative.toString(),
          currency: security.currency as Currency,
          cashImpact: cashImpactNative.toString(),
          fxRateToBase: fxToBase.toString(),
          executedAt,
          submittedAt: executedAt,
          executedByUserId: p.userId,
          feeAmount: feeBase.toString(),
          rationale: p.rationale,
          memoId: null,
          thesisId: p.linkedThesis ? p.linkedThesis.id : null,
          notes: (() => {
            const parts: string[] = [];
            parts.push(`Price source: ${p.priceProviderLabel}`);
            if (security.currency !== fund.baseCurrency) {
              parts.push(`FX used: ${fxToBase.toString()} (source: ${FALLBACK_FX_SOURCE})`);
            }
            return parts.join(" · ");
          })(),
          overriddenConstraints:
            check.softViolations.length > 0
              ? {
                  violations: check.softViolations.map((v) => ({
                    type: v.constraintType,
                    message: v.message,
                    currentValue: v.currentValue,
                    limit: v.limit,
                  })),
                  justification: p.softOverrideJustification?.trim(),
                  acceptedAt: executedAt.toISOString(),
                  acceptedByUserId: p.userId,
                }
              : null,
        })
        .returning({ id: transactionsTable.id });

      const insertedId = txnInsert[0].id;

      if (p.linkedThesis && typeof p.updateNote === "string") {
        const note = p.updateNote.trim();
        if (note.length > 0) {
          await tx.insert(thesisUpdates).values({
            thesisId: p.linkedThesis.id,
            authorUserId: p.userId,
            transactionId: insertedId,
            note,
          });
        }
      }

      if (p.memo) {
        await tx.insert(tradeAttachments).values({
          transactionId: insertedId,
          filename: p.memo.filename,
          storageUrl: p.memo.url,
          mimeType: "application/pdf",
          sizeBytes: p.memo.sizeBytes,
          uploadedByUserId: p.userId,
        });
      }

      if (
        p.linkedThesis &&
        p.linkedThesis.direction == null &&
        (p.side === "buy" || p.side === "short")
      ) {
        await tx
          .update(thesesTable)
          .set({
            direction: p.side === "buy" ? "long" : "short",
            updatedAt: executedAt,
          })
          .where(eq(thesesTable.id, p.linkedThesis.id));
      }

      const currentQty =
        state.positions.get(security.id)?.quantity ?? new Decimal(0);
      const newQty = currentQty.plus(signedQuantity);
      let localClosedThesisId: string | null = null;

      if (currentQty.isZero() && !newQty.isZero()) {
        await tx.insert(positionsTable).values({
          fundId: fund.id,
          securityId: security.id,
          openedAt: executedAt,
          side: newQty.gt(0) ? "long" : "short",
        });
      } else if (!currentQty.isZero() && newQty.isZero()) {
        const openPos = await tx
          .select()
          .from(positionsTable)
          .where(
            and(
              eq(positionsTable.fundId, fund.id),
              eq(positionsTable.securityId, security.id),
              isNull(positionsTable.closedAt)
            )
          )
          .orderBy(desc(positionsTable.openedAt))
          .limit(1);
        if (openPos.length > 0) {
          const liveBefore = state.positions.get(security.id);
          const realisedPnlBase = liveBefore
            ? (liveBefore.quantity.gt(0)
                ? priceNative.minus(liveBefore.avgCostNative)
                : liveBefore.avgCostNative.minus(priceNative)
              )
                .times(liveBefore.quantity.abs())
                .times(fxToBase)
                .plus(liveBefore.realisedPnlBase)
            : new Decimal(0);

          await tx
            .update(positionsTable)
            .set({
              closedAt: executedAt,
              realisedPnlBase: realisedPnlBase.toString(),
            })
            .where(eq(positionsTable.id, openPos[0].id));
        }

        if (p.linkedThesis && p.linkedThesis.status === "active") {
          await tx
            .update(thesesTable)
            .set({
              status: "closed",
              closedAt: executedAt,
              updatedAt: executedAt,
            })
            .where(eq(thesesTable.id, p.linkedThesis.id));
          localClosedThesisId = p.linkedThesis.id;
        }
      }

      return { transactionId: insertedId, closedThesisId: localClosedThesisId };
    });

    return {
      ok: true,
      transactionId: writeResult.transactionId,
      closedThesisId: writeResult.closedThesisId,
    };
  } catch (err) {
    if (err instanceof TradeHalt) {
      return { ok: false, status: err.status, payload: err.payload };
    }
    console.error("[executeTrade] transaction failed:", err);
    return {
      ok: false,
      status: 500,
      payload: { ok: false, error: "Database write failed. The trade was not recorded." },
    };
  }
}
