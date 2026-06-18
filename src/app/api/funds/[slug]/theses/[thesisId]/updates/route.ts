/**
 * Thesis updates API (standalone).
 *
 * POST /api/funds/[slug]/theses/[thesisId]/updates
 *   Body: { note: string }   (>= 5 chars)
 *
 * Appends a free-text update to a thesis's timeline, not tied to any trade.
 * Trade-linked updates are written by the submit-trade endpoint instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { theses, thesisUpdates } from "@/db/schema-theses";
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

  let body: { note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body" },
      { status: 400 }
    );
  }
  if (typeof body.note !== "string" || body.note.trim().length < 5) {
    return NextResponse.json(
      { ok: false, error: "Update note must be at least 5 characters" },
      { status: 400 }
    );
  }
  const note = body.note.trim();

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

  try {
    await db.insert(thesisUpdates).values({
      thesisId,
      authorUserId: user.id,
      transactionId: null,
      note,
    });
  } catch (err) {
    console.error("[thesis updates] write failed:", err);
    return NextResponse.json(
      { ok: false, error: "Database write failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
