/**
 * Admin: reset fund.
 *
 * POST /api/admin/funds/[slug]/reset
 *
 * Wipes all transactions, positions, trade attachments, AND thesis data
 * (theses, updates, post-mortems) for a fund — rolling it back to inception.
 * Admin-only. Fund-scoped: the investable universe and price history are left
 * intact. PDF blobs in storage are not deleted (harmless orphans).
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
import { theses, thesisUpdates, thesisPostMortems } from "@/db/schema-theses";
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

  // Thesis data for this fund: post-mortems and updates first (children of
  // theses), then the theses themselves. Explicit deletes so this holds
  // regardless of DB-level cascade settings.
  const thesisIdRows = await db
    .select({ id: theses.id })
    .from(theses)
    .where(eq(theses.fundId, fund.id));
  const thesisIds = thesisIdRows.map((r) => r.id);

  if (thesisIds.length > 0) {
    await db
      .delete(thesisPostMortems)
      .where(inArray(thesisPostMortems.thesisId, thesisIds));
    await db
      .delete(thesisUpdates)
      .where(inArray(thesisUpdates.thesisId, thesisIds));
    await db.delete(theses).where(eq(theses.fundId, fund.id));
  }

  return NextResponse.json({
    ok: true,
    fund: fund.slug,
    deletedTransactions: txnIds.length,
    deletedTheses: thesisIds.length,
  });
}
