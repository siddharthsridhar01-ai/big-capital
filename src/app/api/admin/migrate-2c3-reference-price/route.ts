/**
 * Phase 2c.3 — add reference_price_native to theses and thesis_updates.
 *
 * Run once:  /api/admin/migrate-2c3-reference-price?secret=<CRON_SECRET>
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS). Stores the security price captured at
 * formation (theses) and at each revising update (thesis_updates), so the
 * "Upside" headline is a fixed snapshot against the price when the target was
 * set — not a live figure.
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

  const result: { steps: string[]; errors: string[] } = {
    steps: [],
    errors: [],
  };

  const targets: [string, string][] = [
    ["theses", "reference_price_native"],
    ["thesis_updates", "reference_price_native"],
  ];

  try {
    for (const [table, col] of targets) {
      await sql.unsafe(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} NUMERIC(24, 6)`
      );
      result.steps.push(`Ensured column: ${table}.${col}`);
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  } finally {
    await sql.end();
  }
}
