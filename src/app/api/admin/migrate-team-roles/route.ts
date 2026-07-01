/**
 * Phase 3 — add 'senior_analyst' to the fund_member_role enum so the team
 * hierarchy (Portfolio Manager / Senior Analyst / Analyst) can be expressed.
 *
 * Run once:  /api/admin/migrate-team-roles?secret=<CRON_SECRET>
 *
 * Idempotent: ADD VALUE IF NOT EXISTS is a no-op if already present.
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
    await sql.unsafe(`ALTER TYPE fund_member_role ADD VALUE IF NOT EXISTS 'senior_analyst'`);
    return NextResponse.json({ ok: true, step: "Ensured enum value: fund_member_role.senior_analyst" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    await sql.end();
  }
}
