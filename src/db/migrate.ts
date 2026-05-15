/**
 * Database migration runner.
 *
 * Applies all .sql files in drizzle/ to the database in alphabetical order.
 * Tracks applied migrations in a `__drizzle_migrations` table so subsequent
 * runs only apply new ones (idempotent).
 *
 * Called via:  pnpm db:migrate
 * Or during deploy:  set as the postbuild step or a one-off Vercel command
 */

import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 30 });

  try {
    console.log("Connecting to database...");
    await sql`SELECT 1`;
    console.log("Connected.");

    // Ensure migration tracking table exists
    await sql`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `;

    // Find all .sql files in drizzle/
    const migrationsDir = join(process.cwd(), "drizzle");
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    console.log(`Found ${files.length} migration file(s)`);

    for (const file of files) {
      const hash = file; // simple: use filename as hash
      const exists = await sql`
        SELECT 1 FROM __drizzle_migrations WHERE hash = ${hash}
      `;

      if (exists.length > 0) {
        console.log(`  ${file}  (already applied, skipping)`);
        continue;
      }

      console.log(`  ${file}  (applying...)`);
      const contents = await readFile(join(migrationsDir, file), "utf-8");

      // Drizzle uses --> statement-breakpoint to separate statements
      const statements = contents
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
        await tx`
          INSERT INTO __drizzle_migrations (hash) VALUES (${hash})
        `;
      });
      console.log(`  ${file}  ✓`);
    }

    console.log("Migrations complete.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
