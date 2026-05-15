/**
 * EODHD client unit tests — exercises request building, schema parsing,
 * retry logic, and error handling against mocked fetch responses.
 *
 * Live integration tests against the real API are in `eodhd-live.ts` and
 * should be run manually with a real API token.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EodhdClient, EodhdError, parseSplitRatio } from "../src/lib/eodhd";

describe("EodhdClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  // -------------------------------------------------------------------------
  // EOD prices
  // -------------------------------------------------------------------------

  it("getEodPrices parses well-formed response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse([
        {
          date: "2026-04-30",
          open: 175.50,
          high: 178.20,
          low: 174.80,
          close: 177.95,
          adjusted_close: 177.95,
          volume: 52840000,
        },
      ])
    );

    const client = new EodhdClient({ apiToken: "test_token" });
    const prices = await client.getEodPrices("AAPL", "US", "2026-04-30");

    expect(prices).toHaveLength(1);
    expect(prices[0].close).toBe(177.95);
    expect(prices[0].date).toBe("2026-04-30");

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/eod/AAPL.US");
    expect(url.searchParams.get("api_token")).toBe("test_token");
    expect(url.searchParams.get("from")).toBe("2026-04-30");
    expect(url.searchParams.get("period")).toBe("d");
  });

  it("getEodPrices rejects malformed response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse([{ date: "2026-04-30", close: "not a number" }])
    );

    const client = new EodhdClient({ apiToken: "test_token" });
    await expect(
      client.getEodPrices("AAPL", "US")
    ).rejects.toThrow(/schema mismatch/);
  });

  // -------------------------------------------------------------------------
  // Real-time quote
  // -------------------------------------------------------------------------

  it("getRealTimeQuote returns parsed quote", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        code: "AAPL.US",
        timestamp: 1714435200,
        gmtoffset: 0,
        open: 175.50,
        high: 178.20,
        low: 174.80,
        close: 177.95,
        volume: 52840000,
        previousClose: 176.10,
        change: 1.85,
        change_p: 1.05,
      })
    );

    const client = new EodhdClient({ apiToken: "test_token" });
    const quote = await client.getRealTimeQuote("AAPL", "US");
    expect(quote.close).toBe(177.95);
    expect(quote.change_p).toBe(1.05);
  });

  // -------------------------------------------------------------------------
  // Bulk EOD (the workhorse for daily NAV)
  // -------------------------------------------------------------------------

  it("getBulkEodForExchange supports symbol filtering", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse([
        {
          code: "AZN",
          exchange_short_name: "LSE",
          date: "2026-04-30",
          open: 11420,
          high: 11785,
          low: 11380,
          close: 11740,
          adjusted_close: 11740,
          volume: 2840000,
        },
        {
          code: "SHEL",
          exchange_short_name: "LSE",
          date: "2026-04-30",
          open: 2900,
          high: 3015,
          low: 2895,
          close: 3008,
          adjusted_close: 3008,
          volume: 18420000,
        },
      ])
    );

    const client = new EodhdClient({ apiToken: "test_token" });
    const rows = await client.getBulkEodForExchange(
      "LSE",
      "2026-04-30",
      ["AZN", "SHEL"]
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].code).toBe("AZN");
    expect(rows[1].close).toBe(3008);

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/eod-bulk-last-day/LSE");
    expect(url.searchParams.get("symbols")).toBe("AZN,SHEL");
    expect(url.searchParams.get("date")).toBe("2026-04-30");
  });

  // -------------------------------------------------------------------------
  // Retry logic
  // -------------------------------------------------------------------------

  it("retries on 429 and eventually succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429 })
      )
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429 })
      )
      .mockResolvedValueOnce(
        mockResponse([
          {
            date: "2026-04-30",
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            adjusted_close: 100.5,
            volume: 1000,
          },
        ])
      );

    const client = new EodhdClient({
      apiToken: "test_token",
      retryDelayMs: 1,
    });
    const prices = await client.getEodPrices("AAPL", "US");
    expect(prices).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries on 5xx and eventually succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response("server error", { status: 503 })
      )
      .mockResolvedValueOnce(
        mockResponse({
          code: "AAPL.US",
          timestamp: 1714435200,
          gmtoffset: 0,
          open: null,
          high: null,
          low: null,
          close: 177.95,
          volume: null,
          previousClose: null,
          change: null,
          change_p: null,
        })
      );

    const client = new EodhdClient({
      apiToken: "test_token",
      retryDelayMs: 1,
    });
    const q = await client.getRealTimeQuote("AAPL", "US");
    expect(q.close).toBe(177.95);
  });

  it("does not retry on 4xx (other than 429)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("forbidden", { status: 403 })
    );

    const client = new EodhdClient({
      apiToken: "test_token",
      retryDelayMs: 1,
    });
    await expect(client.getEodPrices("AAPL", "US")).rejects.toThrow(
      EodhdError
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries", async () => {
    fetchSpy.mockResolvedValue(new Response("oops", { status: 503 }));

    const client = new EodhdClient({
      apiToken: "test_token",
      retryDelayMs: 1,
      maxRetries: 2,
    });
    await expect(client.getEodPrices("AAPL", "US")).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe("parseSplitRatio", () => {
  it("parses a 2-for-1 split", () => {
    expect(parseSplitRatio("2.000000/1.000000")).toBe(2);
  });

  it("parses a 3-for-1 split", () => {
    expect(parseSplitRatio("3.0/1.0")).toBe(3);
  });

  it("parses a reverse split", () => {
    expect(parseSplitRatio("1.0/4.0")).toBe(0.25);
  });

  it("throws on malformed input", () => {
    expect(() => parseSplitRatio("not a split")).toThrow();
    expect(() => parseSplitRatio("2.0/0.0")).toThrow();
  });
});
