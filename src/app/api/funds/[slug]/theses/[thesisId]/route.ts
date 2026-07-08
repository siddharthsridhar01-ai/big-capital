/**
 * PATCH /api/funds/[slug]/theses/[thesisId]
 *
 * Edit an existing thesis — fix the summary (e.g. a typo), adjust
 * conviction / holding period / targets, and add or replace the memo PDF
 * (e.g. when a thesis was written without one and the PM wants to attach it
 * later). Multipart form, same field names and validation as thesis creation.
 *
 * This edits the thesis record only. It does NOT touch transactions, the
 * ledger, or NAV. The security a thesis is about cannot be changed here (that
 * would orphan any trades linked to it).
 *
 * Auth: the fund's admin, or the thesis author.
 */
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { theses } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq } from "drizzle-orm";

const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10 MB
const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; thesisId: string }> }
) {
  const { slug, thesisId } = await params;
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  const fund = fundRows[0];

  const existingRows = await db
    .select({ id: theses.id, authorUserId: theses.authorUserId })
    .from(theses)
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (existingRows.length === 0) return NextResponse.json({ ok: false, error: "Thesis not found" }, { status: 404 });
  const existing = existingRows[0];

  const isAuthor = existing.authorUserId === user.id;
  if (user.role !== "admin" && !isAuthor) {
    return NextResponse.json(
      { ok: false, error: "Only an admin or the thesis author can edit this thesis" },
      { status: 403 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid form data" }, { status: 400 });
  }

  const conviction = form.get("conviction");
  const holdingPeriod = form.get("holdingPeriod");
  const title = form.get("title");
  const summary = form.get("summary");
  const targetWeightPctRaw = form.get("targetWeightPct");
  const targetPriceNativeRaw = form.get("targetPriceNative");
  const memoFile = form.get("memo");

  if (conviction !== "high" && conviction !== "medium" && conviction !== "low") {
    return NextResponse.json({ ok: false, error: "conviction must be high, medium, or low" }, { status: 400 });
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
    return NextResponse.json({ ok: false, error: "summary is required" }, { status: 400 });
  }
  const summaryTrimmed = summary.trim();
  if (summaryTrimmed.length === 0 || summaryTrimmed.length > 500) {
    return NextResponse.json(
      { ok: false, error: `Summary is required (max 500 characters; got ${summaryTrimmed.length})` },
      { status: 400 }
    );
  }

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
      return NextResponse.json({ ok: false, error: "targetPriceNative must be a positive number" }, { status: 400 });
    }
    targetPriceNative = String(n);
  }

  // Base fields to update (memo handled separately, only if a new file is given).
  const updateData: Record<string, unknown> = {
    conviction,
    holdingPeriod,
    title:
      typeof title === "string" && title.trim() !== ""
        ? title.trim().slice(0, 120)
        : null,
    summary: summaryTrimmed,
    targetWeightPct,
    targetPriceNative,
    updatedAt: new Date(),
  };

  // Optional new/replacement memo PDF.
  if (memoFile && memoFile instanceof File && memoFile.size > 0) {
    if (memoFile.size > MAX_PDF_SIZE) {
      return NextResponse.json(
        { ok: false, error: `Memo PDF is ${(memoFile.size / 1024 / 1024).toFixed(1)}MB; max 10MB` },
        { status: 400 }
      );
    }
    const isLikelyPdf =
      memoFile.name.toLowerCase().endsWith(".pdf") || memoFile.type === "application/pdf";
    if (!isLikelyPdf) {
      return NextResponse.json({ ok: false, error: "Memo must be a PDF file" }, { status: 400 });
    }
    const headerBuf = await memoFile.slice(0, 4).arrayBuffer();
    const headerBytes = Array.from(new Uint8Array(headerBuf));
    const matchesPdfMagic = PDF_MAGIC_BYTES.every((b, i) => headerBytes[i] === b);
    if (!matchesPdfMagic) {
      return NextResponse.json({ ok: false, error: "File doesn't look like a valid PDF" }, { status: 400 });
    }

    const safeFilename = memoFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const blobPath = `theses/${fund.slug}/${Date.now()}_${safeFilename}`;
    try {
      const blob = await put(blobPath, memoFile, {
        access: "private",
        contentType: "application/pdf",
        addRandomSuffix: false,
      });
      updateData.memoBlobUrl = blob.url;
      updateData.memoBlobFilename = memoFile.name;
      updateData.memoSizeBytes = memoFile.size;
    } catch {
      return NextResponse.json({ ok: false, error: "Failed to upload memo PDF" }, { status: 500 });
    }
  }

  await db.update(theses).set(updateData).where(eq(theses.id, thesisId));
  return NextResponse.json({ ok: true, thesisId });
}
