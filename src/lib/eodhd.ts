/**
 * BIG Capital — EODHD Market Data Client
 *
 * Typed wrapper around EOD Historical Data API endpoints we use:
 *   - GET /eod/{ticker}.{exchange}            — EOD price history
 *   - GET /real-time/{ticker}.{exchange}       — Last close + delayed quote
 *   - GET /eod-bulk-last-day/{exchange}        — Bulk EOD for whole exchange (efficient)
 *   - GET /div/{ticker}.{exchange}             — Dividend history
 *   - GET /splits/{ticker}.{exchange}          — Split history
 *   - GET /fundamentals/{ticker}.{exchange}    — Fundamentals (sector, industry, etc.)
 *
 * Free tier note: use `demo` token to test against AAPL.US, TSLA.US, AMZN.US,
 * MCD.US, BTC-USD.CC, EURUSD.FOREX with no daily limit. For production, sign up
 * at eodhd.com and request the 50% academic discount.
 *
 * Rate limiting: paid plans have 1000 req/min, free is 20/day. The bulk endpoint
 * is our friend — one call per exchange per day covers our load.
 *
 * Docs: https://eodhd.com/financial-apis/
 */

import { z } from "zod";

const BASE_URL = "https://eodhd.com/api";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EodhdClientConfig {
  apiToken: string;
  /** Optional override for the base URL (useful for testing) */
  baseUrl?: string;
  /** ms between retries on 429 / 5xx; defaults to 1000 */
  retryDelayMs?: number;
  /** Max retries on transient errors; defaults to 3 */
  maxRetries?: number;
  /** Optional user agent string */
  userAgent?: string;
}

// ---------------------------------------------------------------------------
// Response schemas (Zod-validated for runtime safety)
// ---------------------------------------------------------------------------

const EodPriceSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  adjusted_close: z.number(),
  volume: z.number(),
});
export type EodPrice = z.infer<typeof EodPriceSchema>;

const RealTimeQuoteSchema = z.object({
  code: z.string(),
  timestamp: z.number(),
  gmtoffset: z.number(),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  close: z.number(),
  volume: z.number().nullable(),
  previousClose: z.number().nullable(),
  change: z.number().nullable(),
  change_p: z.number().nullable(),
});
export type RealTimeQuote = z.infer<typeof RealTimeQuoteSchema>;

const BulkEodRowSchema = z.object({
  code: z.string(),
  exchange_short_name: z.string(),
  date: z.string(),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  close: z.number(),
  adjusted_close: z.number().nullable(),
  volume: z.number().nullable(),
});
export type BulkEodRow = z.infer<typeof BulkEodRowSchema>;

const DividendSchema = z.object({
  date: z.string(),
  declarationDate: z.string().nullable(),
  recordDate: z.string().nullable(),
  paymentDate: z.string().nullable(),
  period: z.string().nullable(),
  value: z.number(),
  unadjustedValue: z.number().nullable(),
  currency: z.string().nullable(),
});
export type Dividend = z.infer<typeof DividendSchema>;

const SplitSchema = z.object({
  date: z.string(),
  split: z.string(), // e.g. "2.000000/1.000000"
});
export type Split = z.infer<typeof SplitSchema>;

const FundamentalsGeneralSchema = z.object({
  Code: z.string().optional(),
  Name: z.string().optional(),
  Exchange: z.string().optional(),
  CurrencyCode: z.string().optional(),
  CountryName: z.string().optional(),
  Sector: z.string().nullable().optional(),
  Industry: z.string().nullable().optional(),
  GicSector: z.string().nullable().optional(),
  GicGroup: z.string().nullable().optional(),
  GicIndustry: z.string().nullable().optional(),
  GicSubIndustry: z.string().nullable().optional(),
  ISIN: z.string().nullable().optional(),
});

const FundamentalsSchema = z.object({
  General: FundamentalsGeneralSchema.optional(),
}).passthrough(); // fundamentals payload is huge; we only need a subset
export type Fundamentals = z.infer<typeof FundamentalsSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EodhdError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly endpoint?: string,
    public readonly retriable?: boolean
  ) {
    super(message);
    this.name = "EodhdError";
  }
}

// ---------------------------------------------------------------------------
// Exchange code mapping
// ---------------------------------------------------------------------------

/**
 * Translate a human-friendly / listing exchange code into the code EODHD's API
 * expects in `TICKER.EXCHANGE` symbols. We store readable codes on securities
 * (e.g. "NASDAQ", "NYSE") but EODHD groups all US venues under a single "US"
 * feed, so those must be translated or the API 404s ("Symbol not found").
 *
 * Codes EODHD already accepts (LSE, XETRA, PA, ...) pass through unchanged.
 * Unknown codes also pass through — a genuinely wrong code then surfaces as a
 * visible 404 from the endpoint rather than being silently swallowed here.
 */
const EODHD_EXCHANGE_ALIASES: Record<string, string> = {
  NASDAQ: "US",
  NYSE: "US",
  "NYSE ARCA": "US",
  NYSEARCA: "US",
  ARCA: "US",
  AMEX: "US",
  "NYSE AMERICAN": "US",
  BATS: "US",
  "NYSE MKT": "US",
};

