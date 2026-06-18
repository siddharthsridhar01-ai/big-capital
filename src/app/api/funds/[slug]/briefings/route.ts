/**
 * Briefings API — create.
 *
 * POST /api/funds/[slug]/briefings
 *   Body: { period, title, macroSection, portfolioActivitySection,
 *           performanceCommentarySection, outlookSection?, publish? }
 *
 * Creates a monthly briefing (draft by default; publishes immediately if
 * publish=true). One briefing per fund per period (unique). Signed-in users.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, monthlyBriefings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { slug } = await params;

  const fundRows = await db
    .select({ id: fundsTable.id })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  }
  const fund = fundRows[0];

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const period = str("period");
  const title = str("title");
  const macro = str("macroSection");
  const activity = str("portfolioActivitySection");
  const performance = str("performanceCommentarySection");
  const outlook = str("outlookSection");
  const publish = body.publish === true;

  if (!PERIOD_RE.test(period)) {
    return NextResponse.json({ ok: false, error: "Period must be YYYY-MM" }, { status: 400 });
  }
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

  try {
    const [row] = await db
      .insert(monthlyBriefings)
      .values({
        fundId: fund.id,
        authorUserId: user.id,
        period,
        title,
        macroSection: macro,
        portfolioActivitySection: activity,
        performanceCommentarySection: performance,
        outlookSection: outlook || null,
        status: publish ? "published" : "draft",
        publishedAt: publish ? new Date() : null,
      })
      .returning({ id: monthlyBriefings.id });
    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("briefings_fund_period_idx") || msg.toLowerCase().includes("unique")) {
      return NextResponse.json(
        { ok: false, error: `A briefing for ${period} already exists for this fund` },
        { status: 409 }
      );
    }
    console.error("[briefings] create failed:", err);
    return NextResponse.json({ ok: false, error: "Database write failed" }, { status: 500 });
  }
}
