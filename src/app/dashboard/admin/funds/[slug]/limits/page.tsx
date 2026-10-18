import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { funds } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { serif } from "@/lib/typography";
import LimitsEditor from "@/components/LimitsEditor";

export const dynamic = "force-dynamic";

export default async function FundLimitsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");
  if (user.role !== "admin") redirect("/dashboard");

  const [fund] = await db.select({ slug: funds.slug, name: funds.name }).from(funds).where(eq(funds.slug, slug)).limit(1);
  if (!fund) notFound();

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 900 }}>
      <Link href="/dashboard/admin" style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66", textDecoration: "none" }}>
        ← Admin
      </Link>
      <div style={{ marginTop: 16, marginBottom: 20 }}>
        <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B6B66", marginBottom: 6 }}>
          Admin · Limits
        </div>
        <h1 style={{ ...serif, fontWeight: 400, fontSize: 28, color: "#00183A", margin: 0 }}>{fund.name}</h1>
        <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66", marginTop: 6 }}>
          Hard limits block a trade. Soft limits warn and require a written justification. Changes apply to the next trade.
        </div>
      </div>
      <LimitsEditor slug={fund.slug} />
    </main>
  );
}
