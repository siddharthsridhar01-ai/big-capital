/**
 * Public memo for a FEATURED thesis.
 *
 * The internal memo route requires a fund member. This one serves the same file
 * to anyone, but only while the thesis is both featured and approved — so
 * featuring a thesis is what makes its memo public, and unfeaturing it takes the
 * memo down again. Nothing else becomes reachable.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { get } from "@vercel/blob";
import { db } from "@/db/client";
import { funds } from "@/db/schema";
import { theses } from "@/db/schema-theses";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; thesisId: string }> }
) {
  const { slug, thesisId } = await params;
  const [fund] = await db.select({ id: funds.id }).from(funds).where(eq(funds.slug, slug)).limit(1);
  if (!fund) return new NextResponse("Not found", { status: 404 });

  const [t] = await db
    .select({ memoBlobUrl: theses.memoBlobUrl, memoBlobFilename: theses.memoBlobFilename })
    .from(theses)
    .where(
      and(
        eq(theses.id, thesisId),
        eq(theses.fundId, fund.id),
        eq(theses.isFeatured, true),
        eq(theses.approvalStatus, "approved")
      )
    )
    .limit(1);
  if (!t?.memoBlobUrl) return new NextResponse("Not found", { status: 404 });

  try {
    const result = await get(t.memoBlobUrl, { access: "private" });
    if (!result) return new NextResponse("Not found", { status: 404 });
    const filename = (t.memoBlobFilename ?? "memo.pdf").replace(/[^a-zA-Z0-9._-]/g, "_");
    return new NextResponse(result.stream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
