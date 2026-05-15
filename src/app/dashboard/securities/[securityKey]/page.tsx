import { db } from "@/db/client";
import { securities, investableUniverses, funds as fundsTable, fundMembers } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { serif as serif_, numeric } from "@/lib/typography";

export const dynamic = "force-dynamic";

export default async function GlobalSecurityPage({
  params,
}: {
  params: Promise<{ securityKey: string }>;
}) {
  const { securityKey } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const lastDash = securityKey.lastIndexOf("-");
  if (lastDash < 0) notFound();
  const ticker = securityKey.slice(0, lastDash);
  const exchange = securityKey.slice(lastDash + 1).replace(/_/g, " ");

  const secRows = await db
    .select()
    .from(securities)
    .where(and(eq(securities.ticker, ticker), eq(securities.exchange, exchange)))
    .limit(1);
  if (secRows.length === 0) notFound();
  const security = secRows[0];

  // Which funds (user has access to) is this security in the universe of?
  let accessibleFunds;
  if (user.role === "admin") {
    accessibleFunds = await db
      .select({ fund: fundsTable })
      .from(investableUniverses)
      .innerJoin(fundsTable, eq(investableUniverses.fundId, fundsTable.id))
      .where(
        and(
          eq(investableUniverses.securityId, security.id),
          isNull(investableUniverses.removedDate),
          eq(fundsTable.isActive, true)
        )
      );
  } else {
    accessibleFunds = await db
      .select({ fund: fundsTable })
      .from(investableUniverses)
      .innerJoin(fundsTable, eq(investableUniverses.fundId, fundsTable.id))
      .innerJoin(
        fundMembers,
        and(
          eq(fundMembers.fundId, fundsTable.id),
          eq(fundMembers.userId, user.id),
          isNull(fundMembers.endDate)
        )
      )
      .where(
        and(
          eq(investableUniverses.securityId, security.id),
          isNull(investableUniverses.removedDate),
          eq(fundsTable.isActive, true)
        )
      );
  }

  const funds = accessibleFunds.map((r) => r.fund);

  // If only one accessible fund, redirect straight to fund-scoped view
  if (funds.length === 1) {
    redirect(`/dashboard/funds/${funds[0].slug}/securities/${securityKey}`);
  }

  return (
    <main style={{ padding: "28px 32px 64px" }}>
      <div style={{ marginBottom: 6 }}>
        <Link
          href="/dashboard"
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
            textDecoration: "none",
          }}
        >
          ← All funds
        </Link>
      </div>
      <div style={{ marginTop: 14 }}>
        <div
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#6B6B66",
            fontWeight: 500,
            marginBottom: 6,
          }}
        >
          {security.exchange} · {security.currency} · {security.gicsSector ?? "—"}
        </div>
        <h1
          style={{
            ...serif_,
            fontWeight: 400,
            fontSize: 28,
            color: "#00183A",
            margin: 0,
            letterSpacing: "-0.01em",
          }}
        >
          {security.name}
        </h1>
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 13,
            color: "#6B6B66",
            marginTop: 4,
          }}
        >
          {security.ticker} · {security.isin ?? "no ISIN"}
        </div>
      </div>

      {funds.length === 0 ? (
        <div
          style={{
            marginTop: 32,
            background: "#FBF3E5",
            border: "1px solid #E8D7AA",
            color: "#5A3F08",
            padding: "16px 20px",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          {security.ticker} is not in the investable universe of any fund you
          have access to.
        </div>
      ) : (
        <div style={{ marginTop: 28 }}>
          <div
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#6B6B66",
              fontWeight: 500,
              marginBottom: 12,
            }}
          >
            Available in these funds — pick one to continue
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 14,
            }}
          >
            {funds.map((f) => (
              <Link
                key={f.id}
                href={`/dashboard/funds/${f.slug}/securities/${securityKey}`}
                style={{
                  background: "white",
                  border: "1px solid #D9D9D2",
                  padding: "16px 18px",
                  textDecoration: "none",
                  color: "#0A0A0A",
                  fontFamily: "system-ui, sans-serif",
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "#6B6B66",
                    fontWeight: 500,
                    marginBottom: 4,
                  }}
                >
                  {f.baseCurrency}
                </div>
                <div
                  style={{
                    ...serif_,
                    fontSize: 15,
                    color: "#00183A",
                  }}
                >
                  {f.name}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
