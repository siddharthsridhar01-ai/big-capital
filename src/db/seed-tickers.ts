/**
 * Seed data for Phase 2b: hand-picked universe of ~30 tickers across exchanges.
 *
 * This lets us build and test the trade ticket UX with real-looking tickers
 * before subscribing to EODHD's paid plan. Each ticker includes plausible
 * GICS sector classification and a recent close price so the system is
 * immediately testable end-to-end.
 *
 * Once EODHD subscription is active, we'll replace this with bulk ingestion
 * of FTSE 350, S&P 500, STOXX 600 etc., but the SHAPE of the data stays
 * identical so no other code needs to change.
 */

// Sources for prices: roughly representative recent close prices; intended
// for development. Will be overwritten by real EODHD data once subscribed.
export interface SeedTicker {
  ticker: string;
  exchange: string;
  name: string;
  currency: "GBP" | "USD" | "EUR";
  gicsSector: string;
  gicsIndustry: string;
  isin?: string;
  recentClose: string; // string for decimal precision
  // Which fund universes this ticker should auto-join
  universes: ("uk-equity" | "us-equity" | "global-equity" | "european-equity" | "em-equity" | "long-short")[];
}

export const SEED_TICKERS: SeedTicker[] = [
  // ===== UK (LSE) — for UK Equity Fund, also Global =====
  // NOTE: LSE typically quotes in pence, but we store all prices in MAJOR units
  // (pounds) for consistency across the system. EODHD's `eod` endpoint can be
  // configured to return major-unit prices for LSE, which we'll use when we
  // wire real ingestion. Approximate Q2 2026 closing prices:
  { ticker: "AZN", exchange: "LSE", name: "AstraZeneca PLC", currency: "GBP",
    gicsSector: "Health Care", gicsIndustry: "Pharmaceuticals",
    isin: "GB0009895292", recentClose: "105.40",
    universes: ["uk-equity", "global-equity", "long-short"] },
  { ticker: "SHEL", exchange: "LSE", name: "Shell PLC", currency: "GBP",
    gicsSector: "Energy", gicsIndustry: "Integrated Oil & Gas",
    isin: "GB00BP6MXD84", recentClose: "28.10",
    universes: ["uk-equity", "global-equity", "long-short"] },
  { ticker: "HSBA", exchange: "LSE", name: "HSBC Holdings PLC", currency: "GBP",
    gicsSector: "Financials", gicsIndustry: "Diversified Banks",
    isin: "GB0005405286", recentClose: "9.05",
    universes: ["uk-equity", "global-equity"] },
  { ticker: "ULVR", exchange: "LSE", name: "Unilever PLC", currency: "GBP",
    gicsSector: "Consumer Staples", gicsIndustry: "Household Products",
    isin: "GB00B10RZP78", recentClose: "47.80",
    universes: ["uk-equity", "global-equity"] },
  { ticker: "BARC", exchange: "LSE", name: "Barclays PLC", currency: "GBP",
    gicsSector: "Financials", gicsIndustry: "Diversified Banks",
    isin: "GB0031348658", recentClose: "3.52",
    universes: ["uk-equity", "long-short"] },
  { ticker: "RIO", exchange: "LSE", name: "Rio Tinto PLC", currency: "GBP",
    gicsSector: "Materials", gicsIndustry: "Diversified Metals & Mining",
    isin: "GB0007188757", recentClose: "49.15",
    universes: ["uk-equity", "global-equity"] },
  { ticker: "BP", exchange: "LSE", name: "BP PLC", currency: "GBP",
    gicsSector: "Energy", gicsIndustry: "Integrated Oil & Gas",
    isin: "GB0007980591", recentClose: "4.21",
    universes: ["uk-equity", "long-short"] },
  { ticker: "REL", exchange: "LSE", name: "RELX PLC", currency: "GBP",
    gicsSector: "Industrials", gicsIndustry: "Research & Consulting Services",
    isin: "GB00B2B0DG97", recentClose: "37.60",
    universes: ["uk-equity", "global-equity"] },

  // ===== US (NYSE/NASDAQ) — for US Equity Fund, Global, Long/Short =====
  { ticker: "AAPL", exchange: "NASDAQ", name: "Apple Inc", currency: "USD",
    gicsSector: "Information Technology", gicsIndustry: "Technology Hardware",
    isin: "US0378331005", recentClose: "224.50",
    universes: ["us-equity", "global-equity", "long-short"] },
  { ticker: "MSFT", exchange: "NASDAQ", name: "Microsoft Corporation", currency: "USD",
    gicsSector: "Information Technology", gicsIndustry: "Systems Software",
    isin: "US5949181045", recentClose: "428.70",
    universes: ["us-equity", "global-equity", "long-short"] },
  { ticker: "NVDA", exchange: "NASDAQ", name: "NVIDIA Corporation", currency: "USD",
    gicsSector: "Information Technology", gicsIndustry: "Semiconductors",
    isin: "US67066G1040", recentClose: "138.50",
    universes: ["us-equity", "global-equity", "long-short"] },
  { ticker: "GOOGL", exchange: "NASDAQ", name: "Alphabet Inc Class A", currency: "USD",
    gicsSector: "Communication Services", gicsIndustry: "Interactive Media",
    isin: "US02079K3059", recentClose: "192.30",
    universes: ["us-equity", "global-equity", "long-short"] },
  { ticker: "JPM", exchange: "NYSE", name: "JPMorgan Chase & Co", currency: "USD",
    gicsSector: "Financials", gicsIndustry: "Diversified Banks",
    isin: "US46625H1005", recentClose: "245.80",
    universes: ["us-equity", "global-equity"] },
  { ticker: "JNJ", exchange: "NYSE", name: "Johnson & Johnson", currency: "USD",
    gicsSector: "Health Care", gicsIndustry: "Pharmaceuticals",
    isin: "US4781601046", recentClose: "157.40",
    universes: ["us-equity", "global-equity"] },
  { ticker: "BRK.B", exchange: "NYSE", name: "Berkshire Hathaway Inc Class B", currency: "USD",
    gicsSector: "Financials", gicsIndustry: "Multi-Sector Holdings",
    isin: "US0846707026", recentClose: "468.20",
    universes: ["us-equity", "global-equity"] },
  { ticker: "XOM", exchange: "NYSE", name: "Exxon Mobil Corporation", currency: "USD",
    gicsSector: "Energy", gicsIndustry: "Integrated Oil & Gas",
    isin: "US30231G1022", recentClose: "115.30",
    universes: ["us-equity", "long-short"] },
  { ticker: "WMT", exchange: "NYSE", name: "Walmart Inc", currency: "USD",
    gicsSector: "Consumer Staples", gicsIndustry: "Hypermarkets & Super Centers",
    isin: "US9311421039", recentClose: "92.80",
    universes: ["us-equity", "global-equity"] },

  // ===== Continental Europe — for European Equity Fund, Global =====
  { ticker: "NESN", exchange: "SIX", name: "Nestle SA", currency: "EUR",
    gicsSector: "Consumer Staples", gicsIndustry: "Packaged Foods & Meats",
    isin: "CH0038863350", recentClose: "82.40",
    universes: ["european-equity", "global-equity"] },
  { ticker: "ASML", exchange: "Euronext Amsterdam", name: "ASML Holding NV", currency: "EUR",
    gicsSector: "Information Technology", gicsIndustry: "Semiconductor Equipment",
    isin: "NL0010273215", recentClose: "688.00",
    universes: ["european-equity", "global-equity", "long-short"] },
  { ticker: "MC", exchange: "Euronext Paris", name: "LVMH Moet Hennessy Louis Vuitton SE", currency: "EUR",
    gicsSector: "Consumer Discretionary", gicsIndustry: "Apparel & Luxury",
    isin: "FR0000121014", recentClose: "692.00",
    universes: ["european-equity", "global-equity"] },
  { ticker: "SAP", exchange: "XETRA", name: "SAP SE", currency: "EUR",
    gicsSector: "Information Technology", gicsIndustry: "Application Software",
    isin: "DE0007164600", recentClose: "236.20",
    universes: ["european-equity", "global-equity"] },
  { ticker: "SIE", exchange: "XETRA", name: "Siemens AG", currency: "EUR",
    gicsSector: "Industrials", gicsIndustry: "Industrial Conglomerates",
    isin: "DE0007236101", recentClose: "208.00",
    universes: ["european-equity", "global-equity"] },
  { ticker: "OR", exchange: "Euronext Paris", name: "L'Oreal SA", currency: "EUR",
    gicsSector: "Consumer Staples", gicsIndustry: "Personal Care Products",
    isin: "FR0000120321", recentClose: "362.50",
    universes: ["european-equity", "global-equity"] },
  { ticker: "NOVO.B", exchange: "Nasdaq Copenhagen", name: "Novo Nordisk A/S", currency: "EUR",
    gicsSector: "Health Care", gicsIndustry: "Pharmaceuticals",
    isin: "DK0060534915", recentClose: "98.50",
    universes: ["european-equity", "global-equity"] },

  // ===== Emerging Markets — for EM Equity Fund =====
  { ticker: "TSM", exchange: "NYSE", name: "Taiwan Semiconductor (ADR)", currency: "USD",
    gicsSector: "Information Technology", gicsIndustry: "Semiconductors",
    isin: "US8740391003", recentClose: "180.20",
    universes: ["em-equity", "global-equity"] },
  { ticker: "BABA", exchange: "NYSE", name: "Alibaba Group Holding (ADR)", currency: "USD",
    gicsSector: "Consumer Discretionary", gicsIndustry: "Internet Retail",
    isin: "US01609W1027", recentClose: "82.40",
    universes: ["em-equity"] },
  { ticker: "RELIANCE", exchange: "NSE", name: "Reliance Industries Ltd", currency: "USD",
    gicsSector: "Energy", gicsIndustry: "Integrated Oil & Gas",
    isin: "INE002A01018", recentClose: "1290.00",
    universes: ["em-equity"] },
  { ticker: "VALE", exchange: "NYSE", name: "Vale SA (ADR)", currency: "USD",
    gicsSector: "Materials", gicsIndustry: "Diversified Metals & Mining",
    isin: "US91912E1055", recentClose: "10.80",
    universes: ["em-equity"] },
];
