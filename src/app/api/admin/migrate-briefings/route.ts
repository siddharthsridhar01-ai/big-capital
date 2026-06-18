/**
 * Phase 3 — ensure the monthly_briefings table and its status enum exist.
 *
 * Run once:  /api/admin/migrate-briefings?secret=<CRON_SECRET>
 *
 * These are part of the original Phase 1 schema and are very likely already
 * present; this is an idempotent safety net (CREATE TYPE / TABLE IF NOT EXISTS)
 * so the briefings feature works regardless of how the base schema was applied.
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

  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1,
    ssl: { rejectUnauthorized: false },
  });
  const result: { steps: string[]; errors: string[] } = { steps: [], errors: [] };

  try {
    const exists = await sql`SELECT 1 FROM pg_type WHERE typname = 'briefing_status'`;
    if (exists.length === 0) {
      await sql.unsafe(`CREATE TYPE briefing_status AS ENUM ('draft', 'published')`);
      result.steps.push("Created enum: briefing_status");
    } else {
      result.steps.push("Enum already present: briefing_status");
    }

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS monthly_briefings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        fund_id UUID NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
        author_user_id UUID NOT NULL REFERENCES users(id),
        period VARCHAR(7) NOT NULL,
        title TEXT NOT NULL,
        macro_section TEXT NOT NULL,
        portfolio_activity_section TEXT NOT NULL,
        performance_commentary_section TEXT NOT NULL,
        outlook_section TEXT,
        status briefing_status NOT NULL DEFAULT 'draft',
        published_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    result.steps.push("Ensured table: monthly_briefings");

    await sql.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS briefings_fund_period_idx ON monthly_briefings(fund_id, period)`
    );
    result.steps.push("Ensured unique index: briefings_fund_period_idx");

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  } finally {
    await sql.end();
  }
}
