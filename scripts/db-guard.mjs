/**
 * Refuses destructive database commands unless the target is explicitly dev.
 *
 * Why: local tooling reads DATABASE_URL from .env.local. While dev and prod
 * share one database, `npm run db:push`, `db:migrate` and `db:seed` all write
 * straight to live student data with no warning — a stray push can drop columns
 * holding the funds' entire track record.
 *
 * How: .env.local must declare DB_ENV. Destructive commands run only when
 * DB_ENV=dev. Pointing at production is still possible, but has to be
 * deliberate: ALLOW_PROD_DB=1 npm run db:push
 *
 * Vercel never runs these scripts, so production is unaffected either way.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .env parser — avoids a dependency just to read two keys. */
function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = readEnvFile(resolve(process.cwd(), ".env.local"));
const dbEnv = process.env.DB_ENV ?? fileEnv.DB_ENV;
const databaseUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL ?? "";
const override = process.env.ALLOW_PROD_DB === "1";

let host = "(unparseable)";
try {
  host = new URL(databaseUrl).host;
} catch {
  /* leave placeholder */
}

const command = process.argv.slice(2).join(" ") || "this command";

if (dbEnv === "dev") {
  console.log(`✓ DB_ENV=dev — target ${host}`);
  process.exit(0);
}

if (override) {
  console.warn(`⚠ ALLOW_PROD_DB=1 — running ${command} against ${host}`);
  process.exit(0);
}

console.error(`
✖ Refusing to run ${command}.

  Target database : ${host}
  DB_ENV          : ${dbEnv ?? "(not set)"}

  Destructive commands only run when DB_ENV=dev, so a stray push or seed
  cannot reach production data.

  If this is your DEV database, add to .env.local:
      DB_ENV=dev

  If you really do mean production (rare — prefer the admin HTTP routes):
      $env:ALLOW_PROD_DB=1; npm run ${process.argv[2] ?? "db:push"}
`);
process.exit(1);
