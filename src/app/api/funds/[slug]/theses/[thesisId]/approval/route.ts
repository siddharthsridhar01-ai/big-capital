/**
 * PATCH /api/funds/[slug]/theses/[thesisId]/approval
 * Body: { action: "approve" | "reject" }
 *
 * A PM (member of the fund) or an admin approves or rejects a thesis that an
 * analyst submitted for review. Approved theses can then have trades linked to
 * them; rejected ones are marked as such. Metadata only — no ledger impact.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, fundMembers } from "@/db/schema";
import { theses } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; thesisId: string }> }
) {
  const { slug, thesisId } = await params;
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  if (user.role !== "admin" && user.role !== "pm") {
    return NextResponse.json(
      { ok: false, error: "Only PMs and admins can approve theses" },
      { status: 403 }
    );
  }

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  const fund = fundRows[0];

  if (user.role === "pm") {
    const mem = await db
      .select({ userId: fundMembers.userId })
      .from(fundMembers)
      .where(and(eq(fundMembers.fundId, fund.id), eq(fundMembers.userId, user.id), isNull(fundMembers.endDate)))
      .limit(1);
    if (mem.length === 0) {
      return NextResponse.json({ ok: false, error: "You are not a PM of this fund" }, { status: 403 });
    }
  }

  const thRows = await db
    .select({ id: theses.id, approvalStatus: theses.approvalStatus })
    .from(theses)
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (thRows.length === 0) return NextResponse.json({ ok: false, error: "Thesis not found" }, { status: 404 });

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const action = body.action;
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ ok: false, error: "action must be 'approve' or 'reject'" }, { status: 400 });
  }

  await db
    .update(theses)
    .set({
      approvalStatus: action === "approve" ? "approved" : "rejected",
      approvedByUserId: user.id,
      approvedAt: new Date(),
    })
    .where(eq(theses.id, thesisId));

  return NextResponse.json({ ok: true, thesisId, approvalStatus: action === "approve" ? "approved" : "rejected" });
}
