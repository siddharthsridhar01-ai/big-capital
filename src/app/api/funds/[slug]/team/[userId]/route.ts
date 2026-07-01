/**
 * Team member — update / remove.
 *   PATCH  /api/funds/[slug]/team/[userId]   (multipart; updates fields + optional new headshot)
 *   DELETE /api/funds/[slug]/team/[userId]   (removes from the fund; deletes display-only profile)
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, users, fundMembers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { put } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROLES = new Set(["pm", "senior_analyst", "analyst"]);
const MAX_IMG = 5 * 1024 * 1024;

async function authFund(slug: string) {
  const admin = await getOrCreateUser();
  if (!admin) return { error: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  if (admin.role !== "admin" && admin.role !== "pm") {
    return { error: NextResponse.json({ ok: false, error: "Only PMs and admins can manage the team" }, { status: 403 }) };
  }
  const rows = await db.select({ id: fundsTable.id }).from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (rows.length === 0) return { error: NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 }) };
  return { fundId: rows[0].id };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; userId: string }> }
) {
  const { slug, userId } = await params;
  const ctx = await authFund(slug);
  if (ctx.error) return ctx.error;

  const link = await db
    .select({ userId: fundMembers.userId })
    .from(fundMembers)
    .where(and(eq(fundMembers.fundId, ctx.fundId!), eq(fundMembers.userId, userId)))
    .limit(1);
  if (link.length === 0) return NextResponse.json({ ok: false, error: "Member not found" }, { status: 404 });

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
  const linkedinUrl = str("linkedinUrl");
  const gradYearRaw = str("graduationYear");
  const removeHeadshot = form.get("removeHeadshot") === "true";

  if (!fullName) return NextResponse.json({ ok: false, error: "Name is required" }, { status: 400 });
  if (!ROLES.has(roleInFund)) return NextResponse.json({ ok: false, error: "Invalid role" }, { status: 400 });
  const graduationYear = gradYearRaw ? Number(gradYearRaw) : null;

  const userSet: Record<string, unknown> = {
    fullName,
    bio: bio || null,
    linkedinUrl: linkedinUrl || null,
    graduationYear,
    updatedAt: new Date(),
  };

  const file = form.get("headshot");
  if (file instanceof File && file.size > 0) {
    if (!file.type.startsWith("image/")) return NextResponse.json({ ok: false, error: "Headshot must be an image" }, { status: 400 });
    if (file.size > MAX_IMG) return NextResponse.json({ ok: false, error: "Headshot must be under 5 MB" }, { status: 400 });
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const ext = (file.name.split(".").pop() ?? "img").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "img";
      const blob = await put(`headshots/${userId}.${ext}`, buffer, {
        access: "private",
        contentType: file.type,
        addRandomSuffix: true,
      });
      userSet.headshotUrl = blob.url;
    } catch (err) {
      console.error("[team] headshot upload failed", err);
      return NextResponse.json({ ok: false, error: "Headshot upload failed" }, { status: 500 });
    }
  } else if (removeHeadshot) {
    userSet.headshotUrl = null;
  }

  try {
    await db.update(users).set(userSet).where(eq(users.id, userId));
    await db
      .update(fundMembers)
      .set({ roleInFund: roleInFund as "pm" | "senior_analyst" | "analyst" })
      .where(and(eq(fundMembers.fundId, ctx.fundId!), eq(fundMembers.userId, userId)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[team] update failed", err);
    return NextResponse.json({ ok: false, error: "Database write failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; userId: string }> }
) {
  const { slug, userId } = await params;
  const ctx = await authFund(slug);
  if (ctx.error) return ctx.error;

  try {
    await db.delete(fundMembers).where(and(eq(fundMembers.fundId, ctx.fundId!), eq(fundMembers.userId, userId)));
    // Clean up display-only placeholder profiles (real accounts are left intact).
    const u = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (u[0]?.email.endsWith("@bigcapital.invalid")) {
      await db.delete(users).where(eq(users.id, userId));
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[team] delete failed", err);
    return NextResponse.json({ ok: false, error: "Database write failed" }, { status: 500 });
  }
}
