/**
 * Submit-trade endpoint.
 *
 * POST /api/funds/[slug]/submit-trade
 *
 * The authoritative write path for trades. Validates the trade, re-runs the
 * constraint engine against fresh portfolio state, and (if everything passes)
 * writes the transaction, position lifecycle row, and PDF attachment in a
 * single Postgres transaction.
 *
 * Body shape:
 *   {
 *     securityId: string,
 *     side: "buy" | "sell" | "short" | "cover",
 *     shares: number,            // integer, ≥ 1
 *     rationale: string,         // ≥ 50 chars
 *     memo?: {                   // optional PDF upload result
 *       url: string,
 *       filename: string,
 *       sizeBytes: number,
 *     },
 *     softOverrideJustification?: string,  // ≥ 20 chars if soft breaches
 *     thesisId?: string | null,  // Phase 2c — link this trade to a thesis
 *   }
 *
 * Response on success:
 *   { ok: true, transactionId: string, redirectTo: string }
 *
 * Response on failure:
 *   { ok: false, error: string, hardViolations?, softViolations? }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  funds as fundsTable,
  fundConstraints as fundConstraintsTable,
  securities as securitiesTable,
  prices as pricesTable,
  transactions as transactionsTable,
  positions as positionsTable,
  tradeAttachments,
  investableUniverses,
  fundMembers,
} from "@/db/schema";
import { theses as thesesTable } from "@/db/schema-theses";
import { thesisUpdates } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
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
import { resolveFxToBase } from "@/lib/fx";
import { getQuotes } from "@/lib/intraday/cache";
import { activeProvider } from "@/lib/intraday/provider";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import { checkPriceSanity } from "@/lib/price-guardrail";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface SubmitTradeBody {
  securityId: string;
  side: "buy" | "sell" | "short" | "cover";
  shares: number;
  rationale: string;
  expectedPriceNative?: string | null;
  memo?: { url: string; filename: string; sizeBytes: number };
  softOverrideJustification?: string;
  thesisId?: string | null;
  updateNote?: string;
}

// Thrown inside the trade transaction to reject cleanly (rolls back any writes)
// while carrying the exact HTTP response the client should receive. Lets the
// constraint checks live inside the locked transaction yet still return a
// professional, specific rejection rather than a generic 500.
class TradeHalt extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: Record<string, unknown>
  ) {
    super("trade-halt");
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { slug } = await params;

  // Parse and shape-validate body
  let body: SubmitTradeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  // ----- Basic validation -----
  if (
    !body.securityId ||
    !["buy", "sell", "short", "cover"].includes(body.side) ||
    typeof body.shares !== "number" ||
    !Number.isInteger(body.shares) ||
    body.shares < 1 ||
    typeof body.rationale !== "string" ||
    body.rationale.length < 50
  ) {
    return NextResponse.json(
      { ok: false, error: "Invalid trade parameters" },
      { status: 400 }
    );
  }

  // ----- Resolve fund -----
  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Fund not found" },
      { status: 404 }
    );
  }
  const fund = fundRows[0];

  // ----- Permission check: PM/admin only -----
  if (user.role !== "admin" && user.role !== "pm") {
    return NextResponse.json(
      { ok: false, error: "Only PMs and admins can submit trades" },
      { status: 403 }
    );
  }
  if (user.role !== "admin") {
    // Must be a member of this fund
    const membership = await db
      .select()
      .from(fundMembers)
      .where(
        and(
          eq(fundMembers.fundId, fund.id),
          eq(fundMembers.userId, user.id),
          isNull(fundMembers.endDate)
        )
      )
      .limit(1);
    if (membership.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Not a member of this fund" },
        { status: 403 }
      );
    }
  }

  // ----- Resolve security + price -----
  const secRows = await db
    .select()
    .from(securitiesTable)
    .where(eq(securitiesTable.id, body.securityId))
    .limit(1);
  if (secRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Security not found" },
      { status: 404 }
    );
  }
  const security = secRows[0];

  // ----- Resolve + validate linked thesis (Phase 2c) -----
  // A trade may link to a thesis. If a thesisId is supplied we verify it
  // exists, belongs to THIS fund, and is for the security being traded.
  // The link is optional (legacy positions opened before theses existed,
  // and reductions/closes on such positions, carry thesis_id = NULL).
  let linkedThesis:
    | { id: string; direction: string | null; status: string }
    | null = null;
  if (body.thesisId != null && body.thesisId !== "") {
    if (typeof body.thesisId !== "string") {
      return NextResponse.json(
        { ok: false, error: "Invalid thesisId" },
        { status: 400 }
      );
    }
    const thesisRows = await db
      .select({
        id: thesesTable.id,
        fundId: thesesTable.fundId,
        securityId: thesesTable.securityId,
        direction: thesesTable.direction,
        status: thesesTable.status,
        approvalStatus: thesesTable.approvalStatus,
      })
      .from(thesesTable)
      .where(eq(thesesTable.id, body.thesisId))
      .limit(1);
    if (thesisRows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Linked thesis not found" },
        { status: 404 }
      );
    }
    const t = thesisRows[0];
    if (t.fundId !== fund.id) {
      return NextResponse.json(
        { ok: false, error: "Thesis belongs to a different fund" },
        { status: 400 }
      );
    }
    if (t.approvalStatus !== "approved") {
      return NextResponse.json(
        { ok: false, error: "That thesis is still pending approval — a PM must approve it before trading on it" },
        { status: 400 }
      );
    }
    if (t.securityId !== security.id) {
      return NextResponse.json(
        {
          ok: false,
          error: "Thesis is for a different security than this trade",
        },
        { status: 400 }
      );
    }
    linkedThesis = { id: t.id, direction: t.direction, status: t.status };
  }

  // ----- Determine execution price -----
  // Strategy:
  //   1. Fetch live price from Yahoo (the active intraday provider).
  //   2. If live is available, use it as the authoritative execution price.
  //   3. Validate against expectedPriceNative (what the user saw when they
  //      clicked Review). If divergence > 1%, reject and ask user to re-review.
  //   4. If live is unavailable, fall back to last DB close price (and let the
  //      user know via the audit notes).
  const executionDate = new Date();
  let priceNative: Decimal | null = null;
  let priceSource: "live" | "db_fallback" = "db_fallback";
  let priceProviderLabel = "DB";
  let marketState: string = "UNKNOWN";

  try {
    const yahooSym = toYahooSymbol(security.ticker, security.exchange);
    const quotes = await getQuotes(activeProvider, [
      { securityId: security.id, symbol: yahooSym },
    ]);
    const liveQuote = quotes[0]?.quote;
    if (liveQuote?.price != null) {
      marketState = liveQuote.marketState;
      // Only fill against an ACTIVE market (regular/pre/post). A CLOSED or
      // unknown state means the "live" price is really a stale close — filling
      // there would let someone trade on public news (e.g. after-hours
      // earnings) at a pre-news price. See the reject below.
      if (marketState === "REGULAR" || marketState === "PRE" || marketState === "POST") {
        priceNative = new Decimal(liveQuote.price);
        priceSource = "live";
        priceProviderLabel = activeProvider.displayLabel;
      }
    }
  } catch (err) {
    console.error("[submit-trade] live price fetch failed:", err);
  }

  if (priceNative == null) {
    // Refuse rather than fill at a stale close. This closes the look-ahead
    // exploit: trading on already-public information at a price that predates it.
    return NextResponse.json(
      {
        ok: false,
        error:
          marketState === "CLOSED"
            ? `${security.ticker}'s market is closed right now. Trades fill against a live price while the market is open — this prevents dealing on overnight news at a stale price.`
            : `Couldn't get a live price for ${security.ticker}. Trades execute against a live quote during market hours — please try again shortly.`,
      },
      { status: 409 }
    );
  }

  // ----- Price reasonability check vs expected -----
  if (body.expectedPriceNative) {
    try {
      const expected = new Decimal(body.expectedPriceNative);
      if (!expected.isZero()) {
        const drift = priceNative.minus(expected).abs().dividedBy(expected);
        if (drift.gt(0.01)) {
          // > 1% divergence → market moved while user was deciding
          return NextResponse.json(
            {
              ok: false,
              error: `Price has moved more than 1% since you reviewed (you saw ${expected.toFixed(2)}, market is now ${priceNative.toFixed(2)}). Please re-review the trade.`,
              priceMoved: true,
              expectedPrice: expected.toFixed(4),
              currentPrice: priceNative.toFixed(4),
            },
            { status: 409 } // 409 Conflict — request was valid, but state has changed
          );
        }
      }
    } catch {
      // Bad expectedPriceNative — ignore the check rather than fail the trade
    }
  }

  // ----- Independent price-sanity guardrail (protects the immutable ledger) -----
  // Compare the execution price to the last stored EOD close — a reference from
  // a separate feed than the live quote. A pence/unit error, wrong-symbol quote,
  // or garbage value shows up as an implausible ratio and is blocked here,
  // before it can be written as an un-editable trade. This is orthogonal to the
  // "vs expected" check above (which only compares to what the user saw, and so
  // can't catch an error that's in the feed itself).
  {
    const refRows = await db
      .select({ close: pricesTable.closePrice, date: pricesTable.date })
      .from(pricesTable)
      .where(eq(pricesTable.securityId, security.id))
      .orderBy(desc(pricesTable.date))
      .limit(1);
    const reference =
      refRows.length > 0 && priceSource === "live" ? new Decimal(refRows[0].close) : null;
    const sanity = checkPriceSanity(priceNative, reference);
    if (!sanity.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `Price safety check failed: ${priceNative.toFixed(4)} ${security.currency} is implausible versus the last close${
            refRows.length > 0 ? ` (${new Decimal(refRows[0].close).toFixed(4)} on ${refRows[0].date})` : ""
          }. ${sanity.reason ?? ""} Trade blocked — verify the price and symbol before retrying.`,
          priceSanity: sanity,
        },
        { status: 422 }
      );
    }
  }

  // ----- Compute fresh portfolio state -----
  // FX (security ccy -> base ccy). Uses the stored daily ECB rate (accurate,
  // important for volatile non-major currencies), falling back to the static
  // table only if no daily rate exists. State-independent, so computed before
  // the lock and reused inside it.
  const fxToBase =
    security.currency === fund.baseCurrency
      ? new Decimal(1)
      : await resolveFxToBase(
          security.currency as Currency,
          fund.baseCurrency as Currency,
          new Date().toISOString().slice(0, 10)
        );

  // ----- Atomic check-and-write under a per-fund advisory lock -----
  // Serialises trades WITHIN a fund so two concurrent orders can't both pass a
  // cash/limit check against the same "before" state and then both commit,
  // over-committing cash or breaching a concentration limit. Different funds do
  // NOT block each other (the lock key is the fund id). All network work
  // (price, FX) already happened above, so the lock only ever wraps DB reads +
  // the pure constraint engine + the inserts, and is held only briefly.
  let newTransactionId: string;
  let closedThesisId: string | null = null;
  try {
    const writeResult = await db.transaction(async (tx) => {
      // Per-fund lock; auto-released when this transaction commits or rolls back.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${fund.id}))`);

      // Re-read authoritative state INSIDE the lock. skipLivePrices avoids a
      // network call while the lock is held; the trade itself is valued at the
      // live price already fetched (and sanity-checked) above.
      const state = await computePortfolioState(fund.id, undefined, {
        skipLivePrices: true,
      });

      // ----- Build the constraint context from fresh state -----
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
      const dateStr = executionDate.toISOString().slice(0, 10);
      fxRates.set(
        `${security.currency}/${fund.baseCurrency}/${dateStr}`,
        fxToBase.toString()
      );

      const enginePositions = new Map();
      for (const [id, p] of state.positions) {
        enginePositions.set(id, {
          securityId: id,
          quantity: p.quantity,
          avgCostNative: p.avgCostNative,
          currency: p.currency,
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
        side: body.side,
        quantity: new Decimal(body.shares),
        price: priceNative,
        currency: security.currency as Currency,
      };

      const pricesPostTrade = new Map<string, Decimal>([[security.id, priceNative]]);
      for (const [id, p] of state.positions) {
        if (p.latestPriceNative) {
          pricesPostTrade.set(id, p.latestPriceNative);
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

      // ----- Run constraint check authoritatively (fresh, lock-protected) -----
      let check;
      try {
        check = checkTrade(constraints, trade, ctx, pricesPostTrade);
      } catch (err) {
        throw new TradeHalt(500, {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "Constraint check failed unexpectedly",
        });
      }

      // Hard violations -> trade cannot proceed. If this fires now but not on
      // the client's pre-check, a concurrent trade in this fund changed the
      // state — a clean, specific rejection, not a silent breach.
      if (check.hardViolations.length > 0) {
        throw new TradeHalt(409, {
          ok: false,
          error:
            "Trade rejected: it breaches a hard constraint against the fund's current state. Another trade in this fund may have just executed — please re-review.",
          hardViolations: check.hardViolations.map((v) => ({
            constraintType: v.constraintType,
            message: v.message,
          })),
        });
      }

      // Soft violations -> require justification
      if (check.softViolations.length > 0) {
        const just = (body.softOverrideJustification ?? "").trim();
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

      // ----- Quantity sign convention -----
      const signedQuantity =
        body.side === "buy" || body.side === "cover"
          ? new Decimal(body.shares)
          : new Decimal(body.shares).negated();

      const notionalNative = new Decimal(body.shares).times(priceNative);
      const feeBase = notionalNative
        .times(fxToBase)
        .times(fund.tradingFeesBps)
        .dividedBy(10000);
      const feeNative = feeBase.dividedBy(fxToBase);

      const isOutflow = body.side === "buy" || body.side === "cover";
      const cashImpactNative = isOutflow
        ? notionalNative.plus(feeNative).negated()
        : notionalNative.minus(feeNative);

      // 1) Insert the transaction row
      const txnInsert = await tx
        .insert(transactionsTable)
        .values({
          fundId: fund.id,
          securityId: security.id,
          transactionType: body.side,
          quantity: signedQuantity.toString(),
          price: priceNative.toString(),
          currency: security.currency as Currency,
          cashImpact: cashImpactNative.toString(),
          fxRateToBase: fxToBase.toString(),
          executedAt: executionDate,
          submittedAt: executionDate,
          executedByUserId: user.id,
          feeAmount: feeBase.toString(),
          rationale: body.rationale,
          memoId: null,
          thesisId: linkedThesis ? linkedThesis.id : null,
          notes: (() => {
            const parts: string[] = [];
            parts.push(`Price source: ${priceProviderLabel}`);
            if (security.currency !== fund.baseCurrency) {
              parts.push(
                `FX used: ${fxToBase.toString()} (source: ${FALLBACK_FX_SOURCE})`
              );
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
                  justification: body.softOverrideJustification?.trim(),
                  acceptedAt: executionDate.toISOString(),
                  acceptedByUserId: user.id,
                }
              : null,
        })
        .returning({ id: transactionsTable.id });

      const insertedId = txnInsert[0].id;

      // 2a) Thesis update note tied to this transaction
      if (linkedThesis && typeof body.updateNote === "string") {
        const note = body.updateNote.trim();
        if (note.length > 0) {
          await tx.insert(thesisUpdates).values({
            thesisId: linkedThesis.id,
            authorUserId: user.id,
            transactionId: insertedId,
            note,
          });
        }
      }

      // 2) Save PDF attachment if uploaded
      if (body.memo) {
        await tx.insert(tradeAttachments).values({
          transactionId: insertedId,
          filename: body.memo.filename,
          storageUrl: body.memo.url,
          mimeType: "application/pdf",
          sizeBytes: body.memo.sizeBytes,
          uploadedByUserId: user.id,
        });
      }

      // 2b) Stamp thesis direction from the opening side if unset
      if (
        linkedThesis &&
        linkedThesis.direction == null &&
        (body.side === "buy" || body.side === "short")
      ) {
        await tx
          .update(thesesTable)
          .set({
            direction: body.side === "buy" ? "long" : "short",
            updatedAt: executionDate,
          })
          .where(eq(thesesTable.id, linkedThesis.id));
      }

      // 3) Update positions lifecycle table
      const currentQty =
        state.positions.get(security.id)?.quantity ?? new Decimal(0);
      const newQty = currentQty.plus(signedQuantity);
      let localClosedThesisId: string | null = null;

      if (currentQty.isZero() && !newQty.isZero()) {
        await tx.insert(positionsTable).values({
          fundId: fund.id,
          securityId: security.id,
          openedAt: executionDate,
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
              closedAt: executionDate,
              realisedPnlBase: realisedPnlBase.toString(),
            })
            .where(eq(positionsTable.id, openPos[0].id));
        }

        if (linkedThesis && linkedThesis.status === "active") {
          await tx
            .update(thesesTable)
            .set({
              status: "closed",
              closedAt: executionDate,
              updatedAt: executionDate,
            })
            .where(eq(thesesTable.id, linkedThesis.id));
          localClosedThesisId = linkedThesis.id;
        }
      }

      return { transactionId: insertedId, closedThesisId: localClosedThesisId };
    });

    newTransactionId = writeResult.transactionId;
    closedThesisId = writeResult.closedThesisId;
  } catch (err) {
    if (err instanceof TradeHalt) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("[submit-trade] transaction failed:", err);
    return NextResponse.json(
      { ok: false, error: "Database write failed. The trade was not recorded." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    transactionId: newTransactionId,
    redirectTo: closedThesisId
      ? `/dashboard/funds/${slug}/theses/${closedThesisId}?prompt=postmortem`
      : `/dashboard/funds/${slug}`,
  });
}
