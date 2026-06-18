"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useIntradayPrices } from "@/hooks/useIntradayPrices";
import { numeric } from "@/lib/typography";

interface UniverseRow {
  securityId: string;
  ticker: string;
  name: string;
  exchange: string;
  currency: "GBP" | "USD" | "EUR";
  gicsSector: string | null;
  gicsIndustry: string | null;
  latestPrice: string | null;
  latestPriceDate: string | null;
  tradeCount: number;
}

interface UniverseTableProps {
  rows: UniverseRow[];
  fundSlug: string;
  fundBaseCurrency: "GBP" | "USD" | "EUR";
}

type SortKey =
  | "ticker"
  | "name"
  | "sector"
  | "exchange"
  | "price"
  | "change"
  | "popular";

type SortDir = "asc" | "desc";

const currencySymbol = (ccy: string) =>
  ccy === "GBP" ? "£" : ccy === "EUR" ? "€" : "$";

export default function UniverseTable({
  rows,
  fundSlug,
}: UniverseTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("popular");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filter, setFilter] = useState("");

  // Live prices for everything in the universe — same intraday hook used
  // everywhere else. Cached server-side so cheap.
  const securityIds = useMemo(
    () => rows.map((r) => r.securityId),
    [rows]
  );
  const { quotes, lastUpdated } = useIntradayPrices(securityIds, {
    intervalMs: 30_000,
  });

  // Pre-process rows with live data attached
  const enriched = useMemo(() => {
    return rows.map((r) => {
      const live = quotes.get(r.securityId) ?? null;
      const displayPrice = live?.price ?? Number(r.latestPrice ?? 0);
      return {
        ...r,
        livePrice: live?.price ?? null,
        displayPrice,
        changePct: live?.changePct ?? null,
        marketState: live?.marketState ?? null,
      };
    });
  }, [rows, quotes]);

  // Filter
  const filtered = useMemo(() => {
    if (!filter.trim()) return enriched;
    const q = filter.trim().toLowerCase();
    return enriched.filter(
      (r) =>
        r.ticker.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.gicsSector?.toLowerCase().includes(q) ?? false)
    );
  }, [enriched, filter]);

  // Sort
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      switch (sortKey) {
        case "ticker":
          av = a.ticker;
          bv = b.ticker;
          break;
        case "name":
          av = a.name;
          bv = b.name;
          break;
        case "sector":
          av = a.gicsSector ?? "";
          bv = b.gicsSector ?? "";
          break;
        case "exchange":
          av = a.exchange;
          bv = b.exchange;
          break;
        case "price":
          av = a.displayPrice;
          bv = b.displayPrice;
          break;
        case "change":
          av = a.changePct ?? 0;
          bv = b.changePct ?? 0;
          break;
        case "popular":
          av = a.tradeCount;
          bv = b.tradeCount;
          break;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc"
          ? av.localeCompare(bv)
          : bv.localeCompare(av);
      }
      return sortDir === "asc"
        ? Number(av) - Number(bv)
        : Number(bv) - Number(av);
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Smart default direction per column
      setSortDir(
        key === "ticker" || key === "name" || key === "sector" || key === "exchange"
          ? "asc"
          : "desc"
      );
    }
  };

  const ageStr = lastUpdated
    ? `${Math.max(0, Math.floor((Date.now() - lastUpdated.getTime()) / 1000))}s`
    : null;

  return (
    <div
      style={{
        background: "white",
        border: "1px solid #D9D9D2",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #E5E5DE",
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center", flex: 1 }}>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by ticker, name, or sector…"
            style={{
              flex: 1,
              maxWidth: 380,
              padding: "6px 12px",
              border: "1px solid #D9D9D2",
              borderRadius: 3,
              fontSize: 13,
              outline: "none",
              fontFamily: "system-ui, sans-serif",
              background: "#FAFAF7",
            }}
          />
          <span
            style={{
              fontSize: 11,
              color: "#6B6B66",
            }}
          >
            {sorted.length} of {rows.length}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "#6B6B66", display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: ageStr ? "#1F5C3A" : "#9A9A8E",
            }}
          />
          {ageStr ? `Live · updated ${ageStr} ago` : "Loading prices…"}
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <SortHeader
                label="Ticker"
                sortKey="ticker"
                activeSort={sortKey}
                dir={sortDir}
                onSort={onSort}
                align="left"
              />
              <SortHeader
                label="Name"
                sortKey="name"
                activeSort={sortKey}
                dir={sortDir}
                onSort={onSort}
                align="left"
              />
              <SortHeader
                label="Sector"
                sortKey="sector"
                activeSort={sortKey}
                dir={sortDir}
                onSort={onSort}
                align="left"
              />
              <SortHeader
                label="Exchange"
                sortKey="exchange"
                activeSort={sortKey}
                dir={sortDir}
                onSort={onSort}
                align="left"
              />
              <SortHeader
                label="Price"
                sortKey="price"
                activeSort={sortKey}
                dir={sortDir}
                onSort={onSort}
                align="right"
              />
              <SortHeader
                label="Δ Today"
                sortKey="change"
                activeSort={sortKey}
                dir={sortDir}
                onSort={onSort}
                align="right"
              />
              <SortHeader
                label="Trades"
                sortKey="popular"
                activeSort={sortKey}
                dir={sortDir}
                onSort={onSort}
                align="right"
              />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: "32px 16px",
                    textAlign: "center",
                    color: "#9A9A8E",
                    fontSize: 12,
                  }}
                >
                  {rows.length === 0
                    ? "No securities in this fund's investable universe yet."
                    : "No matches. Try a different filter."}
                </td>
              </tr>
            ) : (
              sorted.map((r) => {
                const securityKey = `${r.ticker}-${r.exchange.replace(/ /g, "_")}`;
                return (
                  <tr key={r.securityId}>
                    <td
                      style={{
                        padding: "9px 14px",
                        borderBottom: "1px solid #F0EFEA",
                      }}
                    >
                      <Link
                        href={`/dashboard/funds/${fundSlug}/securities/${securityKey}`}
                        style={{
                          color: "#00183A",
                          textDecoration: "none",
                          fontFamily: "ui-monospace, monospace",
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {r.ticker}
                      </Link>
                    </td>
                    <td
                      style={{
                        padding: "9px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        color: "#0A0A0A",
                      }}
                    >
                      <Link
                        href={`/dashboard/funds/${fundSlug}/securities/${securityKey}`}
                        style={{
                          color: "#0A0A0A",
                          textDecoration: "none",
                        }}
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td
                      style={{
                        padding: "9px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        fontSize: 11,
                        color: "#6B6B66",
                      }}
                    >
                      {r.gicsSector ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "9px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        fontSize: 11,
                        color: "#6B6B66",
                      }}
                    >
                      {r.exchange}
                    </td>
                    <td
                      style={{
                        padding: "9px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        ...numeric,
                        color: "#0A0A0A",
                      }}
                    >
                      {r.displayPrice
                        ? `${currencySymbol(r.currency)}${r.displayPrice.toFixed(2)}`
                        : "—"}
                    </td>
                    <td
                      style={{
                        padding: "9px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        ...numeric,
                        fontSize: 11,
                      }}
                    >
                      {r.changePct != null ? (
                        <span
                          style={{
                            color:
                              r.changePct > 0
                                ? "#1F5C3A"
                                : r.changePct < 0
                                  ? "#7A1F1F"
                                  : "#6B6B66",
                          }}
                        >
                          {r.changePct > 0 ? "▲" : r.changePct < 0 ? "▼" : "·"}{" "}
                          {(Math.abs(r.changePct) * 100).toFixed(2)}%
                        </span>
                      ) : (
                        <span style={{ color: "#9A9A8E" }}>—</span>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "9px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        ...numeric,
                        color: r.tradeCount > 0 ? "#0A0A0A" : "#9A9A8E",
                      }}
                    >
                      {r.tradeCount}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  activeSort,
  dir,
  onSort,
  align,
}: {
  label: string;
  sortKey: SortKey;
  activeSort: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align: "left" | "right";
}) {
  const isActive = sortKey === activeSort;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{
        fontSize: 10,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: isActive ? "#00183A" : "#6B6B66",
        borderBottom: "1px solid #E5E5DE",
        padding: "10px 14px",
        fontWeight: 500,
        textAlign: align,
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
      {isActive ? (dir === "asc" ? " ↑" : " ↓") : null}
    </th>
  );
}
