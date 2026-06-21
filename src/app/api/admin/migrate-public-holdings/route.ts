/**
 * Phase 3 — ensure the public_holdings_snapshots table exists.
 *   /api/admin/migrate-public-holdings?secret=<CRON_SECRET>
 *
 * Part of the original Phase 1 schema and very likely already present; this is
 * an idempotent safety net (CREATE TABLE IF NOT EXISTS) so the lagged-holdings
 * job works regardless of how the base schema was applied.
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
  const steps: string[] = [];
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS public_holdings_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        fund_id UUID NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
        as_of_date DATE NOT NULL,
        disclosure_type TEXT NOT NULL,
        holdings JSONB NOT NULL,
        published_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    steps.push("Ensured table: public_holdings_snapshots");

    await sql.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS public_holdings_fund_date_type_idx
       ON public_holdings_snapshots(fund_id, as_of_date, disclosure_type)`
    );
    steps.push("Ensured unique index: public_holdings_fund_date_type_idx");

    return NextResponse.json({ ok: true, steps });
  } catch (err) {
    return NextResponse.json(
      { ok: false, steps, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    await sql.end();
  }
}
