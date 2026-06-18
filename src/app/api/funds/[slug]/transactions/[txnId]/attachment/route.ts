/**
 * Per-trade attachment download (authenticated stream, fund-scoped).
 *
 * GET /api/funds/[slug]/transactions/[txnId]/attachment
 *
 * Per-trade PDFs live in a PRIVATE Vercel Blob store and can't be served by
 * direct URL. This authenticates the user, verifies the transaction belongs to
 * the fund, then streams the attachment via get({ access: "private" }).
 *
 * Access mirrors the thesis-memo route (any authenticated user, fund-scoped) —
 * distinct from /api/admin/attachments/[id], which is admin-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, transactions, tradeAttachments } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { get } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; txnId: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { slug, txnId } = await params;

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

  // Pull the attachment, verifying its transaction belongs to this fund.
  const rows = await db
    .select({
      storageUrl: tradeAttachments.storageUrl,
      filename: tradeAttachments.filename,
      mimeType: tradeAttachments.mimeType,
    })
    .from(tradeAttachments)
    .innerJoin(transactions, eq(tradeAttachments.transactionId, transactions.id))
    .where(
      and(
        eq(tradeAttachments.transactionId, txnId),
        eq(transactions.fundId, fund.id)
      )
    )
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No attachment for this trade" },
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
    const filename = (att.filename ?? "trade-attachment.pdf").replace(/"/g, "");
    return new NextResponse(result.stream, {
      status: 200,
      headers: {
        "Content-Type": result.blob.contentType ?? att.mimeType ?? "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("[transactions/attachment] retrieval failed:", err);
    return NextResponse.json(
      { ok: false, error: "Attachment retrieval failed" },
      { status: 502 }
    );
  }
}
