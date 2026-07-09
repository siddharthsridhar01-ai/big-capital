/**
 * PATCH /api/funds/[slug]/transactions/[txnId]
 *
 * Edit the SOFT metadata on a trade only: the rationale text and the attached
 * PDF. It deliberately does NOT touch the hard facts of the trade — quantity,
 * price, side, date, cash impact — because those are the immutable record of
 * what actually happened. A genuine error in those is corrected with a new
 * counter-trade, never by rewriting history. So this can't affect the ledger
 * or NAV.
 *
 * Auth: the fund admin, or an active member of the fund.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, transactions, fundMembers } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; txnId: string }> }
) {
  const { slug, txnId } = await params;
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
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

  const txRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, txnId), eq(transactions.fundId, fund.id)))
    .limit(1);
  if (txRows.length === 0) return NextResponse.json({ ok: false, error: "Trade not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid form data" }, { status: 400 });
  }

  const rationaleRaw = form.get("rationale");
  if (typeof rationaleRaw !== "string") {
    return NextResponse.json({ ok: false, error: "Rationale is required" }, { status: 400 });
  }
  const rationale = rationaleRaw.trim();
  if (rationale.length < 20) {
    return NextResponse.json(
      { ok: false, error: `Rationale must be at least 20 characters (got ${rationale.length})` },
      { status: 400 }
    );
  }

  // Update ONLY the rationale. Quantity/price/side/date are never modified, and
  // trades cannot carry PDF attachments — those belong to theses only.
  await db.update(transactions).set({ rationale }).where(eq(transactions.id, txnId));

  return NextResponse.json({ ok: true, txnId });
}
