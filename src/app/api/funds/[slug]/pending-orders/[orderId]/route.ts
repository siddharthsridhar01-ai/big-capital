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

  // ---- Market must still be shut to cancel ----
  const secRows = await db
    .select()
    .from(securitiesTable)
    .where(eq(securitiesTable.id, order.securityId))
    .limit(1);
  if (secRows.length > 0) {
    const security = secRows[0];
    try {
      const quotes = await getQuotes(activeProvider, [
        { securityId: security.id, symbol: toYahooSymbol(security.ticker, security.exchange) },
      ]);
      if (quotes[0]?.quote?.marketState === "REGULAR") {
        return NextResponse.json(
          {
            ok: false,
            error: `${security.ticker}'s market has opened, so this order is committed and will fill at today's opening price. Orders can only be cancelled while their market is closed.`,
          },
          { status: 409 }
        );
      }
    } catch {
      // Price feed unreachable — refuse the cancel rather than risk allowing one
      // after the open. Failing closed is the safe direction here.
      return NextResponse.json(
        {
          ok: false,
          error:
            "Couldn't confirm whether this market is open, so the cancel was not applied. Please try again shortly.",
        },
        { status: 503 }
      );
    }
  }

  await db
    .update(pendingOrders)
    .set({
      status: "cancelled",
      resolvedAt: new Date(),
      rejectionReason: `Cancelled by ${user.fullName ?? user.email} before the market opened`,
    })
    .where(and(eq(pendingOrders.id, orderId), eq(pendingOrders.status, "pending")));

  return NextResponse.json({ ok: true, cancelled: orderId });
}
