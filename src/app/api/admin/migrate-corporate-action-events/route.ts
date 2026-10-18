/**
 * Admin/one-off — the corporate action feed.
 *
 *   GET /api/admin/migrate-corporate-action-events?secret=<CRON_SECRET>
 *
 * One table recording every corporate action the system has seen: warnings
 * (SEC filings, news), price signatures (large moves, stale prices), and what
 * was booked (splits automatically; takeovers, mergers and spin-offs by an
 * admin). Each booked event keeps its per-fund before/after impact.
 *
 * dedupe_key is UNIQUE so re-running a scan never records the same event twice.
 *
 * RUN THIS, AND CONFIRM ok:true, BEFORE DEPLOYING THE CODE THAT READS IT.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secret = new URL(req.url).searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS corporate_action_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        security_id uuid NOT NULL,
        fund_id uuid,
        kind text NOT NULL,
        status text NOT NULL DEFAULT 'detected',
        source text NOT NULL,
        title text NOT NULL,
        detail text,
        evidence_url text,
        event_date date,
        dedupe_key text NOT NULL UNIQUE,
        impact jsonb,
        transaction_ids jsonb,
        detected_at timestamp NOT NULL DEFAULT now(),
        resolved_at timestamp,
        resolved_by_user_id uuid
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS corporate_action_events_status_idx
      ON corporate_action_events (status, detected_at DESC)
    `);
    // The table is reached only through the app, like every other table.
    await db.execute(sql`ALTER TABLE corporate_action_events ENABLE ROW LEVEL SECURITY`);
    return NextResponse.json({ ok: true, note: "Feed table present. Safe to deploy step 2." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("migrate-corporate-action-events failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
