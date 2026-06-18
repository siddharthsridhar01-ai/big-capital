/**
 * Phase 2c.3 migration endpoint.
 *
 * Run once after deploying 2c.3b by hitting:
 *   /api/admin/migrate-2c3?secret=<CRON_SECRET>
 *
 * Idempotent — safe to re-run. Creates:
 *   - thesis_updates table (timestamped story entries on a thesis, optionally
 *     linked to the transaction that prompted them)
 */

import { NextRequest, NextResponse } from "next/server";
import postgres from "postgres";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const querySecret = url.searchParams.get("secret");
  const auth = req.headers.get("authorization");
  const bearerSecret = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : null;
  const provided = querySecret ?? bearerSecret;

  if (!provided || provided !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1,
    ssl: { rejectUnauthorized: false },
  });

  const result: { steps: string[]; skipped: string[]; errors: string[] } = {
    steps: [],
    skipped: [],
    errors: [],
  };

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS thesis_updates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        thesis_id UUID NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
        author_user_id UUID NOT NULL REFERENCES users(id),
        transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
        note TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `;
    result.steps.push("Ensured table: thesis_updates");

    await sql`CREATE INDEX IF NOT EXISTS thesis_updates_thesis_idx ON thesis_updates(thesis_id)`;
    await sql`CREATE INDEX IF NOT EXISTS thesis_updates_txn_idx ON thesis_updates(transaction_id)`;
    result.steps.push("Ensured indexes on thesis_updates");

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  } finally {
    await sql.end();
  }
}
