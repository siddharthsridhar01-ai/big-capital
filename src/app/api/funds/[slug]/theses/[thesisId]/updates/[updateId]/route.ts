/**
 * PATCH /api/funds/[slug]/theses/[thesisId]/updates/[updateId]
 *
 * Edit an existing thesis update — fix the note, correct a mis-typed revised
 * conviction / holding period / target weight / target price, or add/replace
 * the attachment PDF. Multipart form, same field names as creating an update.
 *
 * Metadata only: this never touches transactions, the ledger, or NAV.
 * Auth: the fund admin, or the author of the update.
 */
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { theses, thesisUpdates } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq } from "drizzle-orm";

const MAX_PDF_SIZE = 10 * 1024 * 1024;
const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; thesisId: string; updateId: string }> }
) {
  const { slug, thesisId, updateId } = await params;
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  const fund = fundRows[0];

  // Confirm the thesis belongs to the fund.
  const thRows = await db
    .select({ id: theses.id })
    .from(theses)
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (thRows.length === 0) return NextResponse.json({ ok: false, error: "Thesis not found" }, { status: 404 });

  const updRows = await db
    .select({ id: thesisUpdates.id, authorUserId: thesisUpdates.authorUserId })
    .from(thesisUpdates)
    .where(and(eq(thesisUpdates.id, updateId), eq(thesisUpdates.thesisId, thesisId)))
    .limit(1);
  if (updRows.length === 0) return NextResponse.json({ ok: false, error: "Update not found" }, { status: 404 });

  const isAuthor = updRows[0].authorUserId === user.id;
  if (user.role !== "admin" && !isAuthor) {
    return NextResponse.json(
      { ok: false, error: "Only an admin or the update's author can edit it" },
      { status: 403 }
    );
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

  const convRaw = form.get("conviction");
  let newConviction: string | null = null;
  if (convRaw === "high" || convRaw === "medium" || convRaw === "low") newConviction = convRaw;

  const periodRaw = form.get("holdingPeriod");
  let newHoldingPeriod: string | null = null;
  if (periodRaw === "short" || periodRaw === "medium" || periodRaw === "long" || periodRaw === "indefinite") {
    newHoldingPeriod = periodRaw;
  }

  const twRaw = form.get("targetWeightPct");
  let newTargetWeightPct: string | null = null;
  if (typeof twRaw === "string" && twRaw !== "") {
    const n = Number(twRaw);
    if (!Number.isFinite(n) || n < 0 || n > 50) {
      return NextResponse.json({ ok: false, error: "Target weight must be 0–50 (%)" }, { status: 400 });
    }
    newTargetWeightPct = String(n / 100);
  }

  const tpRaw = form.get("targetPriceNative");
  let newTargetPriceNative: string | null = null;
  if (typeof tpRaw === "string" && tpRaw !== "") {
    const n = Number(tpRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ ok: false, error: "Target price must be positive" }, { status: 400 });
    }
    newTargetPriceNative = String(n);
  }

  const updateData: Record<string, unknown> = {
    note,
    title,
    newConviction,
    newHoldingPeriod,
    newTargetWeightPct,
    newTargetPriceNative,
  };

  const file = form.get("attachment");
  if (file && file instanceof File && file.size > 0) {
    if (file.size > MAX_PDF_SIZE) {
      return NextResponse.json({ ok: false, error: "Attachment exceeds 10MB" }, { status: 400 });
    }
    const isLikelyPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
    if (!isLikelyPdf) {
      return NextResponse.json({ ok: false, error: "Attachment must be a PDF" }, { status: 400 });
    }
    const header = Array.from(new Uint8Array(await file.slice(0, 4).arrayBuffer()));
    if (!PDF_MAGIC_BYTES.every((b, i) => header[i] === b)) {
      return NextResponse.json({ ok: false, error: "File doesn't look like a valid PDF" }, { status: 400 });
    }
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    try {
      const blob = await put(`theses/${fund.slug}/updates/${Date.now()}_${safe}`, file, {
        access: "private",
        contentType: "application/pdf",
        addRandomSuffix: false,
      });
      updateData.attachmentBlobUrl = blob.url;
      updateData.attachmentBlobFilename = file.name;
    } catch {
      return NextResponse.json({ ok: false, error: "Failed to upload attachment" }, { status: 500 });
    }
  }

  await db.update(thesisUpdates).set(updateData).where(eq(thesisUpdates.id, updateId));
  return NextResponse.json({ ok: true, updateId });
}
