/**
 * Admin — a fund's limits.
 *
 *   GET  /api/admin/funds/<slug>/limits                current settings, defaults, last change
 *   PUT  /api/admin/funds/<slug>/limits  { limits }    save
 *   POST /api/admin/funds/<slug>/limits  { action: "reset" }   restore the mandate defaults
 *
 * Changes take effect on the next trade. Every save is recorded in the audit log
 * with the settings before and after, since a risk limit changed silently is a
 * limit nobody can rely on.
 *
 * A limit switched off keeps its value (is_active = false), so switching it back
 * on restores the previous figure rather than a blank.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { funds, fundConstraints, auditLog, users } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { LIMIT_CATALOGUE, SPEC_BY_TYPE, validateLimits, type LimitSetting } from "@/lib/limit-catalogue";
import { DEFAULT_LIMITS } from "@/lib/fund-limit-defaults";
import type { ConstraintType } from "@/lib/constraints";

export const dynamic = "force-dynamic";

async function context(slug: string) {
  const user = await getOrCreateUser();
  if (!user || user.role !== "admin") return { error: NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 }) };
  const [fund] = await db.select({ id: funds.id, slug: funds.slug, name: funds.name }).from(funds).where(eq(funds.slug, slug)).limit(1);
  if (!fund) return { error: NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 }) };
  return { user, fund };
}

async function currentSettings(fundId: string): Promise<LimitSetting[]> {
  const rows = await db.select().from(fundConstraints).where(eq(fundConstraints.fundId, fundId));
  // Prefer an active row where a type has several.
  const byType = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = byType.get(r.constraintType);
    if (!prev || (r.isActive && !prev.isActive)) byType.set(r.constraintType, r);
  }
  return LIMIT_CATALOGUE.map((spec) => {
    const r = byType.get(spec.type);
    return {
      type: spec.type,
      enabled: Boolean(r?.isActive),
      isHard: r ? r.isHard : spec.kind === "flag",
      value: r ? (r.value as number | boolean) : spec.kind === "flag" ? true : 0,
    };
  });
}

function defaultsFor(slug: string): LimitSetting[] {
  const d = DEFAULT_LIMITS[slug];
  return LIMIT_CATALOGUE.map((spec) => {
    const c = d?.constraints.find((x) => x.type === spec.type);
    return {
      type: spec.type,
      enabled: Boolean(c),
      isHard: c ? c.isHard : spec.kind === "flag",
      value: c ? (c.value as number | boolean) : spec.kind === "flag" ? true : 0,
    };
  });
}

/** Replace the fund's rows with `next`, and record the change. */
async function save(fundId: string, userId: string, before: LimitSetting[], next: LimitSetting[], action: string) {
  await db.transaction(async (tx) => {
    await tx.delete(fundConstraints).where(eq(fundConstraints.fundId, fundId));
    for (const s of next) {
      const spec = SPEC_BY_TYPE.get(s.type)!;
      // Write a row if the limit is on, or if it is off but carries a value worth
      // keeping for when it is switched back on.
      const meaningful = s.enabled || (spec.kind !== "flag" && Number(s.value) > 0);
      if (!meaningful) continue;
      await tx.insert(fundConstraints).values({
        fundId,
        constraintType: s.type,
        value: spec.kind === "flag" ? true : Number(s.value),
        isHard: s.isHard,
        isActive: s.enabled,
        createdByUserId: userId,
      });
    }
    await tx.insert(auditLog).values({
      userId,
      fundId,
      action,
      entityType: "fund_constraints",
      entityId: fundId,
      details: { before, after: next },
    });
  });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await context(slug);
  if ("error" in c) return c.error;

  const [last] = await db
    .select({ at: auditLog.createdAt, by: users.fullName, action: auditLog.action })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(and(eq(auditLog.fundId, c.fund.id), eq(auditLog.entityType, "fund_constraints")))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  return NextResponse.json({
    ok: true,
    fund: c.fund,
    catalogue: LIMIT_CATALOGUE,
    settings: await currentSettings(c.fund.id),
    defaults: defaultsFor(slug),
    lastChange: last ? { at: last.at, by: last.by, action: last.action } : null,
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await context(slug);
  if ("error" in c) return c.error;

  let body: { limits?: LimitSetting[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const incoming = body.limits ?? [];
  // One setting per catalogue entry, in catalogue order; ignore anything unknown.
  const next: LimitSetting[] = LIMIT_CATALOGUE.map((spec) => {
    const s = incoming.find((x) => x.type === spec.type);
    return {
      type: spec.type as ConstraintType,
      enabled: Boolean(s?.enabled),
      isHard: Boolean(s?.isHard),
      value: spec.kind === "flag" ? true : Number(s?.value ?? 0),
    };
  });

  const errors = validateLimits(next);
  if (errors.length) return NextResponse.json({ ok: false, errors }, { status: 400 });

  const before = await currentSettings(c.fund.id);
  await save(c.fund.id, c.user.id, before, next, "limits.update");
  return NextResponse.json({ ok: true, settings: await currentSettings(c.fund.id) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await context(slug);
  if ("error" in c) return c.error;

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  if (body.action !== "reset") return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  if (!DEFAULT_LIMITS[slug]) return NextResponse.json({ ok: false, error: "No defaults defined for this fund." }, { status: 400 });

  const next = defaultsFor(slug);
  const errors = validateLimits(next);
  if (errors.length) return NextResponse.json({ ok: false, errors }, { status: 400 });
  const before = await currentSettings(c.fund.id);
  await save(c.fund.id, c.user.id, before, next, "limits.reset");
  return NextResponse.json({ ok: true, settings: await currentSettings(c.fund.id) });
}
