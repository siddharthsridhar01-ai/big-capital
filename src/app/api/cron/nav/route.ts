import { NextRequest, NextResponse } from "next/server";
import { runNavSnapshot } from "@/workers/compute-nav";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  try {
    const result = await runNavSnapshot();
    const status = result.errors.length > 0 ? 207 : 200;
    return NextResponse.json({ ok: result.errors.length === 0, ...result }, { status });
  } catch (err) {
    console.error("NAV cron failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
