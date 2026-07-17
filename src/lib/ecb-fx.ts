/**
 * BIG Capital — ECB FX Rates Client
 *
 * Fetches the European Central Bank's daily euro foreign-exchange reference
 * rates, which are the de-facto standard for daily EOD FX in Europe.
 *
 *   - Published once per business day around 16:00 CET
 *   - All rates are EUR-based (1 EUR = X USD, etc.)
 *   - We derive cross rates (GBP/USD etc.) by transitivity through EUR
 *
 * Data source: https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html
 *
 * Endpoints used:
 *   - https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml      (latest only)
 *   - https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml   (last 90 days)
 *   - https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml       (full history from 1999)
 *
 * Free, no auth, official, reliable. We use the 90-day endpoint for the daily
 * cron and the full-history endpoint for backfill / initial seed.
 */

const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ECB_HIST_90D_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const ECB_HIST_FULL_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";

export type SupportedCurrency = "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";

export interface EcbRateRow {
  date: string; // YYYY-MM-DD
  currency: string; // 3-letter ISO
  rate: number; // 1 EUR = rate {currency}
}

export interface DailyFxSet {
  date: string;
  rates: Map<string, number>; // currency -> rate from EUR
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class EcbFxClient {
  private readonly userAgent: string;

  constructor(userAgent = "big-capital/0.1") {
    this.userAgent = userAgent;
  }

  /**
   * Latest published reference rates (single day).
   */
  async getLatest(): Promise<DailyFxSet> {
    const xml = await this.fetchXml(ECB_DAILY_URL);
    const days = parseEcbXml(xml);
    if (days.length === 0) {
      throw new Error("ECB returned no rates");
    }
    return days[0];
  }

  /**
   * Last 90 calendar days of reference rates. Used by the daily cron to
   * backfill any days the cron missed.
   */
  async getLast90Days(): Promise<DailyFxSet[]> {
    const xml = await this.fetchXml(ECB_HIST_90D_URL);
    return parseEcbXml(xml);
  }

  /**
   * Full history back to 1999-01-04. Used once at seed time only.
   */
  async getFullHistory(): Promise<DailyFxSet[]> {
    const xml = await this.fetchXml(ECB_HIST_FULL_URL);
    return parseEcbXml(xml);
  }

  /**
   * Convenience: get every rate row as flat records suitable for DB insertion.
   *
   * Returns rows in BIG Capital's table shape: for each (from, to, date) triple
   * we want to support, a single row. We emit:
   *   EUR -> USD, EUR -> GBP   (direct from ECB)
   *   USD -> EUR, GBP -> EUR   (inverse, for the convertCurrency helper)
   *   USD -> GBP, GBP -> USD   (cross via EUR)
   *
   * This pre-computes the 6 pairs we'd otherwise compute on the fly,
   * trading a little storage for simpler reads.
   */
  static expandToFxRows(
    days: DailyFxSet[],
    currencies: SupportedCurrency[] = ["GBP", "USD", "EUR"]
  ): Array<{
    fromCurrency: SupportedCurrency;
    toCurrency: SupportedCurrency;
    date: string;
    rate: number;
  }> {
    const out: Array<{
      fromCurrency: SupportedCurrency;
      toCurrency: SupportedCurrency;
      date: string;
      rate: number;
    }> = [];

    for (const day of days) {
      // Augment rates with EUR -> EUR = 1 for cleanness in the loop
      const eurBased = new Map(day.rates);
      eurBased.set("EUR", 1);

      for (const from of currencies) {
        for (const to of currencies) {
          if (from === to) continue;
          // Both currencies are EUR-based:
          //   from -> to means: 1 unit of `from` × ? = 1 unit of `to`
          //   1 from = (1/rate_from) EUR = (rate_to/rate_from) to
          const rateFrom = eurBased.get(from);
          const rateTo = eurBased.get(to);
          if (rateFrom == null || rateTo == null) continue;
          if (rateFrom === 0) continue;
          out.push({
            fromCurrency: from,
            toCurrency: to,
            date: day.date,
            rate: rateTo / rateFrom,
          });
        }
      }
    }
    return out;
  }

  private async fetchXml(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/xml",
      },
    });
    if (!res.ok) {
      throw new Error(`ECB fetch failed ${res.status} for ${url}`);
    }
    return res.text();
  }
}

// ---------------------------------------------------------------------------
// XML parser — minimal, dependency-free
//
// The ECB feeds use a small, stable XML schema. We don't need a full DOM
// parser; a regex-based extractor against `<Cube time=...><Cube currency=
// rate=/></Cube>` patterns is robust enough and avoids pulling in xml2js.
// ---------------------------------------------------------------------------

export function parseEcbXml(xml: string): DailyFxSet[] {
  const out: DailyFxSet[] = [];
  // Match each daily block
  const dayRegex = /<Cube\s+time="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g;
  let match: RegExpExecArray | null;
  while ((match = dayRegex.exec(xml)) !== null) {
    const date = match[1];
    const body = match[2];
    const rates = new Map<string, number>();
    const rateRegex =
      /<Cube\s+currency="([A-Z]{3})"\s+rate="([\d.]+)"\s*\/>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rateRegex.exec(body)) !== null) {
      const ccy = rm[1];
      const rate = parseFloat(rm[2]);
      if (!Number.isFinite(rate)) continue;
      rates.set(ccy, rate);
    }
    out.push({ date, rates });
  }
  return out;
}
