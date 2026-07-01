import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";
import TeamMemberEditor from "@/components/TeamMemberEditor";

export const dynamic = "force-dynamic";

export default async function NewTeamMemberPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db.select({ name: fundsTable.name }).from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) notFound();

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 700 }}>
      <Link href={`/dashboard/funds/${slug}/team`} style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
        ← Investment team
      </Link>
      <h1 style={{ ...serif, fontSize: 26, color: "#00183A", margin: "10px 0 22px", fontWeight: 400 }}>Add team member</h1>
      <TeamMemberEditor fundSlug={slug} />
    </main>
  );
}
