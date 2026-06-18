import { db } from "@/db/client";
import {
  funds as fundsTable,
  securities,
  investableUniverses,
  prices,
  positions,
  transactions,
  fxRates,
  users,
} from "@/db/schema";
import { theses, thesisPostMortems } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import TradeTicket from "@/components/TradeTicket";
import { serif as serif_, numeric } from "@/lib/typography";
import { computePortfolioState, staticFxFallback } from "@/lib/portfolio";
import { computeDailyChange } from "@/lib/derived";
import LivePriceHeadline from "@/components/LivePriceHeadline";
import Decimal from "decimal.js";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string; securityKey: string }>;
}

export default async function FundSecurityPage({ params }: PageProps) {
  const { slug, securityKey } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  // Parse "TICKER-EXCHANGE" from securityKey
  const lastDash = securityKey.lastIndexOf("-");
  if (lastDash < 0) notFound();
  const ticker = securityKey.slice(0, lastDash);
  const exchange = securityKey.slice(lastDash + 1).replace(/_/g, " ");

  // Look up fund
  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  // Look up security
  const secRows = await db
    .select()
    .from(securities)
    .where(
      and(eq(securities.ticker, ticker), eq(securities.exchange, exchange))
    )
    .limit(1);
  if (secRows.length === 0) notFound();
  const security = secRows[0];

  // Confirm it's in the fund's universe
  const universeRows = await db
    .select()
    .from(investableUniverses)
    .where(
      and(
        eq(investableUniverses.fundId, fund.id),
        eq(investableUniverses.securityId, security.id),
        isNull(investableUniverses.removedDate)
      )
    )
    .limit(1);
  const inUniverse = universeRows.length > 0;

  // Latest price
  const latestPriceRows = await db
    .select()
    .from(prices)
    .where(eq(prices.securityId, security.id))
    .orderBy(desc(prices.date))
    .limit(1);
  const latestPrice = latestPriceRows[0];

  // Recent price history (last 30 entries)
  const priceHistory = await db
    .select()
    .from(prices)
    .where(eq(prices.securityId, security.id))
    .orderBy(desc(prices.date))
    .limit(30);

  // Existing position in this fund for this security
  const positionRows = await db
    .select()
    .from(positions)
    .where(
      and(eq(positions.fundId, fund.id), eq(positions.securityId, security.id))
    )
    .orderBy(desc(positions.openedAt))
    .limit(1);
  const currentPosition = positionRows[0];

  // Theses written on this ticker in this fund (institutional memory).
  // Newest first; left-join the post-mortem so we can show the outcome.
  const thesisHistory = await db
    .select({
      id: theses.id,
      status: theses.status,
      conviction: theses.conviction,
      direction: theses.direction,
      summary: theses.summary,
      openedAt: theses.openedAt,
      closedAt: theses.closedAt,
      authorName: users.fullName,
      outcome: thesisPostMortems.outcome,
    })
    .from(theses)
    .innerJoin(users, eq(theses.authorUserId, users.id))
    .leftJoin(thesisPostMortems, eq(thesisPostMortems.thesisId, theses.id))
    .where(and(eq(theses.fundId, fund.id), eq(theses.securityId, security.id)))
    .orderBy(desc(theses.openedAt))
    .limit(12);

  // Recent transactions in this fund × security
  const txnHistory = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.fundId, fund.id),
        eq(transactions.securityId, security.id)
      )
    )
    .orderBy(desc(transactions.executedAt))
    .limit(10);

  // === Live portfolio state from transactions ledger ===
  const portfolioState = await computePortfolioState(fund.id);
  const livePosition = portfolioState.positions.get(security.id);
  const currentPositionQuantity = livePosition?.quantity ?? new Decimal(0);
  const currentPositionWeight =
    livePosition?.marketValueBase && !portfolioState.navBase.isZero()
      ? livePosition.marketValueBase
          .abs()
          .dividedBy(portfolioState.navBase)
      : new Decimal(0);
  const currentSectorWeight = security.gicsSector
    ? portfolioState.sectorExposures.get(security.gicsSector) ??
      new Decimal(0)
    : new Decimal(0);

  // FX rate to convert security ccy → fund base ccy
  let fxRateToBase = "1";
  if (security.currency !== fund.baseCurrency) {
    try {
      fxRateToBase = staticFxFallback(
        security.currency as Parameters<typeof staticFxFallback>[0],
        fund.baseCurrency as Parameters<typeof staticFxFallback>[1]
      ).toString();
    } catch {
      fxRateToBase = "1";
    }
  }

  const currencySymbol =
    security.currency === "GBP"
      ? "£"
      : security.currency === "EUR"
        ? "€"
        : "$";

  const fmt = (n: string | number) =>
    new Intl.NumberFormat("en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(n));

  return (
    <main style={{ padding: "28px 32px 64px" }}>
      <div style={{ marginBottom: 6 }}>
        <Link
          href={`/dashboard/funds/${slug}`}
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
            textDecoration: "none",
          }}
        >
          ← {fund.name}
        </Link>
      </div>
      <div
        style={{
          marginTop: 14,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 24,
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
            {security.exchange} · {security.currency} ·{" "}
            {security.gicsSector ?? "—"}
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
        <div style={{ textAlign: "right" }}>
          {latestPrice ? (
            <LivePriceHeadline
              securityId={security.id}
              snapshotClosePrice={latestPrice.closePrice}
              snapshotPreviousClose={priceHistory[1]?.closePrice ?? null}
              snapshotDate={latestPrice.date}
              currency={security.currency}
            />
          ) : (
            <div
              style={{
                fontFamily: "system-ui, sans-serif",
                fontSize: 12,
                color: "#9A9A8E",
              }}
            >
              No price data
            </div>
          )}
        </div>
      </div>

      {!inUniverse && (
        <div
          style={{
            marginTop: 24,
            background: "#FBF3E5",
            border: "1px solid #E8D7AA",
            color: "#5A3F08",
            padding: "12px 16px",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          ⚠ This security is not in {fund.name}'s investable universe. It
          cannot be traded by this fund.
        </div>
      )}

      <div
        style={{
          marginTop: 28,
          display: "grid",
          gridTemplateColumns: "2fr 1fr",
          gap: 24,
        }}
      >
        {/* Left column: position info + trade ticket placeholder */}
        <div>
          <SectionLabel>Position in this fund</SectionLabel>
          {livePosition ? (
            <div
              style={{
                background: "white",
                border: "1px solid #D9D9D2",
                padding: "16px 20px",
                fontFamily: "system-ui, sans-serif",
                fontSize: 13,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 14,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "#6B6B66",
                      marginBottom: 2,
                    }}
                  >
                    Quantity
                  </div>
                  <div style={{ ...numeric, fontSize: 18, color: livePosition.quantity.lt(0) ? "#7A1F1F" : "#00183A" }}>
                    {livePosition.quantity.toFixed(0)}
                    <span style={{ fontSize: 11, color: "#6B6B66", marginLeft: 6 }}>
                      {livePosition.quantity.lt(0) ? "short" : "long"}
                    </span>
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "#6B6B66",
                      marginBottom: 2,
                    }}
                  >
                    Average cost
                  </div>
                  <div style={{ ...numeric, fontSize: 18, color: "#00183A" }}>
                    {currencySymbol}
                    {fmt(livePosition.avgCostNative.toString())}
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "#6B6B66",
                      marginBottom: 2,
                    }}
                  >
                    Market value (base)
                  </div>
                  <div style={{ ...numeric, fontSize: 14, color: "#00183A" }}>
                    {livePosition.marketValueBase
                      ? `${fund.baseCurrency === "GBP" ? "£" : fund.baseCurrency === "EUR" ? "€" : "$"}${fmt(livePosition.marketValueBase.toString())}`
                      : "—"}
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "#6B6B66",
                      marginBottom: 2,
                    }}
                  >
                    Weight (NAV)
                  </div>
                  <div style={{ ...numeric, fontSize: 14, color: "#00183A" }}>
                    {currentPositionWeight.times(100).toFixed(2)}%
                  </div>
                </div>
              </div>
              {currentPosition && (
                <div style={{ marginTop: 10, color: "#6B6B66", fontSize: 11 }}>
                  Opened{" "}
                  {new Date(currentPosition.openedAt).toLocaleDateString(
                    "en-GB"
                  )}
                </div>
              )}
            </div>
          ) : (
            <div
              style={{
                background: "white",
                border: "1px solid #D9D9D2",
                padding: "16px 20px",
                fontFamily: "system-ui, sans-serif",
                fontSize: 13,
                color: "#6B6B66",
              }}
            >
              {fund.name} has no current position in {security.ticker}.
            </div>
          )}

          <div style={{ marginTop: 28 }}>
            <SectionLabel>Trade ticket</SectionLabel>
            {!inUniverse ? (
              <div
                style={{
                  background: "white",
                  border: "1px solid #D9D9D2",
                  padding: "16px 20px",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 13,
                  color: "#6B6B66",
                }}
              >
                Cannot trade — this security is not in {fund.name}'s
                investable universe.
              </div>
            ) : !latestPrice ? (
              <div
                style={{
                  background: "white",
                  border: "1px solid #D9D9D2",
                  padding: "16px 20px",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 13,
                  color: "#6B6B66",
                }}
              >
                Cannot construct trade — no price data available for{" "}
                {security.ticker}.
              </div>
            ) : (
              <TradeTicket
                fund={{
                  id: fund.id,
                  name: fund.name,
                  slug: fund.slug,
                  baseCurrency: fund.baseCurrency,
                  startingNav: fund.startingNav,
                  tradingFeesBps: fund.tradingFeesBps,
                  isLongShort: fund.slug === "long-short",
                }}
                security={{
                  id: security.id,
                  ticker: security.ticker,
                  exchange: security.exchange,
                  name: security.name,
                  currency: security.currency,
                  gicsSector: security.gicsSector,
                }}
                latestPrice={latestPrice.closePrice}
                fxRateToBase={fxRateToBase}
                portfolioSnapshot={{
                  nav: portfolioState.navBase.toString(),
                  cashBalance: portfolioState.cashBase.toString(),
                  currentPositionWeight: currentPositionWeight.toString(),
                  currentPositionQuantity: currentPositionQuantity.toString(),
                  currentSectorWeight: currentSectorWeight.toString(),
                  positionCount: portfolioState.positions.size,
                  grossExposure: portfolioState.grossExposure.toString(),
                  netExposure: portfolioState.netExposure.toString(),
                }}
              />
            )}
          </div>
        </div>

        {/* Right column: price history + transaction history */}
        <div>
          <SectionLabel>Recent prices</SectionLabel>
          {priceHistory.length > 0 ? (
            <div
              style={{
                background: "white",
                border: "1px solid #D9D9D2",
                fontFamily: "system-ui, sans-serif",
                fontSize: 12,
                maxHeight: 260,
                overflowY: "auto",
              }}
            >
              {priceHistory.map((p, idx) => (
                <div
                  key={p.date}
                  style={{
                    padding: "8px 14px",
                    display: "flex",
                    justifyContent: "space-between",
                    borderBottom:
                      idx < priceHistory.length - 1
                        ? "1px solid rgba(217,217,210,0.4)"
                        : "none",
                  }}
                >
                  <span style={{ color: "#6B6B66" }}>{p.date}</span>
                  <span
                    style={{
                      ...numeric,
                      color: "#00183A",
                    }}
                  >
                    {currencySymbol}
                    {fmt(p.closePrice)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                background: "white",
                border: "1px solid #D9D9D2",
                padding: "14px 18px",
                fontFamily: "system-ui, sans-serif",
                fontSize: 12,
                color: "#6B6B66",
              }}
            >
              No price history yet.
            </div>
          )}

          <div style={{ marginTop: 24 }}>
            <SectionLabel>Trade history in this fund</SectionLabel>
            {txnHistory.length > 0 ? (
              <div
                style={{
                  background: "white",
                  border: "1px solid #D9D9D2",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 12,
                }}
              >
                {txnHistory.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      padding: "10px 14px",
                      borderBottom: "1px solid rgba(217,217,210,0.4)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span
                        style={{
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          fontSize: 10,
                          color:
                            t.transactionType === "buy"
                              ? "#1F5C3A"
                              : "#7A1F1F",
                          fontWeight: 600,
                        }}
                      >
                        {t.transactionType}
                      </span>
                      <span style={{ color: "#6B6B66", fontSize: 11 }}>
                        {new Date(t.executedAt).toLocaleDateString("en-GB")}
                      </span>
                    </div>
                    <div
                      style={{
                        ...numeric,
                        fontSize: 13,
                        color: "#00183A",
                        marginTop: 2,
                      }}
                    >
                      {Number(t.quantity).toLocaleString()} @{" "}
                      {currencySymbol}
                      {fmt(t.price)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  background: "white",
                  border: "1px solid #D9D9D2",
                  padding: "14px 18px",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 12,
                  color: "#6B6B66",
                }}
              >
                No trades yet in {fund.name} for this security.
              </div>
            )}
          </div>

          <div style={{ marginTop: 24 }}>
            <SectionLabel>Theses on this ticker</SectionLabel>
            {thesisHistory.length > 0 ? (
              <div
                style={{
                  background: "white",
                  border: "1px solid #D9D9D2",
                  fontFamily: "system-ui, sans-serif",
                }}
              >
                {thesisHistory.map((th, idx) => {
                  const stt = thStatusStyle(th.status);
                  const oc = th.outcome ? outcomeStyle(th.outcome) : null;
                  const excerpt =
                    th.summary.length > 130
                      ? th.summary.slice(0, 130).trimEnd() + "…"
                      : th.summary;
                  return (
                    <Link
                      key={th.id}
                      href={`/dashboard/funds/${slug}/theses/${th.id}`}
                      style={{ textDecoration: "none", display: "block" }}
                    >
                      <div
                        style={{
                          padding: "11px 14px",
                          borderBottom:
                            idx < thesisHistory.length - 1
                              ? "1px solid rgba(217,217,210,0.4)"
                              : "none",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                            marginBottom: 4,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 10,
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                              fontWeight: 600,
                              color: stt.color,
                            }}
                          >
                            {stt.label}
                          </span>
                          <span style={{ ...numeric, fontSize: 11, color: "#9A9A8E" }}>
                            {new Date(th.openedAt).toLocaleDateString("en-GB", {
                              month: "short",
                              year: "numeric",
                            })}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "#0A0A0A",
                            lineHeight: 1.45,
                            wordBreak: "break-word",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {excerpt}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: "#9A9A8E",
                            marginTop: 5,
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ textTransform: "capitalize" }}>
                            {th.conviction} conviction
                          </span>
                          {th.direction ? (
                            <>
                              <span>·</span>
                              <span style={{ textTransform: "capitalize" }}>
                                {th.direction}
                              </span>
                            </>
                          ) : null}
                          {oc ? (
                            <span
                              style={{
                                marginLeft: "auto",
                                color: oc.color,
                                fontWeight: 600,
                                textTransform: "uppercase",
                                letterSpacing: "0.04em",
                              }}
                            >
                              {oc.label}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div
                style={{
                  background: "white",
                  border: "1px solid #D9D9D2",
                  padding: "14px 18px",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 12,
                  color: "#6B6B66",
                }}
              >
                No theses recorded for {security.ticker} in {fund.name} yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function thStatusStyle(status: string): { label: string; color: string } {
  switch (status) {
    case "active":
      return { label: "Active", color: "#1F5C3A" };
    case "closed":
      return { label: "Closed", color: "#5A3F08" };
    case "post_mortem":
      return { label: "Reviewed", color: "#00183A" };
    default:
      return { label: "Abandoned", color: "#9A9A8E" };
  }
}

function outcomeStyle(outcome: string): { label: string; color: string } {
  switch (outcome) {
    case "win":
      return { label: "Win", color: "#1F5C3A" };
    case "loss":
      return { label: "Loss", color: "#7A1F1F" };
    default:
      return { label: "Break-even", color: "#5A3F08" };
  }
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "#6B6B66",
        fontWeight: 500,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}
