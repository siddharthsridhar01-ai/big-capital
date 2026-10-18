/**
 * Admin — set constraints tailored to each fund's actual mandate.
 *
 *   GET /api/admin/set-fund-constraints?secret=<CRON_SECRET>          (dry run)
 *   GET /api/admin/set-fund-constraints?secret=...&apply=1            (writes)
 *   GET /api/admin/set-fund-constraints?secret=...&fund=<slug>        (one fund)
 *
 * The seed applied one of two generic templates (long_only / long_short) to
 * every fund. That left several funds carrying limits that describe a different
 * strategy from the one they run:
 *
 *   - long-short is mandated with a NET-LONG BIAS but inherited the ±20% net cap
 *     of a market-neutral book, so its own strategy would breach on day one.
 *   - global-equity is "a focused portfolio of 15–20 names" but carried a 40-name
 *     cap and an 8% position cap, which describe a diversified fund.
 *   - systematic-equity is "a diversified book" sized by optimiser, yet carried
 *     the same 40/8% limits as a concentrated discretionary fund.
 *
 * A limit that does not match the mandate is worse than no limit: it trains PMs
 * to treat breaches as noise. Each set below is derived from the fund's own
 * strategy description.
 *
 * Replaces the active constraint rows for a fund. Idempotent, dry-run by default.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { funds, fundConstraints } from "@/db/schema";
import { DEFAULT_LIMITS as MANDATES } from "@/lib/fund-limit-defaults";

export const dynamic = "force-dynamic";


export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const apply = url.searchParams.get("apply") === "1";
  const only = url.searchParams.get("fund");

  try {
    const rows = await db.select({ id: funds.id, slug: funds.slug }).from(funds);
    const bySlug = new Map(rows.map((f) => [f.slug, f.id]));
    const report: Array<Record<string, unknown>> = [];

    for (const [slug, mandate] of Object.entries(MANDATES)) {
      if (only && only !== slug) continue;
      const fundId = bySlug.get(slug);
      if (!fundId) {
        report.push({ fund: slug, status: "fund not found" });
        continue;
      }

      const current = await db
        .select({ type: fundConstraints.constraintType, value: fundConstraints.value })
        .from(fundConstraints)
        .where(and(eq(fundConstraints.fundId, fundId), eq(fundConstraints.isActive, true)));

      const before = new Map(current.map((c) => [c.type, c.value]));
      const changes: string[] = [];
      for (const c of mandate.constraints) {
        const was = before.get(c.type);
        if (was === undefined) changes.push(`+${c.type}=${JSON.stringify(c.value)}`);
        else if (JSON.stringify(was) !== JSON.stringify(c.value))
          changes.push(`${c.type}: ${JSON.stringify(was)} -> ${JSON.stringify(c.value)}`);
      }
      for (const t of before.keys()) {
        if (!mandate.constraints.some((c) => c.type === t)) changes.push(`-${t}`);
      }

      if (apply) {
        await db.delete(fundConstraints).where(eq(fundConstraints.fundId, fundId));
        for (const c of mandate.constraints) {
          await db.insert(fundConstraints).values({
            fundId,
            constraintType: c.type,
            value: c.value,
            isHard: c.isHard,
          });
        }
      }

      report.push({
        fund: slug,
        rationale: mandate.rationale,
        status: changes.length === 0 ? "already correct" : apply ? "updated" : "would update",
        changes: changes.length === 0 ? undefined : changes,
      });
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      hint: apply ? undefined : "Dry run. Re-run with &apply=1 to write.",
      report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("set-fund-constraints failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
