/**
 * Admin/one-off — map every stored sector onto a single GICS taxonomy.
 *
 *   GET /api/admin/normalise-sectors?secret=<CRON_SECRET>          (dry run)
 *   GET /api/admin/normalise-sectors?secret=...&apply=1            (writes)
 *
 * The database holds two taxonomies: GICS names from the original UK seed, and
 * Morningstar names returned by Yahoo's assetProfile for everything added since.
 * "Consumer Staples" and "Consumer Defensive" are the same sector under
 * different labels.
 *
 * max_single_sector_pct groups by the exact string, so the split caused the cap
 * to UNDER-report concentration: 20% under each label reads as two 20% buckets
 * rather than one 40% position. A risk limit that fails quiet is worse than one
 * that fails loud.
 *
 * Pure relabelling — no prices, positions or NAV are touched, and running it
 * twice changes nothing the second time.
 */
import { NextRequest, NextResponse } from "next/server";
import { isNotNull, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { securities } from "@/db/schema";
import { normaliseSector, isGicsSector } from "@/lib/sectors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const apply = url.searchParams.get("apply") === "1";

  try {
    const rows = await db
      .select({ id: securities.id, ticker: securities.ticker, sector: securities.gicsSector })
      .from(securities)
      .where(isNotNull(securities.gicsSector));

    const changes: Array<{ ticker: string; from: string; to: string }> = [];
    const unrecognised = new Set<string>();

    for (const r of rows) {
      const current = r.sector as string;
      const mapped = normaliseSector(current);
      if (mapped && mapped !== current) {
        changes.push({ ticker: r.ticker, from: current, to: mapped });
        if (apply) {
          await db.update(securities).set({ gicsSector: mapped }).where(eq(securities.id, r.id));
        }
      }
      // Flag anything that is not a GICS sector even after mapping, so the
      // lookup table can be extended rather than the odd label going unnoticed.
      if (mapped && !isGicsSector(mapped)) unrecognised.add(mapped);
    }

    // Post-change distribution, so the effect is visible rather than asserted.
    const after = new Map<string, number>();
    for (const r of rows) {
      const label = normaliseSector(r.sector as string) ?? "(none)";
      after.set(label, (after.get(label) ?? 0) + 1);
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      examined: rows.length,
      relabelled: changes.length,
      changes: changes.slice(0, 40),
      unrecognised: [...unrecognised],
      distribution: Object.fromEntries([...after.entries()].sort((a, b) => b[1] - a[1])),
      hint: apply ? undefined : "Dry run. Re-run with &apply=1 to write.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("normalise-sectors failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
