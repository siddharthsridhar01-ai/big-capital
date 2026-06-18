/**
 * Phase 2c migration endpoint.
 *
 * Run once after deploying 2c.1 code by hitting:
 *   /api/admin/migrate-2c?secret=<CRON_SECRET>
 *
 * Idempotent — safe to re-run. Creates:
 *   - conviction enum
 *   - holding_period enum
 *   - thesis_status enum
 *   - post_mortem_outcome enum
 *   - theses table
 *   - thesis_post_mortems table (NOT post_mortems — avoids clash with any
 *     pre-existing post_mortems table from earlier phase 1 stubs)
 *   - transactions.thesis_id column (nullable FK to theses)
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

  const result: {
    steps: string[];
    skipped: string[];
    errors: string[];
  } = { steps: [], skipped: [], errors: [] };

  try {
    // ----- Enums -----
    const enums = [
      {
        name: "conviction",
        values: ["high", "medium", "low"],
      },
      {
        name: "holding_period",
        values: ["short", "medium", "long", "indefinite"],
      },
      {
        name: "thesis_status",
        values: ["active", "closed", "post_mortem", "abandoned"],
      },
      {
        name: "post_mortem_outcome",
        values: ["win", "loss", "break_even"],
      },
    ];

    for (const e of enums) {
      const exists = await sql`
        SELECT 1 FROM pg_type WHERE typname = ${e.name}
      `;
      if (exists.length === 0) {
        const valuesList = e.values.map((v) => `'${v}'`).join(", ");
        await sql.unsafe(`CREATE TYPE ${e.name} AS ENUM (${valuesList})`);
        result.steps.push(`Created enum: ${e.name}`);
      } else {
        result.skipped.push(`Enum already exists: ${e.name}`);
      }
    }

    // ----- theses table -----
    await sql`
      CREATE TABLE IF NOT EXISTS theses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        fund_id UUID NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
        security_id UUID NOT NULL REFERENCES securities(id),
        author_user_id UUID NOT NULL REFERENCES users(id),
        opened_at TIMESTAMP NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMP,
        status thesis_status NOT NULL DEFAULT 'active',
        direction TEXT,
        conviction conviction NOT NULL,
        target_weight_pct NUMERIC(6, 4),
        target_price_native NUMERIC(24, 6),
        holding_period holding_period NOT NULL,
        summary TEXT NOT NULL,
        memo_blob_url TEXT,
        memo_blob_filename TEXT,
        memo_size_bytes INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `;
    result.steps.push("Ensured table: theses");

    await sql`CREATE INDEX IF NOT EXISTS theses_fund_idx ON theses(fund_id)`;
    await sql`CREATE INDEX IF NOT EXISTS theses_security_idx ON theses(security_id)`;
    await sql`CREATE INDEX IF NOT EXISTS theses_status_idx ON theses(status)`;
    await sql`CREATE INDEX IF NOT EXISTS theses_author_idx ON theses(author_user_id)`;
    result.steps.push("Ensured indexes on theses");

    // ----- thesis_post_mortems table -----
    // Named with `thesis_` prefix to avoid colliding with any pre-existing
    // `post_mortems` table from earlier schema stubs.
    await sql`
      CREATE TABLE IF NOT EXISTS thesis_post_mortems (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        thesis_id UUID NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
        author_user_id UUID NOT NULL REFERENCES users(id),
        written_at TIMESTAMP NOT NULL DEFAULT NOW(),
        realised_return_pct NUMERIC(8, 4),
        outcome post_mortem_outcome NOT NULL,
        what_worked TEXT,
        what_didnt_work TEXT,
        lessons_learned TEXT NOT NULL,
        attachment_blob_url TEXT,
        attachment_blob_filename TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `;
    result.steps.push("Ensured table: thesis_post_mortems");

    await sql`CREATE INDEX IF NOT EXISTS thesis_post_mortems_thesis_idx ON thesis_post_mortems(thesis_id)`;
    result.steps.push("Ensured indexes on thesis_post_mortems");

    // ----- transactions.thesis_id column -----
    const colExists = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'transactions' AND column_name = 'thesis_id'
    `;
    if (colExists.length === 0) {
      await sql`
        ALTER TABLE transactions
        ADD COLUMN thesis_id UUID REFERENCES theses(id) ON DELETE SET NULL
      `;
      result.steps.push("Added column: transactions.thesis_id");
      await sql`CREATE INDEX IF NOT EXISTS transactions_thesis_idx ON transactions(thesis_id)`;
      result.steps.push("Created index: transactions_thesis_idx");
    } else {
      result.skipped.push("Column already exists: transactions.thesis_id");
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { ok: false, ...result },
      { status: 500 }
    );
  } finally {
    await sql.end();
  }
}
