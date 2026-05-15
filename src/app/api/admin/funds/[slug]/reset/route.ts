/**
 * Admin: reset fund.
 *
 * POST /api/admin/funds/[slug]/reset
 *
 * Wipes all transactions, positions, and trade attachments for a fund —
 * effectively rolling the fund back to its inception state. Admin-only.
 *
 * Used for testing and during the initial setup period before the fund goes
 * live. After PMs start trading "for real," this endpoint should not be used
 * lightly — it destroys audit history.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  funds as fundsTable,
  transactions,
  positions,
  tradeAttachments,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { eq, inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await getOrCreateUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: "Admin role required" },
      { status: 403 }
    );
  }

  const { slug } = await params;
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

  // Find all txn ids for cascade-delete of attachments
  const txnIdRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.fundId, fund.id));
  const txnIds = txnIdRows.map((r) => r.id);

  if (txnIds.length > 0) {
    // Delete attachments first (FK to transactions cascades on delete, but
    // we delete explicitly to be safe and to know the count)
    await db
      .delete(tradeAttachments)
      .where(inArray(tradeAttachments.transactionId, txnIds));
  }
  await db.delete(transactions).where(eq(transactions.fundId, fund.id));
  await db.delete(positions).where(eq(positions.fundId, fund.id));

  return NextResponse.json({
    ok: true,
    fund: fund.slug,
    deletedTransactions: txnIds.length,
  });
}
