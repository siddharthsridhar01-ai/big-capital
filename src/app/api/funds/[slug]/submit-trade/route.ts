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
  securities as securitiesTable,
  prices as pricesTable,
  fundMembers,
  pendingOrders,
} from "@/db/schema";
import { theses as thesesTable } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { and, desc, eq, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import { type Currency } from "@/lib/portfolio";
import { resolveFxToBase } from "@/lib/fx";
import { getQuotes } from "@/lib/intraday/cache";
import { activeProvider } from "@/lib/intraday/provider";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import { checkPriceSanity } from "@/lib/price-guardrail";
import { executeTrade } from "@/lib/execute-trade";

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
  //   1. Fetch the live price from Yahoo (the active intraday provider).
  //   2. Fill ONLY if the security's market is actively trading (regular/pre/
  //      post). If it's closed — or there's no live quote — refuse the trade
  //      rather than fill at a stale close. This closes the look-ahead hole:
  //      dealing on already-public news at a price that predates it.
  //   3. Validate against expectedPriceNative (what the user saw when they
  //      clicked Review). If divergence > 1%, reject and ask user to re-review.
  //   4. Sanity-check the live price against the last stored close to catch a
  //      pence/wrong-symbol/garbage feed value before it reaches the ledger.
  const executionDate = new Date();
  let priceNative: Decimal | null = null;
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
      // Only fill during the REGULAR session, where the quote is a genuinely
      // live, actively-traded price. Pre/post are unsafe: many exchanges (e.g.
      // the LSE) have no real pre/post trading, so their "PRE"/"POST" quote is
      // just the frozen last close — filling there is the stale-price exploit.
      if (marketState === "REGULAR") {
        priceNative = new Decimal(liveQuote.price);
        priceProviderLabel = activeProvider.displayLabel;
      }
    }
  } catch (err) {
    console.error("[submit-trade] live price fetch failed:", err);
  }

  if (priceNative == null) {
    // Market is shut (or in a pre/post window we don't treat as tradeable):
    // queue the order to execute at that market's NEXT OPENING PRINT, the way a
    // broker handles a market-on-open order. The submitter cannot know the fill
    // price, so this closes the stale-price look-ahead hole while still letting
    // someone act outside their exchange's hours (important for foreign lines).
    //
    // An UNKNOWN state means we simply couldn't reach the price feed — that is a
    // transient error, NOT a closed market, and must be rejected rather than
    // queued: queuing it during an active session could later fill at an opening
    // print the submitter has already seen.
    if (marketState === "UNKNOWN") {
      return NextResponse.json(
        {
          ok: false,
          error: `Couldn't reach the price feed for ${security.ticker}. Please try again in a moment.`,
        },
        { status: 503 }
      );
    }

    const queued = await db
      .insert(pendingOrders)
      .values({
        fundId: fund.id,
        securityId: security.id,
        side: body.side,
        quantity: new Decimal(body.shares).toString(),
        submittedByUserId: user.id,
        rationale: body.rationale,
        thesisId: linkedThesis ? linkedThesis.id : null,
        updateNote: body.updateNote ?? null,
        softOverrideJustification: body.softOverrideJustification ?? null,
        status: "pending",
      })
      .returning({ id: pendingOrders.id });

    return NextResponse.json({
      ok: true,
      queued: true,
      pendingOrderId: queued[0].id,
      marketState,
      message: `${security.ticker}'s market is closed. Your order is queued and will execute at the next opening price. You can cancel it any time before that market opens.`,
      redirectTo: `/dashboard/funds/${slug}`,
    });
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
      refRows.length > 0 ? new Decimal(refRows[0].close) : null;
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

  // ----- Execute via the shared, lock-protected path -----
  const result = await executeTrade({
    fund: {
      id: fund.id,
      baseCurrency: fund.baseCurrency,
      tradingFeesBps: fund.tradingFeesBps,
    },
    security: {
      id: security.id,
      ticker: security.ticker,
      currency: security.currency,
      gicsSector: security.gicsSector,
    },
    side: body.side,
    shares: body.shares,
    priceNative,
    fxToBase,
    userId: user.id,
    executedAt: executionDate,
    rationale: body.rationale,
    priceProviderLabel,
    linkedThesis,
    updateNote: body.updateNote,
    softOverrideJustification: body.softOverrideJustification,
    memo: body.memo,
  });

  if (!result.ok) {
    return NextResponse.json(result.payload, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    transactionId: result.transactionId,
    redirectTo: result.closedThesisId
      ? `/dashboard/funds/${slug}/theses/${result.closedThesisId}?prompt=postmortem`
      : `/dashboard/funds/${slug}`,
  });
}
