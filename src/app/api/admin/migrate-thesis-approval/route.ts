/**
 * Migration — add the thesis approval workflow columns.
 * Run once:  /api/admin/migrate-thesis-approval?secret=<CRON_SECRET>
 * Idempotent. Existing rows become "approved" so nothing changes for them.
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
    await sql.unsafe(`
      DO $$ BEGIN
        CREATE TYPE thesis_approval AS ENUM ('pending', 'approved', 'rejected');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await sql.unsafe(`ALTER TABLE theses ADD COLUMN IF NOT EXISTS approval_status thesis_approval NOT NULL DEFAULT 'approved';`);
    await sql.unsafe(`ALTER TABLE theses ADD COLUMN IF NOT EXISTS submitted_by_user_id uuid REFERENCES users(id);`);
    await sql.unsafe(`ALTER TABLE theses ADD COLUMN IF NOT EXISTS approved_by_user_id uuid REFERENCES users(id);`);
    await sql.unsafe(`ALTER TABLE theses ADD COLUMN IF NOT EXISTS approved_at timestamptz;`);
    return NextResponse.json({ ok: true, step: "Ensured thesis approval columns" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    await sql.end();
  }
}
