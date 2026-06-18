/**
 * Phase 2c.3 — add revision + attachment fields to thesis_updates.
 *
 * Run once:  /api/admin/migrate-2c3-update-fields?secret=<CRON_SECRET>
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS). Lets an update revise the thesis's
 * conviction / holding period / target weight / target price and attach a PDF,
 * recorded as a progression on the timeline (the theses row stays the original
 * opening snapshot).
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

  const columns: [string, string][] = [
    ["new_conviction", "TEXT"],
    ["new_holding_period", "TEXT"],
    ["new_target_weight_pct", "NUMERIC(6, 4)"],
    ["new_target_price_native", "NUMERIC(24, 6)"],
    ["attachment_blob_url", "TEXT"],
    ["attachment_blob_filename", "TEXT"],
  ];

  try {
    for (const [name, type] of columns) {
      await sql.unsafe(
        `ALTER TABLE thesis_updates ADD COLUMN IF NOT EXISTS ${name} ${type}`
      );
      result.steps.push(`Ensured column: thesis_updates.${name}`);
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  } finally {
    await sql.end();
  }
}
