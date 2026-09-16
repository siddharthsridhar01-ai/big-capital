/**
 * Admin/one-off — add CHF, DKK, SEK and NOK to the currency enum.
 *
 *   GET /api/admin/migrate-european-currencies?secret=<CRON_SECRET>
 *
 * WHY: the UK fund became a European one benchmarked to MSCI Europe, in which
 * Switzerland is roughly 15%, Sweden 5%, Denmark 4% and Norway 1%. Without these
 * currencies about a quarter of the benchmark — Nestle, Roche, Novartis, Novo
 * Nordisk, Atlas Copco — could not be held at all, so the fund's tracking error
 * would have come from the platform rather than from anyone's decisions. It is
 * also why NOVO.B had to be swapped for its US ADR in August.
 *
 * ECB publishes a daily reference rate for all four, so they are convertible the
 * moment the FX worker picks them up.
 *
 * MUST RUN BEFORE deploying code that writes these values. Adding enum members
 * is backward-compatible; writing one the database does not know is not.
 *
 * ALTER TYPE ... ADD VALUE cannot run inside a transaction block, hence the
 * separate statements. IF NOT EXISTS makes it idempotent.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NEW_CURRENCIES = ["CHF", "DKK", "SEK", "NOK"] as const;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secret = new URL(req.url).searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    for (const code of NEW_CURRENCIES) {
      await db.execute(sql.raw(`ALTER TYPE currency ADD VALUE IF NOT EXISTS '${code}'`));
    }

    const rows = await db.execute(
      sql`SELECT enumlabel::text AS code
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'currency'
          ORDER BY e.enumsortorder`
    );
    const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{
      code: string;
    }>;

    return NextResponse.json({
      ok: true,
      currencies: list.map((r) => r.code),
      note: "Safe to deploy the code that uses these. Then run /api/cron/fx to backfill rates.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("migrate-european-currencies failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
