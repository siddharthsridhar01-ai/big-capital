/**
 * Cancel a queued market-on-open order.
 *
 *   DELETE /api/funds/[slug]/pending-orders/[orderId]
 *
 * Permission: admin, or a current member of this fund.
 *
 * INTEGRITY RULE — cancellation is only allowed while the security's market is
 * still shut. Once the session has opened, the opening print exists and the
 * order is committed. Allowing a cancel after the open would hand the submitter
 * a free option: watch the open, keep the fill if it moved their way, cancel it
 * if it didn't. That would be a worse exploit than the one queuing solves.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  funds as fundsTable,
  fundMembers,
  pendingOrders,
  securities as securitiesTable,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import { getQuotes } from "@/lib/intraday/cache";
import { activeProvider } from "@/lib/intraday/provider";
import YahooFinance from "yahoo-finance2";
import { orderMayFillAtOpen } from "@/lib/basket";

const yf = new YahooFinance();


export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; orderId: string }> }
) {
  const { slug, orderId } = await ctx.params;

  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }

  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  }
  const fund = fundRows[0];

  if (user.role !== "admin") {
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
        { ok: false, error: "You are not a member of this fund" },
        { status: 403 }
      );
    }
    // Cancelling a queued order changes what the fund will own, so it belongs
    // with the PM for the same reason submitting one does.
    if (membership[0].roleInFund !== "pm") {
      return NextResponse.json(
        { ok: false, error: "Only the fund's Portfolio Manager can cancel orders." },
        { status: 403 }
      );
    }
  }

  const orderRows = await db
    .select()
    .from(pendingOrders)
    .where(and(eq(pendingOrders.id, orderId), eq(pendingOrders.fundId, fund.id)))
    .limit(1);
  if (orderRows.length === 0) {
    return NextResponse.json({ ok: false, error: "Order not found" }, { status: 404 });
  }
  const order = orderRows[0];

  if (order.status !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        error: `This order is already ${order.status} and can no longer be cancelled.`,
      },
      { status: 409 }
    );
  }

  // ---- Is the order committed? ----
  // Committed only if its market is open AND it will fill at THIS session's open
  // — placed before the session began. Cancelling then hands the PM a free
  // option: watch the open, cancel if it moved the wrong way.
  //
  // An order placed after today's open fills at the NEXT session, at a price
  // nobody knows yet, so cancelling it is safe. The old rule blocked every
  // cancel while the market was open, which left such orders uncancellable all
  // day.
  //
  // Admins may cancel at any time, to clear an order that is stuck; it is
  // recorded as an admin cancellation.
  const isAdmin = user.role === "admin";
  let committedReason: string | null = null;
  const secRows = await db
    .select()
    .from(securitiesTable)
    .where(eq(securitiesTable.id, order.securityId))
    .limit(1);
  if (secRows.length > 0 && !isAdmin) {
    const security = secRows[0];
    const sym = toYahooSymbol(security.ticker, security.exchange);
    try {
      const quotes = await getQuotes(activeProvider, [{ securityId: security.id, symbol: sym }]);
      if (quotes[0]?.quote?.marketState === "REGULAR") {
        const chart = await yf.chart(sym, {
          period1: new Date(Date.now() - 5 * 86400000),
          period2: new Date(Date.now() + 86400000),
          interval: "1d",
        });
        const sessionStart = chart.meta?.currentTradingPeriod?.regular?.start;
        const todayUtc = new Date().toISOString().slice(0, 10);
        if (orderMayFillAtOpen(new Date(order.submittedAt), sessionStart, todayUtc)) {
          committedReason = `${security.ticker}'s market has opened and this order fills at today's opening price, so it is committed. Orders placed after the open, or before their market opens, can be cancelled.`;
        }
      }
    } catch {
      // Feed unreachable: refuse rather than risk a cancel after the open.
      return NextResponse.json(
        { ok: false, error: "Couldn't confirm whether this order is committed, so it was not cancelled. Please try again shortly." },
        { status: 503 }
      );
    }
  }
  if (committedReason) {
    return NextResponse.json({ ok: false, error: committedReason }, { status: 409 });
  }

  await db
    .update(pendingOrders)
    .set({
      status: "cancelled",
      resolvedAt: new Date(),
      rejectionReason: isAdmin
        ? `Cancelled by admin ${user.fullName ?? user.email}`
        : `Cancelled by ${user.fullName ?? user.email} before it was committed`,
    })
    .where(and(eq(pendingOrders.id, orderId), eq(pendingOrders.status, "pending")));

  return NextResponse.json({ ok: true, cancelled: orderId });
}
