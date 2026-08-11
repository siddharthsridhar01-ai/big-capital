/**
 * Admin/one-off — enable Row-Level Security on every table in the public schema.
 *
 *   GET /api/admin/migrate-enable-rls?secret=<CRON_SECRET>            (report only)
 *   GET /api/admin/migrate-enable-rls?secret=...&apply=1              (enable)
 *   GET /api/admin/migrate-enable-rls?secret=...&apply=1&disable=1    (revert)
 *
 * WHY, given the app does not use Supabase's REST API:
 *
 * Supabase exposes a PostgREST API over the public schema. Row-Level Security is
 * what stops the `anon` and `authenticated` roles reading tables through it.
 * With RLS off and the Data API on, anyone holding the project's anon key could
 * read or modify every row. Disabling the Data API removes that surface today,
 * but it is a setting, and settings get changed by whoever inherits this. RLS is
 * the property of the data itself, so it survives that.
 *
 * WHY THIS DOES NOT BREAK THE APP:
 *
 * The app connects over a direct Postgres connection as the `postgres` role,
 * which OWNS these tables. A table owner bypasses RLS unless FORCE ROW LEVEL
 * SECURITY is set, and it deliberately is NOT set here. So enabling RLS with no
 * policies means: denied through the REST API, entirely unchanged for the app.
 *
 * Verified before writing this: there is no supabase-js dependency and no anon
 * key anywhere in the codebase, so nothing legitimate reads through PostgREST.
 * No policies are created for that reason — a policy would only be needed if
 * something were meant to have API access, and nothing is.
 *
 * Reversible: &disable=1 turns it back off.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface TableRow {
  tablename: string;
  rowsecurity: boolean;
}

async function statuses(): Promise<TableRow[]> {
  const rows = await db.execute(
    sql`SELECT tablename::text, rowsecurity
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename`
  );
  return (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as TableRow[];
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const apply = url.searchParams.get("apply") === "1";
  const disable = url.searchParams.get("disable") === "1";

  try {
    const before = await statuses();

    if (apply) {
      // NOTE: ENABLE, never FORCE. FORCE would subject the table owner to RLS
      // too, which is exactly the role the application connects as.
      if (disable) {
        await db.execute(sql`
          DO $$ DECLARE r record; BEGIN
            FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
              EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', r.tablename);
            END LOOP;
          END $$;
        `);
      } else {
        await db.execute(sql`
          DO $$ DECLARE r record; BEGIN
            FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
              EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
            END LOOP;
          END $$;
        `);
      }
    }

    const after = apply ? await statuses() : before;
    const enabled = after.filter((t) => t.rowsecurity).map((t) => t.tablename);
    const unprotected = after.filter((t) => !t.rowsecurity).map((t) => t.tablename);

    return NextResponse.json({
      ok: true,
      applied: apply,
      action: apply ? (disable ? "disabled" : "enabled") : "report only",
      tables: after.length,
      rlsEnabled: enabled.length,
      rlsDisabled: unprotected.length,
      unprotected,
      hint: apply
        ? "Now load the dashboard and a public fund page to confirm nothing changed. Revert with &disable=1 if anything breaks."
        : "Report only. Re-run with &apply=1 to enable.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("migrate-enable-rls failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
