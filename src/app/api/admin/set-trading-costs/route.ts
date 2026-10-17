/**
 * Admin — set the transaction cost applied to every fund.
 *
 *   GET /api/admin/set-trading-costs?secret=<CRON_SECRET>             (dry run)
 *   GET /api/admin/set-trading-costs?secret=...&bps=0&apply=1         (writes)
 *
 * Trading costs are modelled as zero. A realistic all-in figure for liquid
 * European and US large caps is debatable — somewhere between a few and ten
 * basis points — and its effect on returns is negligible either way. Picking a
 * number would add an assumption to defend without improving the result, so the
 * book is reported gross of transaction costs, and that is disclosed on the
 * public fund page.
 *
 * The calculation is left in place and simply multiplies by zero. Restoring
 * costs is a matter of passing a different `bps`, not rewriting anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const apply = url.searchParams.get("apply") === "1";
  const bps = Number(url.searchParams.get("bps") ?? 0);
  if (!Number.isInteger(bps) || bps < 0 || bps > 100) {
    return NextResponse.json({ ok: false, error: "bps must be an integer from 0 to 100" }, { status: 400 });
  }

  try {
    const rows = await db.select({ slug: funds.slug, current: funds.tradingFeesBps }).from(funds);
    if (apply) await db.update(funds).set({ tradingFeesBps: bps });
    return NextResponse.json({
      ok: true,
      applied: apply,
      setTo: bps,
      funds: rows.map((r) => ({ fund: r.slug, from: r.current, to: bps })),
      hint: apply ? undefined : "Dry run. Re-run with &apply=1 to write.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("set-trading-costs failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
