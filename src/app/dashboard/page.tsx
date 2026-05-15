import { db } from "@/db/client";
import { funds as fundsTable, fundMembers } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { eq, isNull, and } from "drizzle-orm";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardHome() {
  const user = await getOrCreateUser();
  if (!user) return null;

  // Admins see all funds. Others see only funds they're a member of.
  let visibleFunds;
  if (user.role === "admin") {
    visibleFunds = await db.select().from(fundsTable).where(eq(fundsTable.isActive, true));
  } else {
    const memberships = await db
      .select({ fund: fundsTable })
      .from(fundMembers)
      .innerJoin(fundsTable, eq(fundMembers.fundId, fundsTable.id))
      .where(
        and(
          eq(fundMembers.userId, user.id),
          isNull(fundMembers.endDate),
          eq(fundsTable.isActive, true)
        )
      );
    visibleFunds = memberships.map((m) => m.fund);
  }

  return (
    <main style={{ padding: "32px 32px 64px" }}>
      <div style={{ marginBottom: 6 }}>
        <div
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#6B6B66",
            fontWeight: 500,
          }}
        >
          Overview
        </div>
      </div>
      <h1
        style={{
          fontFamily: "Georgia, 'Source Serif Pro', serif",
          fontWeight: 400,
          fontSize: 32,
          color: "#00183A",
          margin: "4px 0 8px",
          letterSpacing: "-0.01em",
        }}
      >
        Funds
      </h1>
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          color: "#6B6B66",
          marginBottom: 32,
        }}
      >
        {user.role === "admin"
          ? `Showing all ${visibleFunds.length} funds (admin view)`
          : visibleFunds.length === 0
            ? "You haven't been assigned to any funds yet. Ask an admin to add you."
            : `You're assigned to ${visibleFunds.length} fund${visibleFunds.length === 1 ? "" : "s"}`}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        {visibleFunds.map((fund) => (
          <Link
            key={fund.id}
            href={`/dashboard/funds/${fund.slug}`}
            style={{
              background: "white",
              border: "1px solid #D9D9D2",
              padding: "20px 22px",
              borderRadius: 4,
              textDecoration: "none",
              color: "#0A0A0A",
              display: "block",
              transition: "border-color 0.15s ease",
            }}
          >
            <div
              style={{
                fontFamily: "system-ui, sans-serif",
                fontSize: 10,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "#6B6B66",
                fontWeight: 500,
                marginBottom: 6,
              }}
            >
              {fund.baseCurrency}
            </div>
            <div
              style={{
                fontFamily: "Georgia, serif",
                fontSize: 18,
                color: "#00183A",
                marginBottom: 8,
                lineHeight: 1.25,
              }}
            >
              {fund.name}
            </div>
            <div
              style={{
                fontFamily: "system-ui, sans-serif",
                fontSize: 12,
                color: "#6B6B66",
                lineHeight: 1.5,
                marginBottom: 14,
              }}
            >
              {fund.strategyDescription}
            </div>
            <div
              style={{
                fontFamily: "system-ui, sans-serif",
                fontSize: 11,
                color: "#00183A",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              View portfolio →
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
