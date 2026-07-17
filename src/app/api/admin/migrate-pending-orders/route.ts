/**
 * Migration — create the `pending_orders` table (next-close execution model).
 *   /api/admin/migrate-pending-orders?secret=<CRON_SECRET>
 * Idempotent (CREATE TABLE / INDEX IF NOT EXISTS).
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
      CREATE TABLE IF NOT EXISTS pending_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        fund_id uuid NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
        security_id uuid NOT NULL REFERENCES securities(id),
        side transaction_type NOT NULL,
        quantity numeric(24,8) NOT NULL,
        submitted_by_user_id uuid NOT NULL REFERENCES users(id),
        submitted_at timestamp NOT NULL DEFAULT now(),
        rationale text NOT NULL,
        thesis_id uuid,
        update_note text,
        soft_override_justification text,
        status text NOT NULL DEFAULT 'pending',
        filled_transaction_id uuid,
        fill_price numeric(20,6),
        rejection_reason text,
        resolved_at timestamp,
        created_at timestamp NOT NULL DEFAULT now()
      );
    `);
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS pending_orders_fund_status_idx ON pending_orders (fund_id, status);`);
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS pending_orders_status_idx ON pending_orders (status);`);
    return NextResponse.json({ ok: true, created: "pending_orders" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    await sql.end();
  }
}
