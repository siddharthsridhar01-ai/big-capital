/**
 * Print a fund's standing limit utilisation.
 *
 *   npm run limits              (defaults to uk-equity)
 *   npm run limits -- global-equity
 *
 * Reads the same constraint rows and evaluator the trade blocker uses, so this
 * is the authoritative answer to "is the book on-mandate right now" until the
 * dashboard panel is wired up.
 *
 * Runs through the db guard, so it targets whichever database .env.local points
 * at — dev by default. Read-only.
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { funds } from "../src/db/schema";
import { loadBookLimits } from "../src/lib/book-limits";

// No argument: every active fund. A breach in the fund you were not looking at
// is exactly the one that goes unnoticed.
const slug = process.argv[2];

const fmt = (v: number, isPct: boolean) =>
  isPct ? `${(v * 100).toFixed(2)}%` : String(Math.round(v));

async function report(fund: { id: string; name: string; slug: string }) {
  const result = await loadBookLimits(fund.id);
  if (!result) {
    console.log(`\n${fund.name}  (${fund.slug})\n  could not load limits\n`);
    return 0;
  }

  console.log(`\n${fund.name}  (${fund.slug})\n`);

  if (result.limits.length === 0) {
    console.log("  No measurable limits — the fund may hold nothing, or a held");
    console.log("  security is missing a price or FX rate.\n");
  }

  for (const l of result.limits) {
    const detail = l.detail ? ` (${l.detail})` : "";
    const util = l.utilisation == null ? "" : `${Math.round(l.utilisation * 100)}% of limit`;
    const flag = l.breached ? "  <-- BREACH" : l.exempt === "ramp-up" ? "  (ramp-up)" : "";
    console.log(
      `  ${(l.label + detail).padEnd(30)} ${fmt(l.current, l.isPct).padStart(9)} / ${fmt(
        l.limit,
        l.isPct
      ).padStart(8)}   ${util.padEnd(16)}${flag}`
    );
  }

  if (result.hardRules.length > 0) {
    console.log(`\n  hard rules: ${result.hardRules.map((r) => r.label).join(", ")}`);
  }
  console.log(
    `\n  ${result.breachCount} breach${result.breachCount === 1 ? "" : "es"}\n`
  );
  return result.breachCount;
}

async function main() {
  const rows = slug
    ? await db.select().from(funds).where(eq(funds.slug, slug)).limit(1)
    : await db.select().from(funds).where(eq(funds.isActive, true)).orderBy(funds.slug);

  if (rows.length === 0) {
    console.error(slug ? `Fund '${slug}' not found.` : "No active funds.");
    process.exitCode = 1;
    return;
  }

  let total = 0;
  for (const f of rows) {
    total += await report({ id: f.id, name: f.name, slug: f.slug });
  }

  if (rows.length > 1) {
    console.log(`${"-".repeat(60)}\n  ${total} breach${total === 1 ? "" : "es"} across ${rows.length} funds\n`);
  }
}

main()
  .catch((err) => {
    console.error("FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
