/**
 * Migration — extend the `currency` enum with the Asian (and other) currencies
 * needed to hold local-line equities. Postgres enums are additive; existing
 * values/rows are untouched.
 *   /api/admin/migrate-currencies?secret=<CRON_SECRET>
 * Idempotent (ADD VALUE IF NOT EXISTS).
 */
import { NextRequest, NextResponse } from "next/server";
import postgres from "postgres";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NEW_CURRENCIES = ["JPY", "HKD", "CNY", "KRW", "SGD", "INR", "TWD"];

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
    // ADD VALUE cannot run inside a transaction block, so run each separately.
    for (const c of NEW_CURRENCIES) {
      await sql.unsafe(`ALTER TYPE currency ADD VALUE IF NOT EXISTS '${c}';`);
    }
    return NextResponse.json({ ok: true, added: NEW_CURRENCIES });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    await sql.end();
  }
}
