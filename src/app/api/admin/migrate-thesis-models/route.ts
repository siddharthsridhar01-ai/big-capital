/**
 * Admin/one-off — financial models on theses, and approval on thesis updates.
 *
 *   GET /api/admin/migrate-thesis-models?secret=<CRON_SECRET>
 *
 * Adds:
 *   theses          model_blob_url, model_blob_filename, model_size_bytes
 *   thesis_updates  approval_status, approved_by_user_id, approved_at
 *
 * Existing updates default to "approved" so nothing already published becomes
 * hidden; only updates submitted after this goes live enter review.
 *
 * RUN THIS, AND CONFIRM ok:true, BEFORE DEPLOYING THE CODE THAT READS IT.
 * Adding columns is backward compatible; reading ones that do not exist is not.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secret = new URL(req.url).searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  try {
    await db.execute(sql`ALTER TABLE theses ADD COLUMN IF NOT EXISTS model_blob_url text`);
    await db.execute(sql`ALTER TABLE theses ADD COLUMN IF NOT EXISTS model_blob_filename text`);
    await db.execute(sql`ALTER TABLE theses ADD COLUMN IF NOT EXISTS model_size_bytes integer`);

    await db.execute(sql`
      ALTER TABLE thesis_updates
      ADD COLUMN IF NOT EXISTS approval_status thesis_approval NOT NULL DEFAULT 'approved'
    `);
    await db.execute(sql`ALTER TABLE thesis_updates ADD COLUMN IF NOT EXISTS approved_by_user_id uuid`);
    await db.execute(sql`ALTER TABLE thesis_updates ADD COLUMN IF NOT EXISTS approved_at timestamp`);

    return NextResponse.json({ ok: true, note: "Columns present. Safe to deploy step 2." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("migrate-thesis-models failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
