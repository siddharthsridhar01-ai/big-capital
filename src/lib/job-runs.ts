/**
 * Records a job run to the job_runs table so scheduled/manual jobs are visible
 * on the admin health page. Telemetry must never break the job itself, so all
 * failures here are swallowed (logged only).
 */
import { db } from "@/db/client";
import { jobRuns } from "@/db/schema";

export type JobStatus = "ok" | "partial" | "error";

export async function recordJobRun(input: {
  jobName: string;
  status: JobStatus;
  startedAt: Date;
  summary?: unknown;
  error?: string | null;
}): Promise<void> {
  const finishedAt = new Date();
  try {
    await db.insert(jobRuns).values({
      jobName: input.jobName,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - input.startedAt.getTime()),
      summary: (input.summary ?? null) as object | null,
      error: input.error ?? null,
    });
  } catch (err) {
    console.error("[job-runs] failed to record run", err);
  }
}
