import { describe, it, expect } from "vitest";
import { parseEcbXml, EcbFxClient } from "../src/lib/ecb-fx";

const SAMPLE_DAILY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <gesmes:Sender>
    <gesmes:name>European Central Bank</gesmes:name>
  </gesmes:Sender>
  <Cube>
    <Cube time="2026-05-15">
      <Cube currency="USD" rate="1.0832"/>
      <Cube currency="GBP" rate="0.8520"/>
      <Cube currency="JPY" rate="168.45"/>
      <Cube currency="CHF" rate="0.9745"/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const SAMPLE_HIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time="2026-05-15">
      <Cube currency="USD" rate="1.0832"/>
      <Cube currency="GBP" rate="0.8520"/>
    </Cube>
    <Cube time="2026-05-14">
      <Cube currency="USD" rate="1.0810"/>
      <Cube currency="GBP" rate="0.8515"/>
    </Cube>
    <Cube time="2026-05-13">
      <Cube currency="USD" rate="1.0795"/>
      <Cube currency="GBP" rate="0.8508"/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe("parseEcbXml", () => {
  it("parses a single daily block", () => {
    const days = parseEcbXml(SAMPLE_DAILY_XML);
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe("2026-05-15");
    expect(days[0].rates.get("USD")).toBe(1.0832);
    expect(days[0].rates.get("GBP")).toBe(0.852);
    expect(days[0].rates.get("JPY")).toBe(168.45);
  });

  it("parses multiple days in chronological order as published", () => {
    const days = parseEcbXml(SAMPLE_HIST_XML);
    expect(days).toHaveLength(3);
    expect(days[0].date).toBe("2026-05-15");
    expect(days[1].date).toBe("2026-05-14");
    expect(days[2].date).toBe("2026-05-13");
  });

  it("returns empty array on empty input", () => {
    expect(parseEcbXml("")).toEqual([]);
    expect(parseEcbXml("<empty/>")).toEqual([]);
  });

  it("skips malformed rate entries gracefully", () => {
    const xml = `
      <Cube time="2026-05-15">
        <Cube currency="USD" rate="1.0832"/>
        <Cube currency="BAD" rate="not_a_number"/>
        <Cube currency="GBP" rate="0.8520"/>
      </Cube>
    `;
    const days = parseEcbXml(xml);
    expect(days[0].rates.size).toBe(2); // BAD skipped
    expect(days[0].rates.has("BAD")).toBe(false);
  });
});

describe("EcbFxClient.expandToFxRows", () => {
  it("expands EUR-based rates to all directional pairs", () => {
    const days = parseEcbXml(SAMPLE_DAILY_XML);
    const rows = EcbFxClient.expandToFxRows(days, ["GBP", "USD", "EUR"]);

    // 3 currencies × 2 (excluding identity) = 6 pairs per day
    expect(rows).toHaveLength(6);

    const find = (from: string, to: string) =>
      rows.find((r) => r.fromCurrency === from && r.toCurrency === to);

    // EUR -> USD direct from ECB (1.0832)
    expect(find("EUR", "USD")!.rate).toBeCloseTo(1.0832, 6);
    // USD -> EUR is the inverse
    expect(find("USD", "EUR")!.rate).toBeCloseTo(1 / 1.0832, 6);
    // EUR -> GBP direct (0.852)
    expect(find("EUR", "GBP")!.rate).toBeCloseTo(0.852, 6);
    // GBP -> EUR inverse
    expect(find("GBP", "EUR")!.rate).toBeCloseTo(1 / 0.852, 6);
    // GBP -> USD cross: 1 GBP = (1/0.852) EUR = (1/0.852)*1.0832 USD
    expect(find("GBP", "USD")!.rate).toBeCloseTo(1.0832 / 0.852, 6);
    // USD -> GBP cross
    expect(find("USD", "GBP")!.rate).toBeCloseTo(0.852 / 1.0832, 6);
  });

  it("verifies round-trip conversion is identity", () => {
    const days = parseEcbXml(SAMPLE_DAILY_XML);
    const rows = EcbFxClient.expandToFxRows(days);
    const rateGbpUsd = rows.find(
      (r) => r.fromCurrency === "GBP" && r.toCurrency === "USD"
    )!.rate;
    const rateUsdGbp = rows.find(
      (r) => r.fromCurrency === "USD" && r.toCurrency === "GBP"
    )!.rate;
    // GBP -> USD -> GBP should equal 1
    expect(rateGbpUsd * rateUsdGbp).toBeCloseTo(1, 10);
  });

  it("expands multiple days correctly", () => {
    const days = parseEcbXml(SAMPLE_HIST_XML);
    const rows = EcbFxClient.expandToFxRows(days, ["GBP", "USD", "EUR"]);
    // 3 days × 6 pairs = 18 rows
    expect(rows).toHaveLength(18);

    const dates = new Set(rows.map((r) => r.date));
    expect(dates).toEqual(new Set(["2026-05-13", "2026-05-14", "2026-05-15"]));
  });
});
