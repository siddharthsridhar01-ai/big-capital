/**
 * Abandon a thesis.
 *
 * POST /api/funds/[slug]/theses/[thesisId]/abandon
 *
 * Retires an idea that was written up but never acted on. Only an ACTIVE
 * thesis with ZERO linked trades can be abandoned — if it has trades, the
 * correct exit is closing the position (→ closed → post_mortem), not abandon.
 * Sets status = "abandoned" and stamps closedAt as the end of its life.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, transactions } from "@/db/schema";
import { theses } from "@/db/schema-theses";
import { eq, and } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; thesisId: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { slug, thesisId } = await params;

  const fundRows = await db
    .select({ id: fundsTable.id })
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

  const thesisRows = await db
    .select({ id: theses.id, status: theses.status })
    .from(theses)
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (thesisRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Thesis not found" },
      { status: 404 }
    );
  }
  const thesis = thesisRows[0];

  if (thesis.status !== "active") {
    return NextResponse.json(
      { ok: false, error: "Only an active thesis can be abandoned" },
      { status: 400 }
    );
  }

  // Guard: a thesis with trades has a real position history — it must be
  // closed, not abandoned.
  const linkedTrades = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.thesisId, thesisId))
    .limit(1);
  if (linkedTrades.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This thesis has trades linked to it. Close the position to retire it, rather than abandoning.",
      },
      { status: 400 }
    );
  }

  try {
    await db
      .update(theses)
      .set({
        status: "abandoned",
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(theses.id, thesisId));
  } catch (err) {
    console.error("[abandon] write failed:", err);
    return NextResponse.json(
      { ok: false, error: "Database write failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
