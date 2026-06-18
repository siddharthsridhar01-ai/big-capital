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
import { getOrCreateUser } from "@/lib/auth";
import { and, desc, eq, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  checkTrade,
  type FundConstraint,
  type ProposedTrade,
  type PortfolioContext,
} from "@/lib/constraints";
import {
  computePortfolioState,
  staticFxFallback,
  FALLBACK_FX_SOURCE,
  type Currency,
} from "@/lib/portfolio";
import { getQuotes } from "@/lib/intraday/cache";
import { activeProvider } from "@/lib/intraday/provider";
import { toYahooSymbol } from "@/lib/intraday/yahoo";

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

  try {
    const yahooSym = toYahooSymbol(security.ticker, security.exchange);
    const quotes = await getQuotes(activeProvider, [
      { securityId: security.id, symbol: yahooSym },
    ]);
    const liveQuote = quotes[0]?.quote;
    if (liveQuote?.price != null) {
      priceNative = new Decimal(liveQuote.price);
      priceSource = "live";
      priceProviderLabel = activeProvider.displayLabel;
    }
  } catch (err) {
    console.error("[submit-trade] live price fetch failed:", err);
    // Fall through to DB
  }

  if (priceNative == null) {
    const priceRows = await db
      .select()
      .from(pricesTable)
      .where(eq(pricesTable.securityId, security.id))
      .orderBy(desc(pricesTable.date))
      .limit(1);
    if (priceRows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No price available for this security" },
        { status: 400 }
      );
    }
    priceNative = new Decimal(priceRows[0].closePrice);
    priceSource = "db_fallback";
    priceProviderLabel = `DB close ${priceRows[0].date}`;
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

  // ----- Compute fresh portfolio state -----
  const state = await computePortfolioState(fund.id);

  // ----- Build the constraint context from real state -----
  const investableUniverseRows = await db
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

  // Security metadata map for the constraint engine. Must include this trade's
  // security AND every currently-held security (so sector aggregation works).
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

  // FX rates map (security ccy → base ccy) — for v1 use static fallback when needed
  const fxToBase =
    security.currency === fund.baseCurrency
      ? new Decimal(1)
      : staticFxFallback(
          security.currency as Currency,
          fund.baseCurrency as Currency
        );
  const fxRates = new Map<string, string>();
  const dateStr = executionDate.toISOString().slice(0, 10);
  fxRates.set(
    `${security.currency}/${fund.baseCurrency}/${dateStr}`,
    fxToBase.toString()
  );

  // Positions map in engine format (signed qty, native currency + avg cost)
  const enginePositions = new Map();
  for (const [id, p] of state.positions) {
    enginePositions.set(id, {
      securityId: id,
      quantity: p.quantity,
      avgCostNative: p.avgCostNative,
      currency: p.currency,
    });
  }

  // Cash map: base currency only matters here for v1
  const cashByCurrency = new Map();
  for (const [ccy, amt] of state.cashByCurrency) {
    cashByCurrency.set(ccy, amt);
  }

  // Load active constraints (dedup by type to be defensive)
  const allConstraints = await db
    .select()
    .from(fundConstraintsTable)
    .where(
      and(
        eq(fundConstraintsTable.fundId, fund.id),
        eq(fundConstraintsTable.isActive, true)
      )
    );
  const dedupedConstraintsMap = new Map<string, typeof allConstraints[number]>();
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

  // Build the trade
  const trade: ProposedTrade = {
    securityId: security.id,
    side: body.side,
    quantity: new Decimal(body.shares),
    price: priceNative,
    currency: security.currency as Currency,
  };

  // Prices map for post-trade NAV
  const pricesPostTrade = new Map<string, Decimal>([
    [security.id, priceNative],
  ]);
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

  // ----- Run constraint check authoritatively -----
  let check;
  try {
    check = checkTrade(constraints, trade, ctx, pricesPostTrade);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Constraint check failed unexpectedly",
      },
      { status: 500 }
    );
  }

  // Hard violations → trade cannot proceed
  if (check.hardViolations.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "Trade rejected by hard constraints",
        hardViolations: check.hardViolations.map((v) => ({
          constraintType: v.constraintType,
          message: v.message,
        })),
      },
      { status: 400 }
    );
  }

  // Soft violations → require justification
  if (check.softViolations.length > 0) {
    const just = (body.softOverrideJustification ?? "").trim();
    if (just.length < 20) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Soft constraint breaches require a written justification of at least 20 characters",
          softViolations: check.softViolations.map((v) => ({
            constraintType: v.constraintType,
            message: v.message,
          })),
        },
        { status: 400 }
      );
    }
  }

  // ----- Quantity sign convention for the transaction row -----
  // buy/cover: positive; sell/short: negative
  const signedQuantity =
    body.side === "buy" || body.side === "cover"
      ? new Decimal(body.shares)
      : new Decimal(body.shares).negated();

  // Notional and fee in security's native currency (cash impact in native)
  const notionalNative = new Decimal(body.shares).times(priceNative);
  const feeBase = notionalNative
    .times(fxToBase)
    .times(fund.tradingFeesBps)
    .dividedBy(10000);
  const feeNative = feeBase.dividedBy(fxToBase);

  // Cash impact native: outflow on buy/cover (negative), inflow on sell/short (positive)
  const isOutflow = body.side === "buy" || body.side === "cover";
  const cashImpactNative = isOutflow
    ? notionalNative.plus(feeNative).negated()
    : notionalNative.minus(feeNative);

  // ----- Write everything in a single transaction -----
  // Drizzle's postgres-js driver supports db.transaction() but the wrapping
  // helper isn't typed identically across versions. We do it via plain
  // sequential awaits since for a single-user write the durability is the
  // same. If this becomes multi-PM with race conditions, wrap in tx.
  // (Phase 4 hardening territory.)

  let newTransactionId: string;
  let closedThesisId: string | null = null;
  try {
    // 1) Insert the transaction row
    const txnInsert = await db
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
                justification: body.softOverrideJustification?.trim(),
                acceptedAt: executionDate.toISOString(),
                acceptedByUserId: user.id,
              }
            : null,
      })
      .returning({ id: transactionsTable.id });

    newTransactionId = txnInsert[0].id;

    // 2) Save PDF attachment if uploaded
    if (body.memo) {
      await db.insert(tradeAttachments).values({
        transactionId: newTransactionId,
        filename: body.memo.filename,
        storageUrl: body.memo.url,
        mimeType: "application/pdf",
        sizeBytes: body.memo.sizeBytes,
        uploadedByUserId: user.id,
      });
    }

    // 2b) If this trade links to a thesis whose direction hasn't been set
    // yet, stamp it from the opening side. The first BUY makes the thesis
    // long; the first SHORT makes it short. SELL/COVER never set direction
    // (you can't open a position by reducing one), so a thesis that somehow
    // only ever sees a sell/cover stays null — which is the correct signal
    // that it was never properly opened.
    if (
      linkedThesis &&
      linkedThesis.direction == null &&
      (body.side === "buy" || body.side === "short")
    ) {
      await db
        .update(thesesTable)
        .set({
          direction: body.side === "buy" ? "long" : "short",
          updatedAt: executionDate,
        })
        .where(eq(thesesTable.id, linkedThesis.id));
    }

    // 3) Update positions lifecycle table
    // If opening a new position (no current holding in this security), insert a row.
    // If closing (post-trade quantity = 0), mark closedAt.
    const currentQty = state.positions.get(security.id)?.quantity ?? new Decimal(0);
    const newQty = currentQty.plus(signedQuantity);

    if (currentQty.isZero() && !newQty.isZero()) {
      // Opening
      await db.insert(positionsTable).values({
        fundId: fund.id,
        securityId: security.id,
        openedAt: executionDate,
        side: newQty.gt(0) ? "long" : "short",
      });
    } else if (!currentQty.isZero() && newQty.isZero()) {
      // Closing — find the open position row and mark it closed
      const openPos = await db
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
        // Compute realised P&L
        const liveBefore = state.positions.get(security.id);
        const realisedPnlBase = liveBefore
          ? // (close_price − avg_cost) × |qty| × fx for long
            // (avg_cost − close_price) × |qty| × fx for short
            (liveBefore.quantity.gt(0)
              ? priceNative.minus(liveBefore.avgCostNative)
              : liveBefore.avgCostNative.minus(priceNative)
            )
              .times(liveBefore.quantity.abs())
              .times(fxToBase)
              .plus(liveBefore.realisedPnlBase)
          : new Decimal(0);

        await db
          .update(positionsTable)
          .set({
            closedAt: executionDate,
            realisedPnlBase: realisedPnlBase.toString(),
          })
          .where(eq(positionsTable.id, openPos[0].id));
      }

      // Phase 2c.3: a full close retires the linked thesis. Move an active
      // thesis to "closed" (awaiting post-mortem) and capture its id so we
      // can redirect the PM straight to the post-mortem prompt.
      if (linkedThesis && linkedThesis.status === "active") {
        await db
          .update(thesesTable)
          .set({
            status: "closed",
            closedAt: executionDate,
            updatedAt: executionDate,
          })
          .where(eq(thesesTable.id, linkedThesis.id));
        closedThesisId = linkedThesis.id;
      }
    }
  } catch (err) {
    console.error("[submit-trade] write failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Database write failed. The trade was not recorded.",
      },
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
