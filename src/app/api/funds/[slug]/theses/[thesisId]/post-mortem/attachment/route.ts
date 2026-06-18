/**
 * Post-mortem attachment download (authenticated stream).
 *
 * GET /api/funds/[slug]/theses/[thesisId]/post-mortem/attachment
 *
 * Post-mortem PDFs live in a PRIVATE Vercel Blob store, so they can't be served
 * by direct URL. This route authenticates the user, verifies the thesis belongs
 * to the fund, then streams the PDF via get({ access: "private" }).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { theses, thesisPostMortems } from "@/db/schema-theses";
import { eq, and } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { get } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
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

  // Verify thesis belongs to the fund, then pull its post-mortem attachment.
  const rows = await db
    .select({
      attachmentBlobUrl: thesisPostMortems.attachmentBlobUrl,
      attachmentBlobFilename: thesisPostMortems.attachmentBlobFilename,
    })
    .from(thesisPostMortems)
    .innerJoin(theses, eq(thesisPostMortems.thesisId, theses.id))
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (rows.length === 0 || !rows[0].attachmentBlobUrl) {
    return NextResponse.json(
      { ok: false, error: "No attachment for this post-mortem" },
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
    const filename = (attachmentBlobFilename ?? "post-mortem.pdf").replace(
      /"/g,
      ""
    );
    return new NextResponse(result.stream, {
      status: 200,
      headers: {
        "Content-Type": result.blob.contentType ?? "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[post-mortem/attachment] retrieval failed:", err);
    return NextResponse.json(
      { ok: false, error: "Attachment retrieval failed" },
      { status: 502 }
    );
  }
}
