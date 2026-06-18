import { db } from "@/db/client";
import { funds as fundsTable, monthlyBriefings } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

function fmtPeriod(p: string): string {
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export default async function BriefingsListPage({ params }: PageProps) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db
    .select({ id: fundsTable.id, name: fundsTable.name, slug: fundsTable.slug })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  const rows = await db
    .select({
      id: monthlyBriefings.id,
      period: monthlyBriefings.period,
      title: monthlyBriefings.title,
      status: monthlyBriefings.status,
      updatedAt: monthlyBriefings.updatedAt,
    })
    .from(monthlyBriefings)
    .where(and(eq(monthlyBriefings.fundId, fund.id)))
    .orderBy(desc(monthlyBriefings.period));

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 820 }}>
      <Link href={`/dashboard/funds/${slug}`} style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
        ← {fund.name}
      </Link>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "10px 0 22px" }}>
        <h1 style={{ ...serif, fontSize: 26, color: "#00183A", margin: 0, fontWeight: 400 }}>Monthly briefings</h1>
        <Link
          href={`/dashboard/funds/${slug}/briefings/new`}
          style={{ fontSize: 12, color: "white", background: "#00183A", border: "1px solid #00183A", padding: "8px 14px", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}
        >
          New briefing →
        </Link>
      </div>

      {rows.length === 0 ? (
        <div style={{ border: "1px solid #D9D9D2", background: "white", padding: "18px 20px", fontSize: 13, color: "#6B6B66", fontFamily: "system-ui, sans-serif" }}>
          No briefings yet. Write the first monthly letter for {fund.name}.
        </div>
      ) : (
        <div style={{ border: "1px solid #E5E5DE" }}>
          {rows.map((r, i) => (
            <Link
              key={r.id}
              href={`/dashboard/funds/${slug}/briefings/${r.id}`}
              style={{ textDecoration: "none", display: "block", background: "white", borderBottom: i < rows.length - 1 ? "1px solid #E5E5DE" : "none" }}
            >
              <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...serif, fontSize: 16, color: "#00183A", marginBottom: 2 }}>{r.title}</div>
                  <div style={{ fontSize: 12, color: "#9A9A8E", fontFamily: "system-ui, sans-serif" }}>{fmtPeriod(r.period)}</div>
                </div>
                <span
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    fontWeight: 600,
                    color: r.status === "published" ? "#1F5C3A" : "#9A9A8E",
                  }}
                >
                  {r.status}
                </span>
                <span style={{ color: "#C8C8C0" }}>›</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
