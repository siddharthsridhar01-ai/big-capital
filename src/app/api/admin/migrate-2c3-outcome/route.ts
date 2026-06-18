/**
 * Phase 2c.3 fix — reconcile the post_mortem_outcome enum.
 *
 * Run once:  /api/admin/migrate-2c3-outcome?secret=<CRON_SECRET>
 *
 * Background: Phase 1 (schema.ts) created the Postgres enum
 * `post_mortem_outcome` with labels thesis_played_out / ...failed / etc. for an
 * old, unused `post_mortems` stub. The 2c.1 migration tried to create the same
 * type with win/loss/break_even, saw it already existed, and skipped it — so
 * the thesis_post_mortems.outcome column is bound to the OLD label set and
 * rejects "win". This adds the three labels we actually use.
 *
 * ALTER TYPE ... ADD VALUE is idempotent here via IF NOT EXISTS and runs in
 * autocommit (each statement standalone — not wrapped in a transaction, which
 * Postgres requires for ADD VALUE).
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

  const result: { steps: string[]; errors: string[]; labels?: string[] } = {
    steps: [],
    errors: [],
  };

  try {
    for (const label of ["win", "loss", "break_even"]) {
      await sql.unsafe(
        `ALTER TYPE post_mortem_outcome ADD VALUE IF NOT EXISTS '${label}'`
      );
      result.steps.push(`Ensured enum label: ${label}`);
    }

    // Report the enum's full label set so we can confirm it now contains ours.
    const rows = await sql<{ label: string }[]>`
      SELECT e.enumlabel AS label
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'post_mortem_outcome'
      ORDER BY e.enumsortorder
    `;
    result.labels = rows.map((r) => r.label);

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  } finally {
    await sql.end();
  }
}
