/**
 * Thesis-update attachment download (authenticated stream).
 *
 * GET /api/funds/[slug]/theses/[thesisId]/updates/[updateId]/attachment
 *
 * Update PDFs live in a PRIVATE Vercel Blob store. Authenticates the user,
 * verifies the update belongs to a thesis in this fund, then streams the PDF.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { theses, thesisUpdates } from "@/db/schema-theses";
import { eq, and } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { get } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ slug: string; thesisId: string; updateId: string }>;
  }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { slug, thesisId, updateId } = await params;

  const fundRows = await db
    .select({ id: fundsTable.id })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  }
  const fund = fundRows[0];

  const rows = await db
    .select({
      attachmentBlobUrl: thesisUpdates.attachmentBlobUrl,
      attachmentBlobFilename: thesisUpdates.attachmentBlobFilename,
    })
    .from(thesisUpdates)
    .innerJoin(theses, eq(thesisUpdates.thesisId, theses.id))
    .where(
      and(
        eq(thesisUpdates.id, updateId),
        eq(thesisUpdates.thesisId, thesisId),
        eq(theses.fundId, fund.id)
      )
    )
    .limit(1);
  if (rows.length === 0 || !rows[0].attachmentBlobUrl) {
    return NextResponse.json(
      { ok: false, error: "No attachment for this update" },
      { status: 404 }
    );
  }
  const { attachmentBlobUrl, attachmentBlobFilename } = rows[0];

  try {
    const result = await get(attachmentBlobUrl, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return NextResponse.json(
        { ok: false, error: "Attachment could not be retrieved from storage" },
        { status: 502 }
      );
    }
    const filename = (attachmentBlobFilename ?? "update.pdf").replace(/"/g, "");
    return new NextResponse(result.stream, {
      status: 200,
      headers: {
        "Content-Type": result.blob.contentType ?? "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[updates/attachment] retrieval failed:", err);
    return NextResponse.json(
      { ok: false, error: "Attachment retrieval failed" },
      { status: 502 }
    );
  }
}
