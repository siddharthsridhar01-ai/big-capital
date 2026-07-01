import { db } from "@/db/client";
import { jobRuns } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  ok: { label: "OK", color: "#1F5C3A", bg: "#EAF3EC" },
  partial: { label: "Partial", color: "#8A6D1F", bg: "#FaF3E2" },
  error: { label: "Error", color: "#7A1F1F", bg: "#F8E8E8" },
};

const JOB_LABEL: Record<string, string> = {
  nightly: "Nightly (dividends → NAV → holdings)",
  prices: "Prices (Yahoo EOD)",
  fx: "FX (ECB)",
  reconcile: "Reconciliation (data sanity)",
};

function ago(d: Date): string {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fmtWhen(d: Date): string {
  return new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default async function SystemHealthPage() {
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");
  if (user.role !== "admin") {
    return (
      <main style={{ padding: "28px 32px" }}>
        <p style={{ fontFamily: "system-ui, sans-serif", color: "#7A1F1F" }}>Admin role required.</p>
      </main>
    );
  }

  const runs = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(50);

  // Latest run per job for the status board.
  const latestByJob = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    if (!latestByJob.has(r.jobName)) latestByJob.set(r.jobName, r);
  }
  const boardJobs = ["nightly", "prices", "fx", "reconcile"];

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 900 }}>
      <Link href="/dashboard/admin" style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
        ← Admin
      </Link>
      <h1 style={{ ...serif, fontSize: 26, color: "#00183A", margin: "10px 0 6px", fontWeight: 400 }}>System health</h1>
      <p style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#6B6B66", marginBottom: 22 }}>
        Scheduled jobs record every run here. A red status means the last run failed — check it before trusting the day&rsquo;s data.
      </p>

      {/* Status board */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 30 }}>
        {boardJobs.map((job) => {
          const r = latestByJob.get(job);
          const s = r ? STATUS_STYLE[r.status] ?? STATUS_STYLE.error : null;
          return (
            <div key={job} style={{ border: "1px solid #E5E5DE", background: "white", padding: "14px 16px" }}>
              <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "#9A9A8E", marginBottom: 8 }}>
                {JOB_LABEL[job] ?? job}
              </div>
              {r && s ? (
                <>
                  <span style={{ display: "inline-block", fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: 600, color: s.color, background: s.bg, padding: "3px 10px", borderRadius: 3 }}>
                    {s.label}
                  </span>
                  <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66", marginTop: 8 }}>
                    Last run {ago(r.startedAt)} · {r.durationMs}ms
                  </div>
                </>
              ) : (
                <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#9A9A8E" }}>No runs recorded yet</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Recent runs */}
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6B6B66", fontWeight: 500, marginBottom: 10 }}>
        Recent runs
      </div>
      {runs.length === 0 ? (
        <div style={{ border: "1px solid #E5E5DE", background: "white", padding: "16px 18px", fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#6B6B66" }}>
          No job runs recorded yet. They&rsquo;ll appear here after the next scheduled or manual run.
        </div>
      ) : (
        <div style={{ border: "1px solid #E5E5DE", background: "white" }}>
          {runs.map((r, i) => {
            const s = STATUS_STYLE[r.status] ?? STATUS_STYLE.error;
            return (
              <div key={r.id} style={{ padding: "11px 16px", borderBottom: i < runs.length - 1 ? "1px solid #F0F0EC" : "none", display: "flex", alignItems: "flex-start", gap: 14 }}>
                <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", width: 96, flexShrink: 0 }}>{fmtWhen(r.startedAt)}</span>
                <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#00183A", width: 70, flexShrink: 0 }}>{r.jobName}</span>
                <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, fontWeight: 600, color: s.color, background: s.bg, padding: "2px 8px", borderRadius: 3, flexShrink: 0 }}>{s.label}</span>
                <span style={{ flex: 1, minWidth: 0, fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66", wordBreak: "break-word" }}>
                  {r.error ? <span style={{ color: "#7A1F1F" }}>{r.error.slice(0, 300)}</span> : summarise(r.summary)}
                </span>
                <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", flexShrink: 0 }}>{r.durationMs}ms</span>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

function summarise(summary: unknown): string {
  if (!summary || typeof summary !== "object") return "—";
  const s = summary as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof s.pricesUpserted === "number") bits.push(`${s.pricesUpserted} prices`);
  const nav = s.nav as Record<string, unknown> | undefined;
  if (nav && typeof nav.daysComputed === "number") bits.push(`${nav.daysComputed} NAV days`);
  const div = s.dividends as Record<string, unknown> | undefined;
  if (div && typeof div.dividendsBooked === "number") bits.push(`${div.dividendsBooked} dividends`);
  if (typeof s.rowsUpserted === "number") bits.push(`${s.rowsUpserted} FX rates`);
  return bits.length > 0 ? bits.join(" · ") : "completed";
}
