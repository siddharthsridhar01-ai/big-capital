import { db } from "@/db/client";
import { funds as fundsTable, users, fundMembers } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  pm: "Portfolio Manager",
  senior_analyst: "Senior Analyst",
  analyst: "Analyst",
};
const ROLE_ORDER: Record<string, number> = { pm: 0, senior_analyst: 1, analyst: 2 };

export default async function TeamListPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db
    .select({ id: fundsTable.id, name: fundsTable.name })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  const rows = await db
    .select({
      userId: users.id,
      fullName: users.fullName,
      roleInFund: fundMembers.roleInFund,
      headshotUrl: users.headshotUrl,
    })
    .from(fundMembers)
    .innerJoin(users, eq(fundMembers.userId, users.id))
    .where(and(eq(fundMembers.fundId, fund.id), isNull(fundMembers.endDate)));

  rows.sort(
    (a, b) => (ROLE_ORDER[a.roleInFund] ?? 9) - (ROLE_ORDER[b.roleInFund] ?? 9) || a.fullName.localeCompare(b.fullName)
  );

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 760 }}>
      <Link href={`/dashboard/funds/${slug}`} style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
        ← {fund.name}
      </Link>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "10px 0 22px" }}>
        <h1 style={{ ...serif, fontSize: 26, color: "#00183A", margin: 0, fontWeight: 400 }}>Investment team</h1>
        <Link href={`/dashboard/funds/${slug}/team/new`} style={{ fontSize: 12, color: "white", background: "#00183A", border: "1px solid #00183A", padding: "8px 14px", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
          Add member →
        </Link>
      </div>

      {rows.length === 0 ? (
        <div style={{ border: "1px solid #D9D9D2", background: "white", padding: "18px 20px", fontSize: 13, color: "#6B6B66", fontFamily: "system-ui, sans-serif" }}>
          No team members yet. Add the fund&rsquo;s PMs and analysts.
        </div>
      ) : (
        <div style={{ border: "1px solid #E5E5DE" }}>
          {rows.map((r, i) => (
            <Link key={r.userId} href={`/dashboard/funds/${slug}/team/${r.userId}`} style={{ textDecoration: "none", display: "block", background: "white", borderBottom: i < rows.length - 1 ? "1px solid #E5E5DE" : "none" }}>
              <div style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 38, height: 38, borderRadius: "50%", background: "#E7ECF3", color: "#00183A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, overflow: "hidden", flexShrink: 0 }}>
                  {r.headshotUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/team/${r.userId}/headshot`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    initials(r.fullName)
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...serif, fontSize: 15, color: "#00183A" }}>{r.fullName}</div>
                  <div style={{ fontSize: 12, color: "#9A9A8E", fontFamily: "system-ui, sans-serif" }}>{ROLE_LABEL[r.roleInFund] ?? r.roleInFund}</div>
                </div>
                <span style={{ color: "#C8C8C0" }}>›</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}
