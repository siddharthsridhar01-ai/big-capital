/**
 * Admin/one-off — add users.degree.
 *
 *   GET /api/admin/migrate-degree?secret=<CRON_SECRET>
 *
 * Members were typing their degree into the free-text bio, so no two entries
 * matched and the public team pages could not present them consistently. The
 * column is populated from a fixed list (src/lib/degrees.ts).
 *
 * MUST BE RUN BEFORE deploying the code that reads it. Adding a column is
 * backward-compatible; reading a column that does not exist is not, and that
 * ordering mistake has already taken production down once.
 *
 * Raw SQL rather than drizzle-kit: `drizzle-kit push` currently crashes while
 * introspecting existing CHECK constraints. Idempotent.
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
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS degree text`);
    return NextResponse.json({
      ok: true,
      note: "users.degree added. Safe to deploy the code that reads it.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("migrate-degree failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
