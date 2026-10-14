/**
 * Admin — void a transaction.
 *
 *   POST /api/admin/transactions/<id>/void   { reason: string }
 *   POST /api/admin/transactions/<id>/void   { reason, unvoid: true }
 *
 * Voiding, not deletion. The row stays in the ledger and on the activity feed,
 * struck through, recording who voided it and why. It is excluded from
 * positions, NAV, cash and reconciliation.
 *
 * Deleting would remove the evidence that the error ever happened, which
 * contradicts what PMs are told about the ledger being append-only and leaves
 * nothing to learn from. A real fund busts a trade; it does not pretend the
 * trade never existed.
 *
 * Admin only. A PM correcting their own mistake should enter a counter-trade,
 * which is the honest record of what occurred. Voiding is for trades that should
 * never have reached the ledger at all.
 *
 * Recompute NAV afterwards: the catch-up re-strikes the last two days
 * automatically, but an older void needs an explicit compute-nav over its range.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { transactions } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ txnId: string }> }
) {
  const { txnId } = await params;

  const user = await getOrCreateUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }

  let body: { reason?: string; unvoid?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const reason = (body.reason ?? "").trim();
  if (!body.unvoid && reason.length < 10) {
    return NextResponse.json(
      { ok: false, error: "A reason of at least 10 characters is required." },
      { status: 400 }
    );
  }

  try {
    const [txn] = await db
      .select({ id: transactions.id, fundId: transactions.fundId, voidedAt: transactions.voidedAt })
      .from(transactions)
      .where(eq(transactions.id, txnId))
      .limit(1);

    if (!txn) {
      return NextResponse.json({ ok: false, error: "Transaction not found" }, { status: 404 });
    }

    if (body.unvoid) {
      if (!txn.voidedAt) {
        return NextResponse.json({ ok: false, error: "Not voided." }, { status: 400 });
      }
      await db
        .update(transactions)
        .set({ voidedAt: null, voidedByUserId: null, voidReason: null })
        .where(eq(transactions.id, txnId));
      return NextResponse.json({
        ok: true,
        action: "unvoided",
        note: "Recompute NAV over the affected dates.",
      });
    }

    if (txn.voidedAt) {
      return NextResponse.json({ ok: false, error: "Already voided." }, { status: 400 });
    }

    await db
      .update(transactions)
      .set({ voidedAt: new Date(), voidedByUserId: user.id, voidReason: reason })
      .where(eq(transactions.id, txnId));

    return NextResponse.json({
      ok: true,
      action: "voided",
      fundId: txn.fundId,
      note: "Excluded from positions, NAV and cash. Recompute NAV over the affected dates.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("void transaction failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
