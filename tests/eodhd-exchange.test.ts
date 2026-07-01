import { describe, it, expect } from "vitest";
import { toEodhdExchange } from "../src/lib/eodhd";

describe("toEodhdExchange", () => {
  it("maps US venue aliases to EODHD's single US feed", () => {
    expect(toEodhdExchange("NASDAQ")).toBe("US");
    expect(toEodhdExchange("NYSE")).toBe("US");
    expect(toEodhdExchange("AMEX")).toBe("US");
    expect(toEodhdExchange("NYSE ARCA")).toBe("US");
    expect(toEodhdExchange("NYSEARCA")).toBe("US");
    expect(toEodhdExchange("BATS")).toBe("US");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(toEodhdExchange("nasdaq")).toBe("US");
    expect(toEodhdExchange(" NYSE ")).toBe("US");
    expect(toEodhdExchange("Nyse Arca")).toBe("US");
  });

  it("passes through codes EODHD already accepts", () => {
    expect(toEodhdExchange("LSE")).toBe("LSE");
    expect(toEodhdExchange("XETRA")).toBe("XETRA");
    expect(toEodhdExchange("PA")).toBe("PA");
    expect(toEodhdExchange("US")).toBe("US");
  });

  it("passes unknown codes through unchanged (so a bad code 404s visibly)", () => {
    expect(toEodhdExchange("MADEUP")).toBe("MADEUP");
    expect(toEodhdExchange("TSX")).toBe("TSX");
  });
});
