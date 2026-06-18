/**
 * Theses API for a fund.
 *
 * GET  /api/funds/[slug]/theses
 *      → list theses for this fund (newest first), optional ?securityId= filter
 *
 * POST /api/funds/[slug]/theses
 *      Content-Type: multipart/form-data
 *      Fields:
 *        - securityId: UUID (required)
 *        - conviction: "high" | "medium" | "low" (required)
 *        - holdingPeriod: "short" | "medium" | "long" | "indefinite" (required)
 *        - summary: string, required, max 500 chars
 *        - targetWeightPct: number 0-0.20 (optional)
 *        - targetPriceNative: number > 0 (optional)
 *        - memo: File (optional, PDF only, <10MB)
 *      → creates a thesis, uploads memo to Vercel Blob if provided
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, securities } from "@/db/schema";
import { theses } from "@/db/schema-theses";
import { eq, desc, and } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { put } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10 MB
const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

// ---------------------------------------------------------------------------
// GET — list theses for this fund
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { slug } = await params;
  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Fund not found" },
      { status: 404 }
    );
  }
  const fund = fundRows[0];

  const securityIdFilter = req.nextUrl.searchParams.get("securityId");

  const where = securityIdFilter
    ? and(
        eq(theses.fundId, fund.id),
        eq(theses.securityId, securityIdFilter)
      )
    : eq(theses.fundId, fund.id);

  const rows = await db
    .select({
      id: theses.id,
      securityId: theses.securityId,
      authorUserId: theses.authorUserId,
      openedAt: theses.openedAt,
      closedAt: theses.closedAt,
      status: theses.status,
      direction: theses.direction,
      conviction: theses.conviction,
      targetWeightPct: theses.targetWeightPct,
      targetPriceNative: theses.targetPriceNative,
      holdingPeriod: theses.holdingPeriod,
      summary: theses.summary,
      memoBlobUrl: theses.memoBlobUrl,
      memoBlobFilename: theses.memoBlobFilename,
      // Pull ticker + name from securities so the list page doesn't need
      // a second round-trip per row
      ticker: securities.ticker,
      securityName: securities.name,
      exchange: securities.exchange,
    })
    .from(theses)
    .innerJoin(securities, eq(theses.securityId, securities.id))
    .where(where)
    .orderBy(desc(theses.openedAt));

  return NextResponse.json({ ok: true, theses: rows });
}

// ---------------------------------------------------------------------------
// POST — create a new thesis
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { slug } = await params;
  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Fund not found" },
      { status: 404 }
    );
  }
  const fund = fundRows[0];

  // Parse multipart form
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid form data" },
      { status: 400 }
    );
  }

  const securityId = form.get("securityId");
  const conviction = form.get("conviction");
  const holdingPeriod = form.get("holdingPeriod");
  const summary = form.get("summary");
  const targetWeightPctRaw = form.get("targetWeightPct");
  const targetPriceNativeRaw = form.get("targetPriceNative");
  const memoFile = form.get("memo");

  // Validation
  if (typeof securityId !== "string" || securityId.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "securityId is required" },
      { status: 400 }
    );
  }
  if (
    conviction !== "high" &&
    conviction !== "medium" &&
    conviction !== "low"
  ) {
    return NextResponse.json(
      { ok: false, error: "conviction must be high, medium, or low" },
      { status: 400 }
    );
  }
  if (
    holdingPeriod !== "short" &&
    holdingPeriod !== "medium" &&
    holdingPeriod !== "long" &&
    holdingPeriod !== "indefinite"
  ) {
    return NextResponse.json(
      { ok: false, error: "holdingPeriod must be short, medium, long, or indefinite" },
      { status: 400 }
    );
  }
  if (typeof summary !== "string") {
    return NextResponse.json(
      { ok: false, error: "summary is required" },
      { status: 400 }
    );
  }
  const summaryTrimmed = summary.trim();
  if (summaryTrimmed.length === 0 || summaryTrimmed.length > 500) {
    return NextResponse.json(
      {
        ok: false,
        error: `Summary is required (max 500 characters; got ${summaryTrimmed.length})`,
      },
      { status: 400 }
    );
  }

  // Validate security belongs to this fund's universe (loose check —
  // just verify it exists. Tighter universe-membership check happens at
  // trade time anyway)
  const secRows = await db
    .select()
    .from(securities)
    .where(eq(securities.id, securityId))
    .limit(1);
  if (secRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Security not found" },
      { status: 404 }
    );
  }

  // Optional numerics
  let targetWeightPct: string | null = null;
  if (typeof targetWeightPctRaw === "string" && targetWeightPctRaw !== "") {
    const n = Number(targetWeightPctRaw);
    if (!Number.isFinite(n) || n < 0 || n > 0.5) {
      return NextResponse.json(
        { ok: false, error: "targetWeightPct must be 0-0.5 (e.g. 0.05 for 5%)" },
        { status: 400 }
      );
    }
    targetWeightPct = String(n);
  }

  let targetPriceNative: string | null = null;
  if (typeof targetPriceNativeRaw === "string" && targetPriceNativeRaw !== "") {
    const n = Number(targetPriceNativeRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json(
        { ok: false, error: "targetPriceNative must be a positive number" },
        { status: 400 }
      );
    }
    targetPriceNative = String(n);
  }

  // Optional PDF memo — validated and uploaded if present
  let memoBlobUrl: string | null = null;
  let memoBlobFilename: string | null = null;
  let memoSizeBytes: number | null = null;
  if (memoFile && memoFile instanceof File && memoFile.size > 0) {
    // Size check
    if (memoFile.size > MAX_PDF_SIZE) {
      return NextResponse.json(
        {
          ok: false,
          error: `Memo PDF is ${(memoFile.size / 1024 / 1024).toFixed(1)}MB; max 10MB`,
        },
        { status: 400 }
      );
    }
    // Extension + MIME check
    const isLikelyPdf =
      memoFile.name.toLowerCase().endsWith(".pdf") ||
      memoFile.type === "application/pdf";
    if (!isLikelyPdf) {
      return NextResponse.json(
        { ok: false, error: "Memo must be a PDF file" },
        { status: 400 }
      );
    }
    // Magic byte check — first 4 bytes should be "%PDF"
    const headerBuf = await memoFile.slice(0, 4).arrayBuffer();
    const headerBytes = Array.from(new Uint8Array(headerBuf));
    const matchesPdfMagic = PDF_MAGIC_BYTES.every(
      (b, i) => headerBytes[i] === b
    );
    if (!matchesPdfMagic) {
      return NextResponse.json(
        { ok: false, error: "File doesn't look like a valid PDF" },
        { status: 400 }
      );
    }

    // Upload to Vercel Blob (private)
    const safeFilename = memoFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const blobPath = `theses/${fund.slug}/${Date.now()}_${safeFilename}`;
    try {
      const blob = await put(blobPath, memoFile, {
        // Store is configured private; "public" is rejected by the store.
        // Retrieval is gated through the authenticated streaming route
        // GET /api/funds/[slug]/theses/[thesisId]/memo (uses get({access:"private"})).
        access: "private",
        contentType: "application/pdf",
        addRandomSuffix: false,
      });
      memoBlobUrl = blob.url;
      memoBlobFilename = memoFile.name;
      memoSizeBytes = memoFile.size;
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Memo upload failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 500 }
      );
    }
  }

  // Insert thesis
  const [inserted] = await db
    .insert(theses)
    .values({
      fundId: fund.id,
      securityId,
      authorUserId: user.id,
      conviction,
      holdingPeriod,
      summary: summaryTrimmed,
      targetWeightPct,
      targetPriceNative,
      memoBlobUrl,
      memoBlobFilename,
      memoSizeBytes,
    })
    .returning({ id: theses.id });

  return NextResponse.json({ ok: true, thesisId: inserted.id });
}
