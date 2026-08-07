import { db } from "@/db/client";
import { funds as fundsTable, users, fundMembers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";
import TeamMemberEditor from "@/components/TeamMemberEditor";

export const dynamic = "force-dynamic";

export default async function EditTeamMemberPage({ params }: { params: Promise<{ slug: string; userId: string }> }) {
  const { slug, userId } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db.select({ id: fundsTable.id }).from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  const rows = await db
    .select({
      userId: users.id,
      fullName: users.fullName,
      bio: users.bio,
      degree: users.degree,
      linkedinUrl: users.linkedinUrl,
      graduationYear: users.graduationYear,
      headshotUrl: users.headshotUrl,
      roleInFund: fundMembers.roleInFund,
    })
    .from(fundMembers)
    .innerJoin(users, eq(fundMembers.userId, users.id))
    .where(and(eq(fundMembers.fundId, fund.id), eq(fundMembers.userId, userId)))
    .limit(1);
  if (rows.length === 0) notFound();
  const m = rows[0];

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 700 }}>
      <Link href={`/dashboard/funds/${slug}/team`} style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
        ← Investment team
      </Link>
      <h1 style={{ ...serif, fontSize: 26, color: "#00183A", margin: "10px 0 22px", fontWeight: 400 }}>Edit team member</h1>
      <TeamMemberEditor
        fundSlug={slug}
        initial={{
          userId: m.userId,
          fullName: m.fullName,
          roleInFund: m.roleInFund as "pm" | "senior_analyst" | "analyst",
          degree: m.degree ?? "",
          linkedinUrl: m.linkedinUrl ?? "",
          graduationYear: m.graduationYear != null ? String(m.graduationYear) : "",
          hasHeadshot: Boolean(m.headshotUrl),
        }}
      />
    </main>
  );
}
