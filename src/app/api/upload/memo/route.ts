/**
 * PDF memo upload endpoint.
 *
 * POST /api/upload/memo
 *
 * Accepts a multipart form-data request with a single `file` field containing
 * a PDF. Validates:
 *   - User is authenticated
 *   - User has pm or admin role
 *   - Content-type is application/pdf
 *   - First 4 bytes are %PDF (magic byte check)
 *   - Size <= 10 MB
 *   - Filename is sane
 *
 * On success, uploads the file to Vercel Blob storage and returns:
 *   { url: string, filename: string, sizeBytes: number }
 *
 * The URL is later attached to the trade record when the trade is submitted
 * (Phase 2b.4). For now the upload itself works; the trade-attachments table
 * arrives with the submit handler.
 */

import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getOrCreateUser } from "@/lib/auth";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // upload + Blob put

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const PDF_MAGIC_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

export async function POST(req: NextRequest) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (user.role !== "admin" && user.role !== "pm") {
    return NextResponse.json(
      { ok: false, error: "Only PMs and admins can upload memos" },
      { status: 403 }
    );
  }

  // Ensure Blob is configured
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Vercel Blob is not configured. Add BLOB_READ_WRITE_TOKEN to env vars.",
      },
      { status: 500 }
    );
  }

  // Parse multipart form
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid form data" },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "No file provided" },
      { status: 400 }
    );
  }

  // Validate size
  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `File too large — max 10 MB (got ${(file.size / 1024 / 1024).toFixed(1)} MB)`,
      },
      { status: 400 }
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { ok: false, error: "File is empty" },
      { status: 400 }
    );
  }

  // Validate filename
  const originalName = file.name || "memo.pdf";
  if (originalName.length > 200) {
    return NextResponse.json(
      { ok: false, error: "Filename too long (max 200 chars)" },
      { status: 400 }
    );
  }
  if (!/\.pdf$/i.test(originalName)) {
    return NextResponse.json(
      { ok: false, error: "File must have .pdf extension" },
      { status: 400 }
    );
  }

  // Validate MIME type
  if (file.type && file.type !== "application/pdf") {
    return NextResponse.json(
      {
        ok: false,
        error: `Wrong file type — expected application/pdf, got ${file.type}`,
      },
      { status: 400 }
    );
  }

  // Magic-byte check — first 4 bytes must be %PDF
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(PDF_MAGIC_BYTES)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "File does not appear to be a valid PDF (magic byte check failed)",
      },
      { status: 400 }
    );
  }

  // Normalize filename for storage path: replace non-alphanumeric with _,
  // keep .pdf extension, prefix with random UUID to avoid collisions.
  const safeBase = originalName
    .replace(/\.pdf$/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 100);
  const storagePath = `trade-memos/${randomUUID()}-${safeBase}.pdf`;

  // Upload to Blob
  try {
    const blob = await put(storagePath, buffer, {
      access: "public",
      contentType: "application/pdf",
      addRandomSuffix: false, // we already prefix with UUID
    });

    return NextResponse.json({
      ok: true,
      url: blob.url,
      filename: originalName,
      sizeBytes: file.size,
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[upload/memo] Blob put failed", err);
    return NextResponse.json(
      {
        ok: false,
        error:
          "Storage upload failed. If this persists, contact an administrator.",
      },
      { status: 500 }
    );
  }
}
