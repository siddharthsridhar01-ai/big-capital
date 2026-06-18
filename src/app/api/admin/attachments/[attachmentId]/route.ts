/**
 * Trade attachment download (authenticated stream, admin only).
 *
 * GET /api/admin/attachments/[attachmentId]
 *
 * Per-trade PDF attachments live in a PRIVATE Vercel Blob store and can't be
 * served by direct URL. This route is admin-gated (matching the admin
 * transaction detail page, the only consumer), looks up the attachment, then
 * streams the PDF back via get({ access: "private" }).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { tradeAttachments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { get } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (user.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: "Admin role required" },
      { status: 403 }
    );
  }

  const { attachmentId } = await params;

  const rows = await db
    .select()
    .from(tradeAttachments)
    .where(eq(tradeAttachments.id, attachmentId))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Attachment not found" },
      { status: 404 }
    );
  }
  const att = rows[0];

  try {
    const result = await get(att.storageUrl, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return NextResponse.json(
        { ok: false, error: "Attachment could not be retrieved from storage" },
        { status: 502 }
      );
    }
    const filename = (att.filename ?? "trade-memo.pdf").replace(/"/g, "");
    return new NextResponse(result.stream, {
      status: 200,
      headers: {
        "Content-Type":
          result.blob.contentType ?? att.mimeType ?? "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[admin/attachments] retrieval failed:", err);
    return NextResponse.json(
      { ok: false, error: "Attachment retrieval failed" },
      { status: 502 }
    );
  }
}
