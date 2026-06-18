/**
 * Briefings API — update / publish / unpublish.
 *
 * PATCH /api/funds/[slug]/briefings/[id]
 *   Body: { action: "save" | "publish" | "unpublish", ...fields }
 *
 * - save: update editable fields, leave status as-is
 * - publish: update fields + set status=published, publishedAt=now
 * - unpublish: set status=draft, publishedAt=null
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, monthlyBriefings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { slug, id } = await params;

  const fundRows = await db
    .select({ id: fundsTable.id })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  }
  const fund = fundRows[0];

  const existing = await db
    .select({ id: monthlyBriefings.id })
    .from(monthlyBriefings)
    .where(and(eq(monthlyBriefings.id, id), eq(monthlyBriefings.fundId, fund.id)))
    .limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ ok: false, error: "Briefing not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const action = body.action;

  if (action === "unpublish") {
    await db
      .update(monthlyBriefings)
      .set({ status: "draft", publishedAt: null, updatedAt: new Date() })
      .where(eq(monthlyBriefings.id, id));
    return NextResponse.json({ ok: true });
  }

  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const title = str("title");
  const macro = str("macroSection");
  const activity = str("portfolioActivitySection");
  const performance = str("performanceCommentarySection");
  const outlook = str("outlookSection");

  for (const [label, v] of [
    ["Title", title],
    ["Macro section", macro],
    ["Portfolio activity", activity],
    ["Performance commentary", performance],
  ] as const) {
    if (!v) {
      return NextResponse.json({ ok: false, error: `${label} is required` }, { status: 400 });
    }
  }

  const publishing = action === "publish";
  const set: Record<string, unknown> = {
    title,
    macroSection: macro,
    portfolioActivitySection: activity,
    performanceCommentarySection: performance,
    outlookSection: outlook || null,
    updatedAt: new Date(),
  };
  if (publishing) {
    set.status = "published";
    set.publishedAt = new Date();
  }

  try {
    await db.update(monthlyBriefings).set(set).where(eq(monthlyBriefings.id, id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[briefings] update failed:", err);
    return NextResponse.json({ ok: false, error: "Database write failed" }, { status: 500 });
  }
}
