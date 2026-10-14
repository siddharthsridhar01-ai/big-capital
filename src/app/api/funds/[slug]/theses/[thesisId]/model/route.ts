/**
 * Thesis memo download (authenticated stream).
 *
 * GET /api/funds/[slug]/theses/[thesisId]/memo
 *
 * Thesis memos live in a PRIVATE Vercel Blob store, so they can't be served by
 * direct URL. This route authenticates the user, verifies the thesis belongs
 * to the fund, then streams the PDF back via get({ access: "private" }).
 *
 * Access level mirrors the theses list page: any authenticated user may view.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { theses } from "@/db/schema-theses";
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

  const rows = await db
    .select({
      modelBlobUrl: theses.modelBlobUrl,
      modelBlobFilename: theses.modelBlobFilename,
    })
    .from(theses)
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Thesis not found" },
      { status: 404 }
    );
  }
  const { modelBlobUrl, modelBlobFilename } = rows[0];
  if (!modelBlobUrl) {
    return NextResponse.json(
      { ok: false, error: "No model is attached to this thesis" },
      { status: 404 }
    );
  }

  try {
    const result = await get(modelBlobUrl, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return NextResponse.json(
        { ok: false, error: "Model could not be retrieved from storage" },
        { status: 502 }
      );
    }
    // Sanitise filename for the Content-Disposition header.
    const filename = (modelBlobFilename ?? "thesis-model.xlsx").replace(/"/g, "");
    return new NextResponse(result.stream, {
      status: 200,
      headers: {
        "Content-Type": result.blob.contentType ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[theses/memo] retrieval failed:", err);
    return NextResponse.json(
      { ok: false, error: "Model retrieval failed" },
      { status: 502 }
    );
  }
}
