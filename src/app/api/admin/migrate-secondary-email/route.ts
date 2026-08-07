/**
 * Admin/one-off — add users.secondary_email.
 *
 *   GET /api/admin/migrate-secondary-email?secret=<CRON_SECRET>
 *
 * Members hold both an LSE and a personal address. Clerk reports whichever one
 * they signed in with, so matching on a single column meant the second address
 * created a duplicate row as an analyst with no fund membership. Matching on
 * either column resolves both to the same person with no action needed from
 * them in Clerk.
 *
 * Raw SQL rather than drizzle-kit: `drizzle-kit push` currently crashes while
 * introspecting existing CHECK constraints, so schema changes cannot go through
 * it. Idempotent — safe to re-run.
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
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_email text`);
    // Partial unique index: many rows may leave this NULL.
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS users_secondary_email_key
          ON users (secondary_email) WHERE secondary_email IS NOT NULL`
    );

    const check = await db.execute(
      sql`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'secondary_email'`
    );

    return NextResponse.json({
      ok: true,
      columnPresent: Array.isArray(check) ? check.length > 0 : true,
      note: "Re-run /api/admin/seed-team?apply=1 to populate personal addresses.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("migrate-secondary-email failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
