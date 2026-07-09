/**
 * Thesis updates API (standalone, with optional revisions + PDF).
 *
 * POST /api/funds/[slug]/theses/[thesisId]/updates
 *   Content-Type: multipart/form-data
 *   Fields:
 *     - note: string                     (required, non-empty)
 *     - conviction?: high|medium|low      (optional revision)
 *     - holdingPeriod?: short|medium|long|indefinite (optional revision)
 *     - targetWeightPct?: number          (optional revision, as % e.g. 5 = 5%)
 *     - targetPriceNative?: number        (optional revision)
 *     - attachment?: File                 (optional PDF, <10MB)
 *
 * Records a revision as a timeline entry. The theses row is left as the
 * original opening snapshot; revisions accumulate as updates.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, securities, prices } from "@/db/schema";
import { theses, thesisUpdates } from "@/db/schema-theses";
import { eq, and, desc } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { put } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_PDF_SIZE = 10 * 1024 * 1024;
const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46];

const CONVICTIONS = ["high", "medium", "low"];
const PERIODS = ["short", "medium", "long", "indefinite"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; thesisId: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { slug, thesisId } = await params;

  const fundRows = await db
    .select({ id: fundsTable.id })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  }
  const fund = fundRows[0];

  const thesisRows = await db
    .select({ id: theses.id, status: theses.status, securityId: theses.securityId })
    .from(theses)
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (thesisRows.length === 0) {
    return NextResponse.json({ ok: false, error: "Thesis not found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid form data" }, { status: 400 });
  }

  const noteRaw = form.get("note");
  if (typeof noteRaw !== "string" || noteRaw.trim().length === 0) {
    return NextResponse.json({ ok: false, error: "Update note is required" }, { status: 400 });
  }
  const note = noteRaw.trim();

  const titleRaw = form.get("title");
  const title = typeof titleRaw === "string" && titleRaw.trim() !== "" ? titleRaw.trim().slice(0, 120) : null;

  // Optional revisions
  const convRaw = form.get("conviction");
  let newConviction: string | null = null;
  if (typeof convRaw === "string" && convRaw.trim() !== "") {
    if (!CONVICTIONS.includes(convRaw)) {
      return NextResponse.json({ ok: false, error: "Invalid conviction" }, { status: 400 });
    }
    newConviction = convRaw;
  }

  const periodRaw = form.get("holdingPeriod");
  let newHoldingPeriod: string | null = null;
  if (typeof periodRaw === "string" && periodRaw.trim() !== "") {
    if (!PERIODS.includes(periodRaw)) {
      return NextResponse.json({ ok: false, error: "Invalid holding period" }, { status: 400 });
    }
    newHoldingPeriod = periodRaw;
  }

  const twRaw = form.get("targetWeightPct");
  let newTargetWeightPct: string | null = null;
  if (typeof twRaw === "string" && twRaw.trim() !== "") {
    const n = Number(twRaw);
    if (!Number.isFinite(n) || n < 0 || n > 50) {
      return NextResponse.json({ ok: false, error: "Target weight must be 0-50%" }, { status: 400 });
    }
    newTargetWeightPct = String(n / 100); // store as fraction, matching theses
  }

  const tpRaw = form.get("targetPriceNative");
  let newTargetPriceNative: string | null = null;
  if (typeof tpRaw === "string" && tpRaw.trim() !== "") {
    const n = Number(tpRaw);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ ok: false, error: "Invalid target price" }, { status: 400 });
    }
    newTargetPriceNative = String(n);
  }

  // Optional PDF
  let attachmentBlobUrl: string | null = null;
  let attachmentBlobFilename: string | null = null;
  const file = form.get("attachment");
  if (file && file instanceof File && file.size > 0) {
    if (file.size > MAX_PDF_SIZE) {
      return NextResponse.json(
        { ok: false, error: `Attachment is ${(file.size / 1024 / 1024).toFixed(1)}MB; max 10MB` },
        { status: 400 }
      );
    }
    const looksPdf =
      file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
    if (!looksPdf) {
      return NextResponse.json({ ok: false, error: "Attachment must be a PDF" }, { status: 400 });
    }
    const head = Array.from(new Uint8Array(await file.slice(0, 4).arrayBuffer()));
    if (!PDF_MAGIC_BYTES.every((b, i) => head[i] === b)) {
      return NextResponse.json({ ok: false, error: "File doesn't look like a valid PDF" }, { status: 400 });
    }
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `thesis-updates/${fund.id}/${thesisId}/${Date.now()}_${safe}`;
    try {
      const blob = await put(path, file, {
        access: "private",
        contentType: "application/pdf",
        addRandomSuffix: false,
      });
      attachmentBlobUrl = blob.url;
      attachmentBlobFilename = file.name;
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `Attachment upload failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      );
    }
  }

  // Capture reference price (latest stored close) at the moment of this update.
  let referencePriceNative: string | null = null;
  const refRows = await db
    .select({ closePrice: prices.closePrice })
    .from(prices)
    .where(eq(prices.securityId, thesisRows[0].securityId))
    .orderBy(desc(prices.date))
    .limit(1);
  if (refRows.length > 0) referencePriceNative = refRows[0].closePrice;

  try {
    await db.insert(thesisUpdates).values({
      thesisId,
      authorUserId: user.id,
      transactionId: null,
      note,
      title,
      newConviction,
      newHoldingPeriod,
      newTargetWeightPct,
      newTargetPriceNative,
      referencePriceNative,
      attachmentBlobUrl,
      attachmentBlobFilename,
    });
  } catch (err) {
    console.error("[thesis updates] write failed:", err);
    return NextResponse.json({ ok: false, error: "Database write failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
