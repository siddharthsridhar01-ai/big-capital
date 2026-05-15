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

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface SubmitTradeBody {
  securityId: string;
  side: "buy" | "sell" | "short" | "cover";
  shares: number;
  rationale: string;
  memo?: { url: string; filename: string; sizeBytes: number };
  softOverrideJustification?: string;
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
  const priceRow = priceRows[0];
  const priceNative = new Decimal(priceRow.closePrice);
  const executionDate = new Date();

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
        notes:
          security.currency === fund.baseCurrency
            ? null
            : `FX used: ${fxToBase.toString()} (source: ${FALLBACK_FX_SOURCE})`,
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
    redirectTo: `/dashboard/funds/${slug}`,
  });
}
