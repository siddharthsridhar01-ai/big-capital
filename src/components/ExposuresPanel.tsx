/**
 * Exposures panel for the fund detail page.
 *
 * Renders sector breakdown, top positions, and (when meaningful) geographic
 * and currency breakdowns. Each section earns its place by having real
 * information density — a UK-only fund won't show "Geography: 100% UK"
 * because that's filler.
 *
 * Server component — pure presentation from already-computed portfolio state.
 */

import { serif, numeric } from "@/lib/typography";

interface ExposuresPanelProps {
  baseCurrency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
  navBase: number;
  positions: Array<{
    securityId: string;
    ticker: string;
    name: string;
    exchange: string;
    currency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
    gicsSector: string | null;
    /** Signed quantity. */
    quantity: number;
    /** Absolute market value in fund base currency. */
    marketValueBase: number | null;
  }>;
  cashByCurrency: Map<string, number>;
  sectorExposures: Map<string, number>;
  longExposure: number;
  shortExposure: number;
  grossExposure: number;
  netExposure: number;
}

const baseSyms: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", HKD: "HK$", CNY: "¥", KRW: "₩", SGD: "S$", INR: "₹" };

function fmtMoney(n: number, ccy: string) {
  return `${baseSyms[ccy] ?? "$"}${new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)}`;
}

function fmtPct(n: number) {
  return `${(n * 100).toFixed(2)}%`;
}

/**
 * Map an exchange code to a country. Country of LISTING, not country of
 * revenue. Revenue-weighted geographic exposure requires paid data we don't
 * have for v1.
 */
function exchangeToCountry(exchange: string): string {
  const norm = exchange.toUpperCase().trim();
  const map: Record<string, string> = {
    LSE: "United Kingdom",
    "LONDON STOCK EXCHANGE": "United Kingdom",
    NYSE: "United States",
    NASDAQ: "United States",
    XETRA: "Germany",
    FRANKFURT: "Germany",
    "EURONEXT PARIS": "France",
    "EURONEXT AMSTERDAM": "Netherlands",
    "EURONEXT BRUSSELS": "Belgium",
    "BORSA ITALIANA": "Italy",
    MILAN: "Italy",
    SIX: "Switzerland",
    "SWISS EXCHANGE": "Switzerland",
    TSX: "Canada",
    "TORONTO STOCK EXCHANGE": "Canada",
    HKEX: "Hong Kong",
    "HONG KONG STOCK EXCHANGE": "Hong Kong",
    NSE: "India",
    BSE: "India",
    "TOKYO STOCK EXCHANGE": "Japan",
    TSE: "Japan",
    "AUSTRALIAN SECURITIES EXCHANGE": "Australia",
    ASX: "Australia",
    JSE: "South Africa",
    "JOHANNESBURG STOCK EXCHANGE": "South Africa",
    B3: "Brazil",
    "BOLSA DE VALORES DE SAO PAULO": "Brazil",
    "BOLSA MEXICANA DE VALORES": "Mexico",
    TWSE: "Taiwan",
    "TAIWAN STOCK EXCHANGE": "Taiwan",
    KRX: "South Korea",
    KOSPI: "South Korea",
    "KOREA EXCHANGE": "South Korea",
  };
  return map[norm] ?? exchange;
}

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#6B6B66",
  fontWeight: 500,
  marginBottom: 12,
};

const CARD: React.CSSProperties = {
  background: "white",
  border: "1px solid #D9D9D2",
  padding: "16px 18px",
};

