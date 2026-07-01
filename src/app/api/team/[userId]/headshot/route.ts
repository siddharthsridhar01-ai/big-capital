/**
 * Public headshot stream (no auth) for the investment-team section.
 *   GET /api/team/[userId]/headshot
 *
 * Headshots live in the private Blob store (the store rejects public access),
 * so we stream them through this unauthenticated route. Only the image bytes
 * are exposed — nothing else about the user.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { get } from "@vercel/blob";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;

  const rows = await db
    .select({ headshotUrl: users.headshotUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const headshotUrl = rows[0]?.headshotUrl;
  if (!headshotUrl) {
    return new NextResponse("Not found", { status: 404 });
  }

  // External URLs (e.g. a Clerk avatar) can be redirected to directly.
  if (!headshotUrl.includes("blob.vercel-storage.com")) {
    return NextResponse.redirect(headshotUrl);
  }

  try {
    const result = await get(headshotUrl, { access: "private" });
    if (!result) return new NextResponse("Not found", { status: 404 });
    return new NextResponse(result.stream, {
      headers: {
        "Content-Type": result.blob.contentType ?? "image/jpeg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
