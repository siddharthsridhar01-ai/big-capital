/**
 * Team member — create.
 *   POST /api/funds/[slug]/team   (multipart/form-data)
 *
 * Creates a display profile (users row) + a fund_members link. Optional
 * headshot is uploaded to the (private) Blob store; it's served publicly via
 * GET /api/team/[userId]/headshot.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { isValidDegree } from "@/lib/degrees";
import { funds as fundsTable, users, fundMembers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { put } from "@vercel/blob";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROLES = new Set(["pm", "senior_analyst", "analyst"]);
const MAX_IMG = 5 * 1024 * 1024;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const admin = await getOrCreateUser();
  if (!admin) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (admin.role !== "admin" && admin.role !== "pm") {
    return NextResponse.json({ ok: false, error: "Only PMs and admins can manage the team" }, { status: 403 });
  }
  const { slug } = await params;

  const fundRows = await db.select({ id: fundsTable.id }).from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  const fund = fundRows[0];

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid form data" }, { status: 400 });
  }

  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const fullName = str("fullName");
  const roleInFund = str("roleInFund");
  const bio = str("bio");
  const degree = str("degree");
  const linkedinUrl = str("linkedinUrl");
  const gradYearRaw = str("graduationYear");

  if (!fullName) return NextResponse.json({ ok: false, error: "Name is required" }, { status: 400 });
  if (!ROLES.has(roleInFund)) return NextResponse.json({ ok: false, error: "Invalid role" }, { status: 400 });
  // Degree and graduation year are required: the public team pages read as a
  // firm's only when every profile carries both.
  if (!degree || !isValidDegree(degree)) {
    return NextResponse.json({ ok: false, error: "Select a degree programme" }, { status: 400 });
  }
  if (!gradYearRaw) {
    return NextResponse.json({ ok: false, error: "Select a graduation year" }, { status: 400 });
  }
  const graduationYear = Number(gradYearRaw);
  if (gradYearRaw && (!Number.isInteger(graduationYear) || graduationYear! < 1950 || graduationYear! > 2100)) {
    return NextResponse.json({ ok: false, error: "Invalid graduation year" }, { status: 400 });
  }

  const userId = randomUUID();

  // Optional headshot -> private Blob
  let headshotUrl: string | null = null;
  const file = form.get("headshot");
  if (file instanceof File && file.size > 0) {
    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ ok: false, error: "Headshot must be an image" }, { status: 400 });
    }
    if (file.size > MAX_IMG) {
      return NextResponse.json({ ok: false, error: "Headshot must be under 5 MB" }, { status: 400 });
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return NextResponse.json({ ok: false, error: "Blob storage is not configured" }, { status: 500 });
    }
    const ext = (file.name.split(".").pop() ?? "img").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "img";
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const blob = await put(`headshots/${userId}.${ext}`, buffer, {
        access: "private",
        contentType: file.type,
        addRandomSuffix: true,
      });
      headshotUrl = blob.url;
    } catch (err) {
      console.error("[team] headshot upload failed", err);
      return NextResponse.json({ ok: false, error: "Headshot upload failed" }, { status: 500 });
    }
  }

  try {
    await db.insert(users).values({
      id: userId,
      email: `team-${userId.slice(0, 8)}@bigcapital.invalid`, // display-only placeholder
      fullName,
      role: "analyst", // global app role; display profiles get no elevated access
      bio: bio || null,
      degree,
      headshotUrl,
      linkedinUrl: linkedinUrl || null,
      graduationYear,
      isActive: true,
    });
    await db.insert(fundMembers).values({
      fundId: fund.id,
      userId,
      roleInFund: roleInFund as "pm" | "senior_analyst" | "analyst",
      startDate: new Date().toISOString().slice(0, 10),
    });
    return NextResponse.json({ ok: true, id: userId });
  } catch (err) {
    console.error("[team] create failed", err);
    return NextResponse.json({ ok: false, error: "Database write failed" }, { status: 500 });
  }
}
