/**
 * Fund watchlist management (the `investable_universes` link table).
 *   POST   /api/funds/[slug]/universe   { symbol }        -> add (validated, mandate-gated)
 *   DELETE /api/funds/[slug]/universe   { securityId }     -> remove (set removedDate)
 *
 * Permission: admin, or a current member of this fund.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, investableUniverses, fundMembers } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";
import { addSecurityToWatchlist } from "@/lib/universe-add";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function resolveFundAndPermission(slug: string) {
  const user = await getOrCreateUser();
  if (!user) return { error: NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 }) };

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) return { error: NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 }) };
  const fund = fundRows[0];

  if (user.role !== "admin") {
    const membership = await db
      .select()
      .from(fundMembers)
      .where(and(eq(fundMembers.fundId, fund.id), eq(fundMembers.userId, user.id), isNull(fundMembers.endDate)))
      .limit(1);
    if (membership.length === 0) {
      return { error: NextResponse.json({ ok: false, error: "You are not a member of this fund" }, { status: 403 }) };
    }
  }
  return { fund };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const { fund, error } = await resolveFundAndPermission(slug);
  if (error) return error;

  let body: { symbol?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 }); }

  const result = await addSecurityToWatchlist({ id: fund!.id, slug: fund!.slug }, body.symbol ?? "");
  return NextResponse.json(result.body, { status: result.status });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const { fund, error } = await resolveFundAndPermission(slug);
  if (error) return error;

  let body: { securityId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 }); }
  const securityId = (body.securityId ?? "").trim();
  if (!securityId) return NextResponse.json({ ok: false, error: "Missing securityId" }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  const updated = await db
    .update(investableUniverses)
    .set({ removedDate: today })
    .where(and(
      eq(investableUniverses.fundId, fund!.id),
      eq(investableUniverses.securityId, securityId),
      isNull(investableUniverses.removedDate)
    ))
    .returning({ securityId: investableUniverses.securityId });

  if (updated.length === 0) {
    return NextResponse.json({ ok: false, error: "That security isn't on the watchlist." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, removed: true });
}
