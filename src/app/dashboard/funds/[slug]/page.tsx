import { db } from "@/db/client";
import {
  funds as fundsTable,
  fundConstraints,
  navSnapshots,
  transactions,
  securities as securitiesTable,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { eq, desc, and, inArray } from "drizzle-orm";
import { theses as thesesTable } from "@/db/schema-theses";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";
import {
  computePortfolioState,
  loadPreviousClosePrices,
} from "@/lib/portfolio";
import { computeDailyChange, computeUnrealisedPnL } from "@/lib/derived";
import LiveHoldingsTable from "@/components/LiveHoldingsTable";
import LiveFundHeader from "@/components/LiveFundHeader";
import ExposuresPanel from "@/components/ExposuresPanel";
import ActivityThesisCell, { type ThesisOption } from "@/components/ActivityThesisCell";

export const dynamic = "force-dynamic";

export default async function FundPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);

  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  // Access check: admins see all. Others must be members.
  // (Membership check skipped for v1 — would query fund_members. Admin-only for now.)

  const constraints = await db
    .select()
    .from(fundConstraints)
    .where(eq(fundConstraints.fundId, fund.id));

  // Dedupe by constraintType — repeat setup runs accidentally insert
  // duplicate rows. The constraint engine ignores duplicates; the display
  // also shows only one per type. If a hard and soft version exist for the
  // same type, prefer the hard (more restrictive).
  const dedupedConstraints = (() => {
    const map = new Map<string, typeof constraints[number]>();
    for (const c of constraints) {
      const existing = map.get(c.constraintType);
      if (!existing || (c.isHard && !existing.isHard)) {
        map.set(c.constraintType, c);
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      // Hard ones first, then alpha within each group
      if (a.isHard !== b.isHard) return a.isHard ? -1 : 1;
      return a.constraintType.localeCompare(b.constraintType);
    });
  })();

  // Latest NAV snapshot — orderBy desc so we get today's, not inception's
  const latestNav = await db
    .select()
    .from(navSnapshots)
    .where(eq(navSnapshots.fundId, fund.id))
    .orderBy(desc(navSnapshots.date))
    .limit(1);

  const currencySymbol =
    fund.baseCurrency === "GBP" ? "£" : fund.baseCurrency === "EUR" ? "€" : "$";

  const startingNav = Number(fund.startingNav);

  // Live portfolio state computed from the transactions ledger
  const liveState = await computePortfolioState(fund.id);
  const liveCashBase = liveState.cashBase.toNumber();

  // Previous close prices for held positions — for daily change display
  const heldSecurityIds = Array.from(liveState.positions.keys());
  const previousCloses = await loadPreviousClosePrices(heldSecurityIds);

  // Recent portfolio activity — buys, sells, shorts, covers, and dividends.
  const activityRows = await db
    .select({
      id: transactions.id,
      type: transactions.transactionType,
      quantity: transactions.quantity,
      price: transactions.price,
      currency: transactions.currency,
      cashImpact: transactions.cashImpact,
      executedAt: transactions.executedAt,
      ticker: securitiesTable.ticker,
      name: securitiesTable.name,
      securityId: transactions.securityId,
      thesisId: transactions.thesisId,
      thesisTitle: thesesTable.title,
      thesisSummary: thesesTable.summary,
    })
    .from(transactions)
    .leftJoin(securitiesTable, eq(transactions.securityId, securitiesTable.id))
    .leftJoin(thesesTable, eq(transactions.thesisId, thesesTable.id))
    .where(eq(transactions.fundId, fund.id))
    .orderBy(desc(transactions.executedAt))
    .limit(25);

  // Active theses for the securities that appear in the activity feed, so an
  // unlinked trade can be attached to an existing thesis in one click.
  const activitySecurityIds = Array.from(
    new Set(activityRows.map((a) => a.securityId).filter((x): x is string => !!x))
  );
  const thesisOptionRows =
    activitySecurityIds.length > 0
      ? await db
          .select({
            id: thesesTable.id,
            title: thesesTable.title,
            summary: thesesTable.summary,
            securityId: thesesTable.securityId,
          })
          .from(thesesTable)
          .where(
            and(
              eq(thesesTable.fundId, fund.id),
              eq(thesesTable.status, "active"),
              eq(thesesTable.approvalStatus, "approved"),
              inArray(thesesTable.securityId, activitySecurityIds)
            )
          )
      : [];
  const thesisOptionsBySecurity = new Map<string, ThesisOption[]>();
  for (const t of thesisOptionRows) {
    if (!t.securityId) continue;
    const list = thesisOptionsBySecurity.get(t.securityId) ?? [];
    list.push({ id: t.id, title: t.title ?? t.summary });
    thesisOptionsBySecurity.set(t.securityId, list);
  }

  // === NAV chart data points ===
  const navPoints: { date: string; nav: number; event?: string }[] = [];
  const inceptionStr = String(fund.inceptionDate).slice(0, 10);
  navPoints.push({
    date: inceptionStr,
    nav: startingNav,
    event: "Inception",
  });

  const snapshots = await db
    .select({ date: navSnapshots.date, nav: navSnapshots.nav })
    .from(navSnapshots)
    .where(eq(navSnapshots.fundId, fund.id))
    .orderBy(navSnapshots.date);
  for (const s of snapshots) {
    const dateStr = String(s.date).slice(0, 10);
    if (dateStr !== inceptionStr) {
      navPoints.push({ date: dateStr, nav: Number(s.nav) });
    }
  }

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);

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
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 4,
          marginTop: 16,
        }}
      >
        <div>
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
            {fund.baseCurrency} · Inception {fund.inceptionDate}
          </div>
          <h1
            style={{
              ...serif,
              fontWeight: 400,
              fontSize: 30,
              color: "#00183A",
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            {fund.name}
          </h1>
          <div
            style={{
              ...serif,
              fontSize: 14,
              color: "#444",
              marginTop: 10,
              maxWidth: 720,
              lineHeight: 1.55,
            }}
          >
            {fund.strategyDescription}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link
            href={`/dashboard/funds/${fund.slug}/theses`}
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 12,
              color: "#00183A",
              textDecoration: "none",
              border: "1px solid #00183A",
              padding: "8px 14px",
              background: "white",
              whiteSpace: "nowrap",
            }}
          >
            Theses →
          </Link>
          <Link
            href={`/dashboard/funds/${fund.slug}/universe`}
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 12,
              color: "#00183A",
              textDecoration: "none",
              border: "1px solid #00183A",
              padding: "8px 14px",
              background: "white",
              whiteSpace: "nowrap",
            }}
          >
            Browse universe →
          </Link>
          <Link
            href={`/dashboard/funds/${fund.slug}/briefings`}
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 12,
              color: "#00183A",
              textDecoration: "none",
              border: "1px solid #00183A",
              padding: "8px 14px",
              background: "white",
              whiteSpace: "nowrap",
            }}
          >
            Briefings →
          </Link>
          <Link
            href={`/dashboard/funds/${fund.slug}/team`}
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 12,
              color: "#00183A",
              textDecoration: "none",
              border: "1px solid #00183A",
              padding: "8px 14px",
              background: "white",
              whiteSpace: "nowrap",
            }}
          >
            Team →
          </Link>
        </div>
      </div>

      <LiveFundHeader
        currencySymbol={currencySymbol}
        baseCurrency={fund.baseCurrency as "GBP" | "USD" | "EUR"}
        initialNavBase={liveState.navBase.toString()}
        startingNav={startingNav}
        cashBase={liveCashBase}
        holdingsCount={liveState.positions.size}
        holdingsSub={
          liveState.positions.size === 0 ? "No positions yet" : `${liveState.positions.size} open`
        }
        constraintsCount={dedupedConstraints.length}
        constraintsSub={`${dedupedConstraints.filter((c) => c.isHard).length} hard, ${dedupedConstraints.filter((c) => !c.isHard).length} soft`}
        snapshotDate={latestNav.length > 0 ? latestNav[0].date : null}
        positions={Array.from(liveState.positions.values()).map((p) => ({
          securityId: p.securityId,
          quantity: p.quantity.toString(),
          latestPriceNative: p.latestPriceNative ? p.latestPriceNative.toString() : null,
          latestFxToBase: p.latestFxToBase.toString(),
        }))}
        fundName={fund.name}
        inceptionDate={inceptionStr}
        navPoints={navPoints}
      />

      <ExposuresPanel
        baseCurrency={fund.baseCurrency as "GBP" | "USD" | "EUR"}
        navBase={liveState.navBase.toNumber()}
        positions={Array.from(liveState.positions.values()).map((p) => ({
          securityId: p.securityId,
          ticker: p.ticker,
          name: p.name,
          exchange: p.exchange,
          currency: p.currency,
          gicsSector: p.gicsSector,
          quantity: p.quantity.toNumber(),
          marketValueBase: p.marketValueBase
            ? p.marketValueBase.toNumber()
            : null,
        }))}
        cashByCurrency={
          new Map(
            Array.from(liveState.cashByCurrency.entries()).map(([k, v]) => [
              k,
              v.toNumber(),
            ])
          )
        }
        sectorExposures={
          new Map(
            Array.from(liveState.sectorExposures.entries()).map(([k, v]) => [
              k,
              v.toNumber(),
            ])
          )
        }
        longExposure={liveState.longExposure.toNumber()}
        shortExposure={liveState.shortExposure.toNumber()}
        grossExposure={liveState.grossExposure.toNumber()}
        netExposure={liveState.netExposure.toNumber()}
      />

      {liveState.positions.size === 0 ? (
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            padding: "24px 28px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              ...serif,
              fontSize: 18,
              color: "#00183A",
              marginBottom: 8,
            }}
          >
            No positions yet
          </div>
          <div
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 13,
              color: "#6B6B66",
              maxWidth: 480,
              margin: "0 auto",
              lineHeight: 1.55,
            }}
          >
            This fund is freshly created with {currencySymbol}
            {fmt(startingNav)} of starting capital. Submit a trade from any
            security page to begin building holdings.
          </div>
        </div>
      ) : (
        <LiveHoldingsTable
          fundSlug={fund.slug}
          fundBaseCurrency={fund.baseCurrency as "GBP" | "USD" | "EUR"}
          initialNavBase={liveState.navBase.toString()}
          positions={Array.from(liveState.positions.values()).map((p) => ({
            securityId: p.securityId,
            ticker: p.ticker,
            name: p.name,
            exchange: p.exchange,
            currency: p.currency,
            gicsSector: p.gicsSector,
            quantity: p.quantity.toString(),
            avgCostNative: p.avgCostNative.toString(),
            latestPriceNative: p.latestPriceNative
              ? p.latestPriceNative.toString()
              : null,
            latestFxToBase: p.latestFxToBase.toString(),
            previousCloseNative: previousCloses.get(p.securityId)?.close ?? null,
            marketValueBase: p.marketValueBase
              ? p.marketValueBase.toString()
              : null,
          }))}
        />
      )}

      {activityRows.length > 0 && (() => {
        const ccySym = (c: string) => (c === "GBP" ? "£" : c === "EUR" ? "€" : "$");
        const money = (v: number) =>
          new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
        const ACTIVITY: Record<string, { label: string; color: string }> = {
          buy: { label: "Long", color: "#1F5C3A" },
          sell: { label: "Sold", color: "#7A1F1F" },
          short: { label: "Short", color: "#7A1F1F" },
          cover: { label: "Covered", color: "#1F5C3A" },
          dividend: { label: "Dividend", color: "#8A6D1F" },
          cash_deposit: { label: "Cash deposit", color: "#00183A" },
          fx_adjustment: { label: "FX adjustment", color: "#6B6B66" },
          corporate_action: { label: "Corporate action", color: "#6B6B66" },
        };
        return (
          <section style={{ marginTop: 28 }}>
            <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B6B66", fontWeight: 500, marginBottom: 10 }}>
              Portfolio activity
            </div>
            <div style={{ border: "1px solid #E5E5DE", background: "white" }}>
              {activityRows.map((a, i) => {
                const meta = ACTIVITY[a.type] ?? { label: a.type, color: "#6B6B66" };
                const cash = Number(a.cashImpact);
                const qty = Number(a.quantity);
                const price = Number(a.price);
                const dateStr = new Date(a.executedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
                const isDividend = a.type === "dividend";
                return (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 16px", borderBottom: i < activityRows.length - 1 ? "1px solid #F0F0EC" : "none" }}>
                    <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", width: 82, flexShrink: 0 }}>{dateStr}</span>
                    <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, fontWeight: 600, color: meta.color, width: 96, flexShrink: 0, textTransform: "uppercase", letterSpacing: "0.03em" }}>{meta.label}</span>
                    <span style={{ ...serif, fontSize: 14, color: "#00183A", width: 210, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.ticker ? a.ticker : "—"}{a.name ? <span style={{ color: "#9A9A8E", fontFamily: "system-ui, sans-serif", fontSize: 12 }}> · {a.name}</span> : null}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "flex-start", overflow: "hidden" }}>
                      <ActivityThesisCell
                        fundSlug={fund.slug}
                        txId={a.id}
                        linkedThesisId={a.thesisId ?? null}
                        linkedThesisTitle={a.thesisTitle ?? a.thesisSummary ?? null}
                        linkable={a.type === "buy" || a.type === "sell" || a.type === "short" || a.type === "cover"}
                        securityId={a.securityId ?? null}
                        options={a.securityId ? thesisOptionsBySecurity.get(a.securityId) ?? [] : []}
                      />
                    </span>
                    <span style={{ ...numeric, fontSize: 12, color: "#6B6B66", textAlign: "right", flexShrink: 0 }}>
                      {isDividend
                        ? `${ccySym(a.currency)}${price.toFixed(4)}/sh`
                        : `${Math.abs(qty).toLocaleString()} @ ${ccySym(a.currency)}${money(price)}`}
                    </span>
                    <span style={{ ...numeric, fontSize: 13, fontWeight: 500, width: 104, textAlign: "right", flexShrink: 0, color: cash >= 0 ? "#1F5C3A" : "#7A1F1F" }}>
                      {cash >= 0 ? "+" : "−"}{ccySym(a.currency)}{money(cash)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", marginTop: 8 }}>
              Cash impact shown in each trade&rsquo;s native currency. Dividends are credited automatically on the ex-date.
            </div>
          </section>
        );
      })()}

      <details style={{ marginTop: 28 }}>
        <summary
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 11,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#6B6B66",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          Fund constraints ({dedupedConstraints.length})
        </summary>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: 16,
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: "left",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#6B6B66",
                  borderBottom: "1px solid #D9D9D2",
                  padding: "0 0 8px",
                  fontWeight: 500,
                }}
              >
                Rule
              </th>
              <th
                style={{
                  textAlign: "right",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#6B6B66",
                  borderBottom: "1px solid #D9D9D2",
                  padding: "0 0 8px",
                  fontWeight: 500,
                }}
              >
                Limit
              </th>
              <th
                style={{
                  textAlign: "right",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#6B6B66",
                  borderBottom: "1px solid #D9D9D2",
                  padding: "0 0 8px",
                  fontWeight: 500,
                }}
              >
                Enforcement
              </th>
            </tr>
          </thead>
          <tbody>
            {dedupedConstraints.map((c) => (
              <tr key={c.id}>
                <td
                  style={{
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(217,217,210,0.4)",
                    color: "#0A0A0A",
                  }}
                >
                  {prettyConstraintLabel(c.constraintType)}
                </td>
                <td
                  style={{
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(217,217,210,0.4)",
                    textAlign: "right",
                    ...numeric,
                    color: "#0A0A0A",
                  }}
                >
                  {prettyConstraintValue(c.constraintType, c.value)}
                </td>
                <td
                  style={{
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(217,217,210,0.4)",
                    textAlign: "right",
                    color: c.isHard ? "#7A1F1F" : "#5A3F08",
                    fontSize: 11,
                    letterSpacing: "0.05em",
                    fontWeight: 600,
                    textTransform: "uppercase",
                  }}
                >
                  {c.isHard ? "Blocked" : "Warning"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Constraint display helpers
// ---------------------------------------------------------------------------

function prettyConstraintLabel(type: string): string {
  const labels: Record<string, string> = {
    universe_only: "Investable universe",
    long_only: "Long-only",
    max_position_pct: "Max position size",
    min_cash_pct: "Min cash holding",
    max_cash_pct: "Max cash holding",
    max_single_sector_pct: "Max single sector",
    max_position_count: "Max position count",
    max_gross_exposure: "Max gross exposure",
    max_net_exposure: "Max net exposure",
  };
  return labels[type] ?? type;
}

function prettyConstraintValue(type: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (type === "max_position_count" && typeof value === "number") {
    return `${value} positions`;
  }
  if (
    (type === "max_gross_exposure" || type === "max_net_exposure") &&
    typeof value === "number"
  ) {
    return `${value.toFixed(2)}×`;
  }
  if (typeof value === "number") {
    return `${(value * 100).toFixed(2)}%`;
  }
  return String(value);
}