export function toEodhdExchange(raw: string): string {
  const key = raw.trim().toUpperCase();
  return EODHD_EXCHANGE_ALIASES[key] ?? raw.trim();
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class EodhdClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(config: EodhdClientConfig) {
    this.token = config.apiToken;
    this.baseUrl = config.baseUrl ?? BASE_URL;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.maxRetries = config.maxRetries ?? 3;
    this.userAgent = config.userAgent ?? "big-capital/0.1";
  }

  // -------------------------------------------------------------------------
  // Core request with retry on 429/5xx
  // -------------------------------------------------------------------------

  private async request<T>(
    path: string,
    params: Record<string, string | number> = {},
    schema?: z.ZodSchema<T>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("api_token", this.token);
    url.searchParams.set("fmt", "json");
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          headers: {
            "User-Agent": this.userAgent,
            Accept: "application/json",
          },
        });

        if (res.status === 429) {
          // Rate limited — backoff and retry
          await sleep(this.retryDelayMs * Math.pow(2, attempt));
          lastError = new EodhdError(
            "Rate limited (429)",
            429,
            path,
            true
          );
          continue;
        }

        if (res.status >= 500) {
          await sleep(this.retryDelayMs * Math.pow(2, attempt));
          lastError = new EodhdError(
            `Server error (${res.status})`,
            res.status,
            path,
            true
          );
          continue;
        }

        if (!res.ok) {
          // 4xx other than 429: not retriable
          const text = await res.text().catch(() => "");
          throw new EodhdError(
            `EODHD ${res.status} on ${path}: ${text.slice(0, 200)}`,
            res.status,
            path,
            false
          );
        }

        const json = await res.json();
        if (schema) {
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            throw new EodhdError(
              `EODHD response schema mismatch on ${path}: ${parsed.error.message}`,
              undefined,
              path,
              false
            );
          }
          return parsed.data;
        }
        return json as T;
      } catch (err) {
        if (err instanceof EodhdError && !err.retriable) throw err;
        lastError = err as Error;
      }
    }
    throw lastError ?? new EodhdError(`Exhausted retries on ${path}`);
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  /**
   * Fetch EOD price history for a single security.
   *
   * @param ticker e.g. "AAPL", "AZN", "SHEL"
   * @param exchange e.g. "US" (NYSE/NASDAQ), "LSE" (UK), "PA" (Paris), etc.
   *                 EODHD uses period notation: "AAPL.US", "AZN.LSE", "BMW.XETRA"
   * @param from optional start date YYYY-MM-DD
   * @param to optional end date YYYY-MM-DD
   */
  async getEodPrices(
    ticker: string,
    exchange: string,
    from?: string,
    to?: string
  ): Promise<EodPrice[]> {
    const symbol = `${ticker}.${toEodhdExchange(exchange)}`;
    const params: Record<string, string> = { period: "d" };
    if (from) params.from = from;
    if (to) params.to = to;
    return this.request(
      `/eod/${symbol}`,
      params,
      z.array(EodPriceSchema)
    );
  }

  /**
   * Last close / delayed quote. Used at trade time to pre-fill price.
   */
  async getRealTimeQuote(
    ticker: string,
    exchange: string
  ): Promise<RealTimeQuote> {
    const symbol = `${ticker}.${toEodhdExchange(exchange)}`;
    return this.request(
      `/real-time/${symbol}`,
      {},
      RealTimeQuoteSchema
    );
  }

  /**
   * Bulk EOD prices for ALL securities on a given exchange for a given date.
   * This is the workhorse for the daily NAV job — one call per exchange.
   *
   * @param exchange e.g. "US", "LSE", "XETRA", "PA"
   * @param date YYYY-MM-DD; if omitted, returns latest available
   * @param symbols optional comma-separated subset to filter to
   */
  async getBulkEodForExchange(
    exchange: string,
    date?: string,
    symbols?: string[]
  ): Promise<BulkEodRow[]> {
    const params: Record<string, string> = {};
    if (date) params.date = date;
    if (symbols && symbols.length > 0) {
      params.symbols = symbols.join(",");
    }
    return this.request(
      `/eod-bulk-last-day/${toEodhdExchange(exchange)}`,
      params,
      z.array(BulkEodRowSchema)
    );
  }

  /**
   * Dividend history for a security. We poll this nightly for held positions
   * and auto-credit cash on ex-date.
   */
  async getDividends(
    ticker: string,
    exchange: string,
    from?: string,
    to?: string
  ): Promise<Dividend[]> {
    const symbol = `${ticker}.${toEodhdExchange(exchange)}`;
    const params: Record<string, string> = {};
    if (from) params.from = from;
    if (to) params.to = to;
    return this.request(
      `/div/${symbol}`,
      params,
      z.array(DividendSchema)
    );
  }

  /**
   * Stock split history. Poll for held positions; auto-adjust quantity on ex-date.
   */
  async getSplits(
    ticker: string,
    exchange: string,
    from?: string,
    to?: string
  ): Promise<Split[]> {
    const symbol = `${ticker}.${toEodhdExchange(exchange)}`;
    const params: Record<string, string> = {};
    if (from) params.from = from;
    if (to) params.to = to;
    return this.request(
      `/splits/${symbol}`,
      params,
      z.array(SplitSchema)
    );
  }

  /**
   * Fundamentals — used at security onboarding to capture GICS sector,
   * industry, ISIN, etc. Not polled regularly.
   */
  async getFundamentals(
    ticker: string,
    exchange: string
  ): Promise<Fundamentals> {
    const symbol = `${ticker}.${toEodhdExchange(exchange)}`;
    return this.request(
      `/fundamentals/${symbol}`,
      {},
      FundamentalsSchema
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a split string like "2.000000/1.000000" into a ratio number.
 * 2/1 split means shares double, so factor = 2.
 * 1/4 reverse split means shares quartered, so factor = 0.25.
 */
export function parseSplitRatio(splitStr: string): number {
  const [numerator, denominator] = splitStr.split("/").map(Number);
  if (!denominator || isNaN(numerator) || isNaN(denominator)) {
    throw new Error(`Invalid split string: ${splitStr}`);
  }
  return numerator / denominator;
}
