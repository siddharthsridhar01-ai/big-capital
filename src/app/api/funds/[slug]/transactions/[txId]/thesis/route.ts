/**
 * PATCH /api/funds/[slug]/transactions/[txId]/thesis
 * Body: { thesisId: string | null }
 *
 * Links (or unlinks) an existing trade to a thesis after the fact — e.g. from
 * the portfolio activity feed. This is metadata only: it sets
 * transactions.thesis_id. It does NOT alter quantity, price, cash impact, or
 * anything the ledger/NAV depends on, so it can't affect valuations.
 *
 * Auth: pm/admin who is an active member of the fund (admins exempt from the
 * membership check). The thesis must belong to the same fund and the same
 * security as the trade.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds, transactions, fundMembers } from "@/db/schema";
import { theses } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; txId: string }> }
) {
  const { slug, txId } = await params;
  const user = await getOrCreateUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (user.role !== "admin" && user.role !== "pm") {
    return NextResponse.json({ ok: false, error: "PM or admin role required" }, { status: 403 });
  }

  const fundRows = await db.select().from(funds).where(eq(funds.slug, slug)).limit(1);
  if (fundRows.length === 0) return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  const fund = fundRows[0];

  if (user.role !== "admin") {
    const mem = await db
      .select({ userId: fundMembers.userId })
      .from(fundMembers)
      .where(and(eq(fundMembers.fundId, fund.id), eq(fundMembers.userId, user.id), isNull(fundMembers.endDate)))
      .limit(1);
    if (mem.length === 0) {
      return NextResponse.json({ ok: false, error: "You are not a member of this fund" }, { status: 403 });
    }
  }

  let body: { thesisId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const thesisId = body.thesisId ?? null;

  const txRows = await db
    .select({ id: transactions.id, securityId: transactions.securityId })
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.fundId, fund.id)))
    .limit(1);
  if (txRows.length === 0) return NextResponse.json({ ok: false, error: "Trade not found" }, { status: 404 });
  const tx = txRows[0];

  if (thesisId) {
    const thRows = await db
      .select({ id: theses.id, securityId: theses.securityId })
      .from(theses)
      .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
      .limit(1);
    if (thRows.length === 0) {
      return NextResponse.json({ ok: false, error: "Thesis not found in this fund" }, { status: 400 });
    }
    if (thRows[0].securityId !== tx.securityId) {
      return NextResponse.json({ ok: false, error: "That thesis is for a different security" }, { status: 400 });
    }
  }

  await db.update(transactions).set({ thesisId }).where(eq(transactions.id, txId));
  return NextResponse.json({ ok: true, thesisId });
}
