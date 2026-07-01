/**
 * Migration — job_runs telemetry table.
 * Run once:  /api/admin/migrate-job-runs?secret=<CRON_SECRET>
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
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS job_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_name text NOT NULL,
        status text NOT NULL,
        started_at timestamp NOT NULL,
        finished_at timestamp NOT NULL,
        duration_ms integer NOT NULL,
        summary jsonb,
        error text,
        created_at timestamp NOT NULL DEFAULT now()
      );
    `);
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS job_runs_job_started_idx ON job_runs (job_name, started_at);`);
    return NextResponse.json({ ok: true, step: "Ensured job_runs table + index" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    await sql.end();
  }
}
