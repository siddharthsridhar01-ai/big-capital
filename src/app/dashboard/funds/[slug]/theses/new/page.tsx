import { db } from "@/db/client";
import { funds as fundsTable, securities, investableUniverses } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { eq, and, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";
import NewThesisForm from "@/components/NewThesisForm";

export const dynamic = "force-dynamic";

export default async function NewThesisPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ securityId?: string; linkTxId?: string }>;
}) {
  const { slug } = await params;
  const { securityId: securityIdParam, linkTxId: linkTxIdParam } = await searchParams;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  // Pull the fund's investable universe so we can offer a dropdown
  // (rather than free-text security search — at thesis-creation time,
  // every option must already be in the universe)
  const universeRows = await db
    .select({
      securityId: securities.id,
      ticker: securities.ticker,
      name: securities.name,
      exchange: securities.exchange,
      currency: securities.currency,
      gicsSector: securities.gicsSector,
    })
    .from(investableUniverses)
    .innerJoin(securities, eq(investableUniverses.securityId, securities.id))
    .where(
      and(
        eq(investableUniverses.fundId, fund.id),
        isNull(investableUniverses.removedDate)
      )
    );

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 820 }}>
      <div style={{ marginBottom: 6 }}>
        <Link
          href={`/dashboard/funds/${fund.slug}/theses`}
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
            textDecoration: "none",
          }}
        >
          ← Theses
        </Link>
      </div>
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#6B6B66",
          fontWeight: 500,
          marginTop: 12,
        }}
      >
        {fund.name}
      </div>
      <h1
        style={{
          ...serif,
          fontWeight: 400,
          fontSize: 26,
          color: "#00183A",
          margin: "4px 0 24px",
          letterSpacing: "-0.01em",
        }}
      >
        New investment thesis
      </h1>

      <NewThesisForm
        fundSlug={fund.slug}
        fundBaseCurrency={fund.baseCurrency as "GBP" | "USD" | "EUR"}
        initialSecurityId={
          securityIdParam && universeRows.some((u) => u.securityId === securityIdParam)
            ? securityIdParam
            : undefined
        }
        linkTxId={linkTxIdParam || undefined}
        universe={universeRows.map((u) => ({
          securityId: u.securityId,
          ticker: u.ticker,
          name: u.name,
          exchange: u.exchange,
          currency: u.currency as "GBP" | "USD" | "EUR",
          gicsSector: u.gicsSector,
        }))}
      />
    </main>
  );
}
