/**
 * Migration — add optional `title` column to thesis_updates (so an update has a
 * title + body, mirroring the opening thesis).
 * Run once:  /api/admin/migrate-update-title?secret=<CRON_SECRET>
 * Idempotent.
 */
import { NextRequest, NextResponse } from "next/server";
import postgres from "postgres";

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

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, ssl: { rejectUnauthorized: false } });
  try {
    await sql.unsafe(`ALTER TABLE thesis_updates ADD COLUMN IF NOT EXISTS title text;`);
    return NextResponse.json({ ok: true, step: "Ensured thesis_updates.title column" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    await sql.end();
  }
}
