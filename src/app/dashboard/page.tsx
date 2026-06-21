import { db } from "@/db/client";
import {
  funds as fundsTable,
  fundMembers,
  navSnapshots,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { eq, isNull, and } from "drizzle-orm";
import Link from "next/link";
import { serif as serif_, numeric } from "@/lib/typography";
import { computePortfolioState } from "@/lib/portfolio";
import Sparkline from "@/components/Sparkline";

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

  // Compute live summary stats per fund in parallel — each Promise here runs
  // computePortfolioState (which fetches live Yahoo prices, batched + cached)
  // and pulls NAV snapshots for the sparkline.
  const summaries = await Promise.all(
    visibleFunds.map(async (fund) => {
      const state = await computePortfolioState(fund.id);
      const snapshots = await db
        .select({ date: navSnapshots.date, nav: navSnapshots.nav })
        .from(navSnapshots)
        .where(eq(navSnapshots.fundId, fund.id))
        .orderBy(navSnapshots.date);
      const startingNav = Number(fund.startingNav);
      const liveNav = state.navBase.toNumber();
      const sinceInceptionPct = ((liveNav - startingNav) / startingNav) * 100;
      // Build sparkline points: inception, every snapshot, and live
      const points: { nav: number }[] = [{ nav: startingNav }];
      for (const s of snapshots) points.push({ nav: Number(s.nav) });
      points.push({ nav: liveNav });
      return {
        fundId: fund.id,
        liveNav,
        startingNav,
        sinceInceptionPct,
        points,
      };
    })
  );
  const summaryById = new Map(summaries.map((s) => [s.fundId, s]));

  const currencySymbol = (ccy: string) =>
    ccy === "GBP" ? "£" : ccy === "EUR" ? "€" : "$";
  const fmtMoney = (n: number) =>
    new Intl.NumberFormat("en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);

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
          ...serif_,
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
          gridAutoRows: "auto",
          alignItems: "stretch",
          gap: 16,
        }}
      >
        {visibleFunds.map((fund) => {
          const s = summaryById.get(fund.id);
          const isUp = (s?.sinceInceptionPct ?? 0) >= 0;
          const direction: "up" | "down" | "flat" =
            !s
              ? "flat"
              : s.sinceInceptionPct > 0
                ? "up"
                : s.sinceInceptionPct < 0
                  ? "down"
                  : "flat";
          return (
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
                display: "flex",
                flexDirection: "column",
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
                  ...serif_,
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
                  flexGrow: 1,
                }}
              >
                {fund.strategyDescription}
              </div>
              {s ? (
                <>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <div
                      style={{
                        ...numeric,
                        fontSize: 18,
                        color: "#00183A",
                        fontWeight: 500,
                      }}
                    >
                      {currencySymbol(fund.baseCurrency)}
                      {fmtMoney(s.liveNav)}
                    </div>
                    <div
                      style={{
                        ...numeric,
                        fontSize: 12,
                        color: isUp ? "#1F5C3A" : "#7A1F1F",
                        fontWeight: 500,
                      }}
                    >
                      {isUp ? "+" : "−"}
                      {Math.abs(s.sinceInceptionPct).toFixed(2)}%
                    </div>
                  </div>
                  <Sparkline points={s.points} direction={direction} height={32} />
                </>
              ) : null}
              <div
                style={{
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 11,
                  color: "#00183A",
                  textDecoration: "underline",
                  textUnderlineOffset: 3,
                  marginTop: 12,
                }}
              >
                View portfolio →
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
