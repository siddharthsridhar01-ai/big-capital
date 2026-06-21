/**
 * Manual trigger — reconstruct lagged public holdings for ONE fund.
 *   /api/admin/funds/[slug]/reconstruct-holdings?secret=<CRON_SECRET>
 */
import { NextRequest, NextResponse } from "next/server";
import { runHoldingsReconstruction } from "@/workers/reconstruct-holdings";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice("Bearer ".length)
      : null);
  if (!provided || provided !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { slug } = await params;
  try {
    const result = await runHoldingsReconstruction({ fundSlug: slug });
    return NextResponse.json({ ok: result.errors.length === 0, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
