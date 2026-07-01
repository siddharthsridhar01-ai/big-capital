/**
 * Manual trigger — run reconciliation now and return any anomalies.
 *   /api/admin/reconcile?secret=<CRON_SECRET>
 * Read-only sanity check; also records a job_runs row so it shows on health.
 */
import { NextRequest, NextResponse } from "next/server";
import { runReconciliation } from "@/workers/reconcile";
import { recordJobRun } from "@/lib/job-runs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice("Bearer ".length)
      : null);
  if (!provided || provided !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const startedAt = new Date();
  try {
    const recon = await runReconciliation();
    await recordJobRun({
      jobName: "reconcile",
      status: recon.fails > 0 ? "error" : recon.warns > 0 ? "partial" : "ok",
      startedAt,
      summary: { fundsChecked: recon.fundsChecked, securitiesChecked: recon.securitiesChecked, fails: recon.fails, warns: recon.warns },
      error: recon.anomalies.length > 0 ? recon.anomalies.map((a) => `[${a.severity}] ${a.message}`).join(" | ") : null,
    });
    return NextResponse.json({ ok: recon.fails === 0, ...recon });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordJobRun({ jobName: "reconcile", status: "error", startedAt, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
