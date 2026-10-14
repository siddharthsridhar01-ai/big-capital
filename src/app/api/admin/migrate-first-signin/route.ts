/**
 * Admin/one-off — add users.first_sign_in_at.
 *
 *   GET /api/admin/migrate-first-signin?secret=<CRON_SECRET>
 *
 * A user row can exist because an admin added them to a fund, which is not the
 * same as them having an account. Without this column there was no way to tell
 * "invited" from "active".
 *
 * Existing users are backdated to their createdAt: anyone already in the table
 * got there by signing in, since that was the only way a real row was created.
 *
 * RUN BEFORE deploying the code that reads it.
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
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_sign_in_at timestamp`);
    // Anyone with a real address already signed in to exist; placeholder rows
    // from the old display-only team flow did not, so they stay null.
    await db.execute(sql`
      UPDATE users
      SET first_sign_in_at = created_at
      WHERE first_sign_in_at IS NULL
        AND email NOT LIKE '%@bigcapital.invalid'
    `);
    return NextResponse.json({ ok: true, note: "Safe to deploy the code that reads it." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("migrate-first-signin failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
