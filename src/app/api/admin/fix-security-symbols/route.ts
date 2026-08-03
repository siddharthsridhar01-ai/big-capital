/**
 * Admin — correct securities whose stored ticker no longer resolves on Yahoo.
 *
 * Two cases found on 2026-08-03, both of which had been silently failing the
 * daily close ingest with "No data found, symbol may be delisted":
 *
 *  1. PHNX (LSE) — Phoenix Group Holdings plc renamed to Standard Life plc and
 *     its LSE ticker became SDLF on 2 March 2026. Same company, same SEDOL and
 *     ISIN, so the existing security row (and any price history or holdings
 *     attached to it) stays valid — only the ticker and name change.
 *
 *  2. NOVO.B — seeded with the Copenhagen B-share ticker but a US exchange, so
 *     it resolved to nothing. The genuine Copenhagen symbol (NOVO-B.CO) quotes
 *     in DKK, which is not in our currency enum and would be skipped by the
 *     ingest anyway, so we point at the NYSE ADR (NVO, USD) instead.
 *
 * Berkshire's BRK.B is deliberately NOT handled here: its stored ticker is
 * correct market convention and the mapping fix in toYahooSymbol() now emits
 * BRK-B for Yahoo.
 *
 * Conventions: GET, secret-gated (?secret= or Authorization: Bearer), idempotent.
 * DRY RUN BY DEFAULT — pass ?apply=1 to actually write.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { securities } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface Correction {
  /** Ticker currently stored in the DB. */
  fromTicker: string;
  /** What it should become. */
  toTicker: string;
  /** Optional exchange/currency/name corrections. */
  toExchange?: string;
  toCurrency?: "GBP" | "USD" | "EUR";
  toName?: string;
  why: string;
}

const CORRECTIONS: Correction[] = [
  {
    fromTicker: "PHNX",
    toTicker: "SDLF",
    toName: "Standard Life plc",
    why: "Phoenix Group Holdings renamed to Standard Life plc; LSE ticker PHNX -> SDLF on 2026-03-02",
  },
  {
    fromTicker: "NOVO.B",
    toTicker: "NVO",
    toExchange: "NYSE",
    toCurrency: "USD",
    toName: "Novo Nordisk A/S (ADR)",
    why: "NOVO.B resolves to nothing; Copenhagen line quotes DKK (unsupported), so use the NYSE ADR",
  },
];

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const apply = url.searchParams.get("apply") === "1";
  const report: Array<Record<string, unknown>> = [];

  try {
    for (const c of CORRECTIONS) {
      const found = await db
        .select({
          id: securities.id,
          ticker: securities.ticker,
          exchange: securities.exchange,
          currency: securities.currency,
          name: securities.name,
        })
        .from(securities)
        .where(eq(securities.ticker, c.fromTicker));

      // Idempotent: if nothing matches the old ticker, check whether the new one
      // is already in place and report that rather than treating it as an error.
      if (found.length === 0) {
        const already = await db
          .select({ id: securities.id, ticker: securities.ticker })
          .from(securities)
          .where(eq(securities.ticker, c.toTicker));
        report.push({
          from: c.fromTicker,
          to: c.toTicker,
          status: already.length > 0 ? "already-applied" : "not-found",
          why: c.why,
        });
        continue;
      }

      for (const sec of found) {
        const changes: Record<string, string> = { ticker: c.toTicker };
        if (c.toExchange) changes.exchange = c.toExchange;
        if (c.toCurrency) changes.currency = c.toCurrency;
        if (c.toName) changes.name = c.toName;

        if (apply) {
          await db.update(securities).set(changes).where(eq(securities.id, sec.id));
        }

        report.push({
          from: c.fromTicker,
          to: c.toTicker,
          securityId: sec.id,
          before: { ticker: sec.ticker, exchange: sec.exchange, currency: sec.currency, name: sec.name },
          after: changes,
          status: apply ? "updated" : "would-update (dry run)",
          why: c.why,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      hint: apply ? undefined : "Dry run only. Re-run with &apply=1 to write these changes.",
      report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("fix-security-symbols failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
