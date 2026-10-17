/**
 * Admin/one-off — featured theses.
 *
 *   GET /api/admin/migrate-featured-theses?secret=<CRON_SECRET>
 *
 * Adds:
 *   theses  is_featured (default false), featured_at
 *   funds   feature_disclosed_only (default false)
 *
 * Nothing is featured until a PM chooses to, so applying this changes nothing
 * visible.
 *
 * RUN THIS, AND CONFIRM ok:true, BEFORE DEPLOYING THE CODE THAT READS IT.
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
    await db.execute(sql`ALTER TABLE theses ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE theses ADD COLUMN IF NOT EXISTS featured_at timestamp`);
    await db.execute(sql`ALTER TABLE funds ADD COLUMN IF NOT EXISTS feature_disclosed_only boolean NOT NULL DEFAULT false`);
    return NextResponse.json({ ok: true, note: "Columns present. Safe to deploy step 2." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("migrate-featured-theses failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
