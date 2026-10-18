import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { funds } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { isFundPm } from "@/lib/fund-role";
import { serif } from "@/lib/typography";
import BasketTrader from "@/components/BasketTrader";

export const dynamic = "force-dynamic";

export default async function BasketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");
  const [fund] = await db.select({ id: funds.id, slug: funds.slug, name: funds.name }).from(funds).where(eq(funds.slug, slug)).limit(1);
  if (!fund) notFound();
  if (!(await isFundPm(user, fund.id))) redirect(`/dashboard/funds/${fund.slug}`);

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 1000 }}>
      <Link href={`/dashboard/funds/${fund.slug}`} style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66", textDecoration: "none" }}>
        ← {fund.name}
      </Link>
      <div style={{ marginTop: 16, marginBottom: 20 }}>
        <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B6B66", marginBottom: 6 }}>
          Basket order
        </div>
        <h1 style={{ ...serif, fontWeight: 400, fontSize: 28, color: "#00183A", margin: 0 }}>Submit several orders at once</h1>
        <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66", marginTop: 6 }}>
          Orders queue for the next opening print and fill sales first. Each is checked against the book the earlier ones leave.
        </div>
      </div>
      <BasketTrader fundSlug={fund.slug} fundName={fund.name} />
    </main>
  );
}
