/**
 * Approve or reject a thesis update.
 *
 *   POST /api/funds/<slug>/theses/<thesisId>/updates/<updateId>/approval
 *        { action: "approve" | "reject" }
 *
 * Only the fund's PM (or an admin) may decide. An approved update becomes part
 * of the thesis's current state — its conviction, holding period and targets
 * take effect. A rejected one stays on the record, visibly declined, but never
 * changes the thesis.
 *
 * Metadata only: approving an update does not trade anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { funds } from "@/db/schema";
import { thesisUpdates, theses } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { isFundPm } from "@/lib/fund-role";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; thesisId: string; updateId: string }> }
) {
  const { slug, thesisId, updateId } = await params;
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });

  const [fund] = await db.select({ id: funds.id }).from(funds).where(eq(funds.slug, slug)).limit(1);
  if (!fund) return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });

  if (!(await isFundPm(user, fund.id))) {
    return NextResponse.json(
      { ok: false, error: "Only the fund's Portfolio Manager can approve updates." },
      { status: 403 }
    );
  }

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ ok: false, error: "action must be approve or reject" }, { status: 400 });
  }

  // Confirm the update belongs to a thesis in this fund before touching it.
  const [row] = await db
    .select({ id: thesisUpdates.id })
    .from(thesisUpdates)
    .innerJoin(theses, eq(theses.id, thesisUpdates.thesisId))
    .where(and(eq(thesisUpdates.id, updateId), eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (!row) return NextResponse.json({ ok: false, error: "Update not found" }, { status: 404 });

  const status = body.action === "approve" ? "approved" : "rejected";
  await db
    .update(thesisUpdates)
    .set({ approvalStatus: status, approvedByUserId: user.id, approvedAt: new Date() })
    .where(eq(thesisUpdates.id, updateId));

  return NextResponse.json({ ok: true, updateId, approvalStatus: status });
}
