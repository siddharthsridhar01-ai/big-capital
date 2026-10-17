/**
 * Admin — whether a fund may feature theses on undisclosed open positions.
 *
 *   POST /api/admin/funds/<slug>/feature-policy   { disclosedOnly: boolean }
 *
 * Off by default: the PM may feature any approved thesis, with a warning when it
 * would publish a live position. On: only closed or already-disclosed positions
 * can be featured, which enforces the holdings disclosure lag rather than
 * leaving it to judgement.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { funds } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }
  let body: { disclosedOnly?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  await db
    .update(funds)
    .set({ featureDisclosedOnly: Boolean(body.disclosedOnly) })
    .where(eq(funds.slug, slug));
  return NextResponse.json({ ok: true, slug, disclosedOnly: Boolean(body.disclosedOnly) });
}
