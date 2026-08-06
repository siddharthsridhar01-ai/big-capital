/**
 * Loads .env.local, refuses to touch production, then runs the wrapped command.
 *
 * Two problems, one script:
 *
 * 1. ENV LOADING. Next.js reads .env.local automatically, but drizzle-kit and
 *    tsx are standalone binaries and do not. `npm run db:push` and `db:seed`
 *    therefore failed with "DATABASE_URL not set" even though the variable was
 *    sitting in .env.local. This loads that file into the environment before
 *    handing off. Variables already set in the real environment win, so a
 *    one-off `$env:DATABASE_URL=...` override still works.
 *
 * 2. PRODUCTION SAFETY. Local tooling used to point at the live database, so a
 *    stray push could drop columns holding the funds' entire track record.
 *    Destructive commands now run only when DB_ENV=dev.
 *
 * Usage (see package.json):
 *   node scripts/db-guard.mjs drizzle-kit push
 *   node scripts/db-guard.mjs tsx src/db/seed.ts
 *
 * Deliberate production access:
 *   $env:ALLOW_PROD_DB=1; npm run db:push
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

/** Minimal .env parser — avoids a dependency just to read a few keys. */
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

const envPath = resolve(process.cwd(), ".env.local");

if (!existsSync(envPath)) {
  console.error(`\u2716 No .env.local found at ${envPath}`);
  process.exit(1);
}

const fileEnv = readEnvFile(envPath);

// Real environment variables take precedence over the file.
for (const [key, value] of Object.entries(fileEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const dbEnv = process.env.DB_ENV;
const databaseUrl = process.env.DATABASE_URL ?? "";
const override = process.env.ALLOW_PROD_DB === "1";
const command = process.argv.slice(2);

let host = "(unparseable)";
try {
  host = new URL(databaseUrl).host;
} catch {
  /* leave placeholder */
}

if (!databaseUrl) {
  console.error(`
\u2716 DATABASE_URL is not set.

  Looked in: ${envPath}
  Add a line such as:
      DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:6543/postgres
`);
  process.exit(1);
}

if (dbEnv !== "dev" && !override) {
  console.error(`
\u2716 Refusing to run: ${command.join(" ") || "(no command)"}

  Target database : ${host}
  DB_ENV          : ${dbEnv ?? "(not set)"}

  Destructive commands only run when DB_ENV=dev, so a stray push or seed
  cannot reach production data.

  If this is your DEV database, add to .env.local:
      DB_ENV=dev

  If you really do mean production (rare - prefer the admin HTTP routes):
      $env:ALLOW_PROD_DB=1; npm run <script>
`);
  process.exit(1);
}

console.log(
  override && dbEnv !== "dev"
    ? `\u26A0 ALLOW_PROD_DB=1 - target ${host}`
    : `\u2713 DB_ENV=dev - target ${host}`
);

if (command.length === 0) process.exit(0);

// shell:true so node_modules/.bin entries (drizzle-kit, tsx) resolve; npm run
// has already put that directory on PATH.
const child = spawn(command.join(" "), {
  stdio: "inherit",
  shell: true,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(`\u2716 Failed to start command: ${err.message}`);
  process.exit(1);
});
