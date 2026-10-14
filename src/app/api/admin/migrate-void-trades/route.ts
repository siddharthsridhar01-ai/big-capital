/**
 * Admin/one-off — add the void columns to transactions.
 *
 *   GET /api/admin/migrate-void-trades?secret=<CRON_SECRET>
 *
 * Run BEFORE deploying the code that reads them. Adding columns is backward
 * compatible; reading one the database lacks is not.
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
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_at timestamp`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_by_user_id uuid`);
    await db.execute(sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS void_reason text`);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS transactions_voided_idx ON transactions (fund_id) WHERE voided_at IS NULL`
    );
    return NextResponse.json({ ok: true, note: "Safe to deploy the code that voids trades." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("migrate-void-trades failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
