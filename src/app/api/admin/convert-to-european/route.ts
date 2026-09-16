/**
 * Admin/one-off — convert the UK Equity Fund into the European Equity Fund.
 *
 *   GET /api/admin/convert-to-european?secret=<CRON_SECRET>          (dry run)
 *   GET /api/admin/convert-to-european?secret=...&apply=1            (writes)
 *
 * WHAT THIS DOES, AND WHY IT IS A RENAME RATHER THAN A NEW FUND:
 *
 * The fund keeps its id, so its NAV history since 1 June, its ledger, its
 * positions and its team all carry over. Creating a new fund would have meant
 * abandoning that track record, which is the main thing the society has to show.
 * It is also why the base currency stays GBP: restating three and a half months
 * of NAV at historical FX rates would produce a series that is not what actually
 * happened.
 *
 * A dormant `european-equity` fund already exists — one of three geographic
 * funds retired by redefine-funds — and slugs are unique, so it is re-slugged
 * out of the way rather than deleted. Deleting a fund row risks orphaning
 * anything that still references it.
 *
 * NOT changed here: the benchmark, the universe and the constraints. Those are
 * keyed by slug in their own routes, so they are run afterwards in sequence.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { funds } from "@/db/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FROM_SLUG = "uk-equity";
const TO_SLUG = "european-equity";
const RETIRED_SLUG = "european-equity-retired";

const NEW_NAME = "BIG Capital European Equity Fund";
const NEW_DESCRIPTION =
  "Long-only European equity fund investing across developed Europe, including the United Kingdom. " +
  "The core of the portfolio is held in high-quality large-cap companies capable of compounding earnings " +
  "over long horizons, complemented by contrarian positions in fundamentally sound businesses where " +
  "negative sentiment or a temporary setback has created a discount to intrinsic value.";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const apply = url.searchParams.get("apply") === "1";

  try {
    const all = await db
      .select({ id: funds.id, slug: funds.slug, name: funds.name, isActive: funds.isActive })
      .from(funds);

    const source = all.find((f) => f.slug === FROM_SLUG);
    const dormant = all.find((f) => f.slug === TO_SLUG);
    const alreadyDone = all.find((f) => f.slug === TO_SLUG && f.isActive);
    const steps: string[] = [];

    if (!source) {
      return NextResponse.json(
        {
          ok: false,
          error: alreadyDone
            ? `Already converted: '${TO_SLUG}' exists and is active.`
            : `Fund '${FROM_SLUG}' not found.`,
        },
        { status: 400 }
      );
    }

    // 1. Free the slug. Only ever touches an INACTIVE fund.
    if (dormant && dormant.id !== source.id) {
      if (dormant.isActive) {
        return NextResponse.json(
          { ok: false, error: `'${TO_SLUG}' exists and is ACTIVE. Refusing to touch a live fund.` },
          { status: 409 }
        );
      }
      steps.push(`re-slug dormant fund ${dormant.id} -> ${RETIRED_SLUG}`);
      if (apply) {
        await db.update(funds).set({ slug: RETIRED_SLUG }).where(eq(funds.id, dormant.id));
      }
    }

    // 2. Rename and re-slug the live fund. Its id, ledger and NAV history are untouched.
    steps.push(`rename '${source.name}' -> '${NEW_NAME}'`);
    steps.push(`re-slug '${FROM_SLUG}' -> '${TO_SLUG}'`);
    steps.push("update strategy description");
    if (apply) {
      await db
        .update(funds)
        .set({ name: NEW_NAME, slug: TO_SLUG, strategyDescription: NEW_DESCRIPTION })
        .where(eq(funds.id, source.id));
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      fundId: source.id,
      steps,
      preserved: "NAV history, transactions, positions, theses and team all keep the same fund id.",
      next: apply
        ? [
            "1. /api/admin/set-benchmark-proxies        (MSCI Europe GBP proxy)",
            "2. /api/admin/backfill-benchmark-prices    (history for the new benchmark)",
            "3. /api/admin/seed-fund-cores?fund=european-equity  (universe)",
            "4. /api/admin/set-fund-constraints&apply=1 (mandate limits)",
            "5. /api/cron/nav-catchup                   (re-strike against the new benchmark)",
          ]
        : "Dry run. Re-run with &apply=1 to write.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("convert-to-european failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
