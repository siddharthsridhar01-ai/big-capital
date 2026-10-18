/**
 * Admin — rebuild sign-in status from Clerk.
 *
 *   GET /api/admin/reconcile-signins?secret=<CRON_SECRET>        (dry run)
 *   GET /api/admin/reconcile-signins?secret=...&apply=1          (writes)
 *
 * The first-sign-in migration backdated every real-email row to its createdAt,
 * on the assumption that only a sign-in created such a row. That was wrong:
 * seed-team also created real-email rows for people who had never logged in, so
 * they were marked active when they had not onboarded at all.
 *
 * Clerk is the authority — an account exists there only if someone created it.
 * This asks Clerk for every registered address and resets the flag to match:
 * stamped for people who really have an account, cleared for those who do not.
 */
import { NextRequest, NextResponse } from "next/server";
import { inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const apply = url.searchParams.get("apply") === "1";

  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, error: "CLERK_SECRET_KEY not set" }, { status: 500 });
  }

  try {
    // Page through Clerk's users and collect every verified address.
    const registered = new Set<string>();
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const res = await fetch(
        `https://api.clerk.com/v1/users?limit=100&offset=${offset}`,
        { headers: { Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) {
        return NextResponse.json(
          { ok: false, error: `Clerk returned ${res.status}` },
          { status: 502 }
        );
      }
      const batch = (await res.json()) as Array<{
        email_addresses?: Array<{ email_address?: string }>;
      }>;
      for (const u of batch) {
        for (const e of u.email_addresses ?? []) {
          if (e.email_address) registered.add(e.email_address.toLowerCase());
        }
      }
      if (batch.length < 100) break;
      offset += 100;
    }

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        secondaryEmail: users.secondaryEmail,
        fullName: users.fullName,
        firstSignInAt: users.firstSignInAt,
      })
      .from(users);

    const hasAccount = (r: (typeof rows)[number]) =>
      registered.has(r.email.toLowerCase()) ||
      (r.secondaryEmail ? registered.has(r.secondaryEmail.toLowerCase()) : false);

    const toClear = rows.filter((r) => r.firstSignInAt && !hasAccount(r));
    const toStamp = rows.filter((r) => !r.firstSignInAt && hasAccount(r));

    if (apply) {
      if (toClear.length > 0) {
        await db
          .update(users)
          .set({ firstSignInAt: null })
          .where(inArray(users.id, toClear.map((r) => r.id)));
      }
      if (toStamp.length > 0) {
        await db
          .update(users)
          .set({ firstSignInAt: new Date() })
          .where(inArray(users.id, toStamp.map((r) => r.id)));
      }
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      clerkAccounts: registered.size,
      correctedToNotSignedIn: toClear.map((r) => `${r.fullName} (${r.email})`),
      correctedToSignedIn: toStamp.map((r) => `${r.fullName} (${r.email})`),
      hint: apply ? undefined : "Dry run. Re-run with &apply=1 to write.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("reconcile-signins failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
