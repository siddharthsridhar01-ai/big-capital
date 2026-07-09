/**
 * One-off cleanup — delete ALL trade (transaction) PDF attachments: the blob
 * files and the tradeAttachments rows. Thesis memos and thesis-update
 * attachments are untouched. Run once:
 *   /api/admin/delete-trade-attachments?secret=<CRON_SECRET>
 * Idempotent (running again just deletes nothing).
 */
import { NextRequest, NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { db } from "@/db/client";
import { tradeAttachments } from "@/db/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice("Bearer ".length)
      : null);
  if (!provided || provided !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const rows = await db
    .select({ id: tradeAttachments.id, storageUrl: tradeAttachments.storageUrl })
    .from(tradeAttachments);

  let blobsDeleted = 0;
  const blobErrors: string[] = [];
  for (const r of rows) {
    try {
      await del(r.storageUrl);
      blobsDeleted++;
    } catch (e) {
      // Blob may already be gone; record but continue so rows still get cleared.
      blobErrors.push(e instanceof Error ? e.message : String(e));
    }
  }

  await db.delete(tradeAttachments);

  return NextResponse.json({
    ok: true,
    rowsDeleted: rows.length,
    blobsDeleted,
    blobErrors,
  });
}
