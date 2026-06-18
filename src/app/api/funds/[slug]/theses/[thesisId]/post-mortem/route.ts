/**
 * Thesis post-mortem API.
 *
 * POST /api/funds/[slug]/theses/[thesisId]/post-mortem
 *   Content-Type: multipart/form-data
 *   Fields:
 *     - outcome: "win" | "loss" | "break_even"   (required)
 *     - lessonsLearned: string                    (required, non-empty)
 *     - whatWorked: string                        (optional)
 *     - whatDidntWork: string                     (optional)
 *     - realisedReturnPct: number                 (optional, stored as a
 *           percentage value, e.g. 12.5 means +12.5%)
 *     - attachment: File                          (optional, PDF only, <10MB)
 *
 * Only a thesis in "closed" status can be reviewed; this both enforces the
 * lifecycle (a live thesis has no outcome yet) and prevents duplicate
 * post-mortems. On success the thesis moves to "post_mortem".
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { theses, thesisPostMortems } from "@/db/schema-theses";
import { eq, and } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { put } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10 MB
const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; thesisId: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { slug, thesisId } = await params;

  // Resolve fund
  const fundRows = await db
    .select({ id: fundsTable.id, slug: fundsTable.slug })
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

  // Resolve thesis + verify it belongs to this fund
  const thesisRows = await db
    .select({ id: theses.id, fundId: theses.fundId, status: theses.status })
    .from(theses)
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (thesisRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Thesis not found" },
      { status: 404 }
    );
  }
  const thesis = thesisRows[0];

  // Lifecycle gate: only a closed thesis can be reviewed.
  if (thesis.status !== "closed") {
    const reason =
      thesis.status === "active"
        ? "This thesis is still live — a post-mortem can only be written after the position closes."
        : thesis.status === "post_mortem"
          ? "This thesis has already been reviewed."
          : "This thesis was abandoned and cannot be reviewed.";
    return NextResponse.json({ ok: false, error: reason }, { status: 400 });
  }

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

  const outcome = form.get("outcome");
  const lessonsLearned = form.get("lessonsLearned");
  const whatWorkedRaw = form.get("whatWorked");
  const whatDidntWorkRaw = form.get("whatDidntWork");
  const realisedReturnPctRaw = form.get("realisedReturnPct");
  const attachmentFile = form.get("attachment");

  // Validation
  if (outcome !== "win" && outcome !== "loss" && outcome !== "break_even") {
    return NextResponse.json(
      { ok: false, error: "outcome must be win, loss, or break_even" },
      { status: 400 }
    );
  }
  if (typeof lessonsLearned !== "string") {
    return NextResponse.json(
      { ok: false, error: "lessonsLearned is required" },
      { status: 400 }
    );
  }
  const lessonsTrimmed = lessonsLearned.trim();
  if (lessonsTrimmed.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Lessons learned is required`,
      },
      { status: 400 }
    );
  }

  const whatWorked =
    typeof whatWorkedRaw === "string" && whatWorkedRaw.trim() !== ""
      ? whatWorkedRaw.trim()
      : null;
  const whatDidntWork =
    typeof whatDidntWorkRaw === "string" && whatDidntWorkRaw.trim() !== ""
      ? whatDidntWorkRaw.trim()
      : null;

  // realisedReturnPct stored as the percentage value the user typed (e.g.
  // 12.5 = +12.5%). numeric(8,4) comfortably holds it.
  let realisedReturnPct: string | null = null;
  if (
    typeof realisedReturnPctRaw === "string" &&
    realisedReturnPctRaw.trim() !== ""
  ) {
    const n = Number(realisedReturnPctRaw);
    if (!Number.isFinite(n) || n < -9999 || n > 9999) {
      return NextResponse.json(
        { ok: false, error: "realisedReturnPct must be a number (percentage)" },
        { status: 400 }
      );
    }
    realisedReturnPct = String(n);
  }

  // Optional PDF attachment — validated + uploaded (private store)
  let attachmentBlobUrl: string | null = null;
  let attachmentBlobFilename: string | null = null;
  if (
    attachmentFile &&
    attachmentFile instanceof File &&
    attachmentFile.size > 0
  ) {
    if (attachmentFile.size > MAX_PDF_SIZE) {
      return NextResponse.json(
        {
          ok: false,
          error: `Attachment is ${(attachmentFile.size / 1024 / 1024).toFixed(1)}MB; max 10MB`,
        },
        { status: 400 }
      );
    }
    const isLikelyPdf =
      attachmentFile.name.toLowerCase().endsWith(".pdf") ||
      attachmentFile.type === "application/pdf";
    if (!isLikelyPdf) {
      return NextResponse.json(
        { ok: false, error: "Attachment must be a PDF file" },
        { status: 400 }
      );
    }
    const headerBuf = await attachmentFile.slice(0, 4).arrayBuffer();
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

    const safeFilename = attachmentFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const blobPath = `post-mortems/${fund.slug}/${thesisId}/${Date.now()}_${safeFilename}`;
    try {
      const blob = await put(blobPath, attachmentFile, {
        // Private store — retrieval is via the authenticated streaming route
        // GET /api/funds/[slug]/theses/[thesisId]/post-mortem/attachment.
        access: "private",
        contentType: "application/pdf",
        addRandomSuffix: false,
      });
      attachmentBlobUrl = blob.url;
      attachmentBlobFilename = attachmentFile.name;
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `Attachment upload failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 500 }
      );
    }
  }

  // Write the post-mortem and flip the thesis to "post_mortem".
  try {
    await db.insert(thesisPostMortems).values({
      thesisId,
      authorUserId: user.id,
      outcome,
      realisedReturnPct,
      whatWorked,
      whatDidntWork,
      lessonsLearned: lessonsTrimmed,
      attachmentBlobUrl,
      attachmentBlobFilename,
    });

    await db
      .update(theses)
      .set({ status: "post_mortem", updatedAt: new Date() })
      .where(eq(theses.id, thesisId));
  } catch (err) {
    console.error("[post-mortem] write failed:", err);
    return NextResponse.json(
      { ok: false, error: "Database write failed. The post-mortem was not recorded." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    redirectTo: `/dashboard/funds/${slug}/theses/${thesisId}`,
  });
}