export default function ExposuresPanel({
  baseCurrency,
  navBase,
  positions,
  cashByCurrency,
  sectorExposures,
  longExposure,
  shortExposure,
  grossExposure,
  netExposure,
}: ExposuresPanelProps) {
  if (positions.length === 0) return null;

  // ---- Sector breakdown ----
  // sectorExposures comes in as fractions of NAV (already divided). Reconstruct
  // absolute base-currency values for display alongside the percentages.
  const sectorRows = Array.from(sectorExposures.entries())
    .map(([sector, pct]) => ({
      sector: sector || "Unclassified",
      value: pct * navBase,
      pct,
    }))
    .sort((a, b) => b.value - a.value);

  // ---- Top positions ----
  const positionRows = positions
    .map((p) => ({
      ticker: p.ticker,
      name: p.name,
      side: (p.quantity < 0 ? "short" : "long") as "long" | "short",
      value: Math.abs(p.marketValueBase ?? 0),
      pct: navBase === 0 ? 0 : Math.abs(p.marketValueBase ?? 0) / navBase,
    }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  // ---- Geographic breakdown ----
  const countryMap = new Map<string, number>();
  for (const p of positions) {
    const country = exchangeToCountry(p.exchange);
    const mv = Math.abs(p.marketValueBase ?? 0);
    countryMap.set(country, (countryMap.get(country) ?? 0) + mv);
  }
  const countryRows = Array.from(countryMap.entries())
    .map(([country, value]) => ({
      country,
      value,
      pct: navBase === 0 ? 0 : value / navBase,
    }))
    .sort((a, b) => b.value - a.value);
  const showGeography = countryRows.length >= 2;

  // ---- Currency breakdown ----
  // Combine cash currencies + position currencies (weighted by market value)
  const currencyMap = new Map<string, number>();
  for (const [ccy, amount] of cashByCurrency.entries()) {
    if (amount > 0) {
      currencyMap.set(ccy, (currencyMap.get(ccy) ?? 0) + amount);
    }
  }
  for (const p of positions) {
    const mv = Math.abs(p.marketValueBase ?? 0);
    currencyMap.set(p.currency, (currencyMap.get(p.currency) ?? 0) + mv);
  }
  const currencyRows = Array.from(currencyMap.entries())
    .map(([currency, value]) => ({
      currency,
      value,
      pct: navBase === 0 ? 0 : value / navBase,
    }))
    .sort((a, b) => b.value - a.value);
  const showCurrency = currencyRows.length >= 2;

  // ---- Long/short breakdown ----
  const hasShorts = positions.some((p) => p.quantity < 0);

  // Build grid layout: always sector + top positions, conditionally others
  const sections: React.ReactNode[] = [];

  // Sector
  sections.push(
    <div key="sector" style={CARD}>
      <div style={SECTION_HEADER}>Sector exposure</div>
      <BarRows
        rows={sectorRows.map((r) => ({
          label: r.sector,
          pct: r.pct,
          value: fmtMoney(r.value, baseCurrency),
        }))}
        accent="#00183A"
      />
    </div>
  );

  // Top positions
  sections.push(
    <div key="positions" style={CARD}>
      <div style={SECTION_HEADER}>
        Top positions ({Math.min(10, positionRows.length)})
      </div>
      <BarRows
        rows={positionRows.map((r) => ({
          label: r.ticker,
          sublabel: r.name,
          pct: r.pct,
          value: fmtMoney(r.value, baseCurrency),
          accent: r.side === "short" ? "#7A1F1F" : undefined,
        }))}
        accent="#00183A"
      />
    </div>
  );

  // Geography (conditional)
  if (showGeography) {
    sections.push(
      <div key="geography" style={CARD}>
        <div style={SECTION_HEADER}>Geographic exposure</div>
        <div
          style={{
            fontSize: 10,
            color: "#9A9A8E",
            marginTop: -8,
            marginBottom: 10,
            fontStyle: "italic",
          }}
        >
          Country of listing
        </div>
        <BarRows
          rows={countryRows.map((r) => ({
            label: r.country,
            pct: r.pct,
            value: fmtMoney(r.value, baseCurrency),
          }))}
          accent="#1F5C3A"
        />
      </div>
    );
  }

  // Currency (conditional)
  if (showCurrency) {
    sections.push(
      <div key="currency" style={CARD}>
        <div style={SECTION_HEADER}>Currency exposure</div>
        <BarRows
          rows={currencyRows.map((r) => ({
            label: r.currency,
            pct: r.pct,
            value: fmtMoney(r.value, baseCurrency),
          }))}
          accent="#5A3F08"
        />
      </div>
    );
  }

  // Long/short breakdown (conditional — only if shorts exist)
  if (hasShorts) {
    sections.push(
      <div key="ls" style={CARD}>
        <div style={SECTION_HEADER}>Long / short breakdown</div>
        <LongShortPanel
          longExposure={longExposure}
          shortExposure={shortExposure}
          grossExposure={grossExposure}
          netExposure={netExposure}
        />
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          ...serif,
          fontSize: 16,
          color: "#00183A",
          marginBottom: 14,
        }}
      >
        Exposures
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 16,
        }}
      >
        {sections}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bar row helper — used by every section for consistent styling
// ---------------------------------------------------------------------------

interface BarRow {
  label: string;
  sublabel?: string;
  pct: number;
  value: string;
  /** Optional per-row override (e.g. burgundy for short positions). */
  accent?: string;
}

function BarRows({ rows, accent }: { rows: BarRow[]; accent: string }) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          fontSize: 12,
          color: "#9A9A8E",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        No data
      </div>
    );
  }
  return (
    <div>
      {rows.map((r, i) => {
        const color = r.accent ?? accent;
        return (
          <div
            key={`${r.label}-${i}`}
            style={{
              padding: "8px 0",
              borderBottom:
                i < rows.length - 1 ? "1px solid #F0EFEA" : "none",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                fontFamily: "system-ui, sans-serif",
                fontSize: 12,
                color: "#0A0A0A",
                marginBottom: 4,
              }}
            >
              <div>
                <span style={{ fontWeight: 500 }}>{r.label}</span>
                {r.sublabel ? (
                  <span
                    style={{ color: "#6B6B66", marginLeft: 6, fontSize: 11 }}
                  >
                    {r.sublabel}
                  </span>
                ) : null}
              </div>
              <div
                style={{
                  ...numeric,
                  fontSize: 11,
                  color: "#6B6B66",
                  whiteSpace: "nowrap",
                }}
              >
                {fmtPct(r.pct)} · {r.value}
              </div>
            </div>
            <div
              style={{
                height: 3,
                background: "#F0EFEA",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.min(100, r.pct * 100)}%`,
                  height: "100%",
                  background: color,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Long/Short summary panel
// ---------------------------------------------------------------------------

function LongShortPanel({
  longExposure,
  shortExposure,
  grossExposure,
  netExposure,
}: {
  longExposure: number;
  shortExposure: number;
  grossExposure: number;
  netExposure: number;
}) {
  // Net can be negative if the fund is net-short; show with sign and colour
  const netIsLong = netExposure >= 0;
  const netColor = netIsLong ? "#1F5C3A" : "#7A1F1F";
  const netSign = netIsLong ? "+" : "−";
  const netDisplay = `${netSign}${Math.abs(netExposure * 100).toFixed(2)}%`;

  return (
    <div>
      <ExposureRow label="Long" value={longExposure} color="#1F5C3A" />
      <ExposureRow label="Short" value={shortExposure} color="#7A1F1F" />
      <div
        style={{
          height: 1,
          background: "#E5E5DE",
          margin: "10px 0",
        }}
      />
      <ExposureRow
        label="Gross"
        sublabel="Long + Short"
        value={grossExposure}
        color="#00183A"
      />
      <ExposureRowSigned
        label="Net"
        sublabel={netIsLong ? "Long − Short · Net long" : "Long − Short · Net short"}
        display={netDisplay}
        color={netColor}
      />
    </div>
  );
}

function ExposureRowSigned({
  label,
  sublabel,
  display,
  color,
}: {
  label: string;
  sublabel?: string;
  display: string;
  color: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        padding: "6px 0",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
      }}
    >
      <div>
        <span style={{ fontWeight: 500, color: "#0A0A0A" }}>{label}</span>
        {sublabel ? (
          <span style={{ color: "#9A9A8E", marginLeft: 6, fontSize: 11 }}>
            {sublabel}
          </span>
        ) : null}
      </div>
      <div style={{ ...numeric, fontSize: 13, color, fontWeight: 500 }}>
        {display}
      </div>
    </div>
  );
}

function ExposureRow({
  label,
  sublabel,
  value,
  color,
}: {
  label: string;
  sublabel?: string;
  value: number;
  color: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        padding: "6px 0",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
      }}
    >
      <div>
        <span style={{ fontWeight: 500, color: "#0A0A0A" }}>{label}</span>
        {sublabel ? (
          <span style={{ color: "#9A9A8E", marginLeft: 6, fontSize: 11 }}>
            {sublabel}
          </span>
        ) : null}
      </div>
      <div style={{ ...numeric, fontSize: 13, color, fontWeight: 500 }}>
        {fmtPct(value)}
      </div>
    </div>
  );
}
