/**
 * Admin — create the sixth fund and onboard the PM cohort.
 *
 *   GET /api/admin/seed-team?secret=<CRON_SECRET>          (dry run)
 *   GET /api/admin/seed-team?secret=...&apply=1            (writes)
 *
 * WHY PRE-SEEDING WORKS: getOrCreateUser() looks a person up by EMAIL and only
 * inserts when there is no match, so a row created here is picked up on their
 * first Clerk sign-in. Without it they would be created fresh as an `analyst`
 * (see auth.ts) and have no fund membership.
 *
 * THE ONE THING THAT CAN GO WRONG: Clerk matches on the address they actually
 * sign in with. Everyone here has both an LSE and a personal address, so the
 * LSE address is treated as canonical and everyone must sign in with it. If
 * someone signs in with a personal address they will get a SECOND row as an
 * analyst with no fund. The report flags any such duplicate so it can be fixed.
 *
 * Idempotent: users upsert on email, memberships on (fund, user, start date).
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { funds, users, fundMembers, fundConstraints, securities } from "@/db/schema";

export const dynamic = "force-dynamic";

const START_DATE = "2026-08-07";

const NEW_FUND = {
  slug: "tech-relative-value",
  name: "BIG Capital Technology Relative Value Fund",
  baseCurrency: "USD" as const,
  benchmarkTicker: "SOFR_CASH",
  inceptionDate: "2026-06-01",
  startingNav: "100000.0000",
  strategyDescription:
    "Relative-value equity fund expressing views exclusively through paired long/short positions in mega-cap technology, concentrated in hyperscalers and semiconductors. Holds roughly 2–5 pairs at a time from a coverage universe of 15–20 names, targeting relative mispricings between companies exposed to the same structural themes while neutralising market and sector risk.",
};

/**
 * Pair trading is gross-heavy and net-flat by construction, so the net cap is
 * far tighter than the long/short template and the gross cap is generous. The
 * book is deliberately concentrated (2–5 pairs), so the position cap is looser
 * than a diversified fund would carry.
 */
const NEW_FUND_CONSTRAINTS = [
  { type: "universe_only", value: true, isHard: true },
  { type: "max_gross_exposure", value: 2.0, isHard: true },
  { type: "max_net_exposure", value: 0.1, isHard: true },
  { type: "max_position_pct", value: 0.15, isHard: false },
  { type: "min_cash_pct", value: 0.0, isHard: false },
  { type: "max_cash_pct", value: 0.6, isHard: false },
  { type: "max_single_sector_pct", value: 1.0, isHard: false },
  { type: "max_position_count", value: 12, isHard: false },
];

/** LSE addresses are canonical: institutional, stable, and everyone has one. */
const TEAM: Array<{
  email: string;
  fullName: string;
  role: "admin" | "pm" | "analyst";
  funds: string[];
}> = [
  { email: "s.sridhar8@lse.ac.uk", fullName: "Siddharth Sridhar", role: "admin", funds: ["uk-equity"] },
  { email: "a.g.khan@lse.ac.uk", fullName: "Abdul Ghani Khan", role: "pm", funds: ["global-equity"] },
  { email: "c.m.w.wong@lse.ac.uk", fullName: "Charles Wong", role: "pm", funds: ["long-short"] },
  { email: "v.rawat1@lse.ac.uk", fullName: "Vedansh Rawat", role: "pm", funds: ["market-neutral"] },
  { email: "s.n.raut@lse.ac.uk", fullName: "Sampanna Raut", role: "pm", funds: ["systematic-equity"] },
  { email: "a.v.halyal@lse.ac.uk", fullName: "Abhay Halyal", role: "pm", funds: ["systematic-equity"] },
  { email: "a.andryeyev@lse.ac.uk", fullName: "Alexander Andreyev", role: "pm", funds: [NEW_FUND.slug] },
];

/** Personal addresses, checked for only so a wrong-address sign-in is visible. */
const PERSONAL = [
  "charleswongmw@gmail.com",
  "siddharthsridhar01@gmail.com",
  "ghanikhan74@gmail.com",
  "vedansh2rawat@gmail.com",
  "abhay.halyal1@gmail.com",
  "sampannaraut@outlook.com",
  "alex.andryeyev08@gmail.com",
];

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const apply = url.searchParams.get("apply") === "1";
  const report: Record<string, unknown> = {};

  try {
    // ---- 1. The sixth fund ----
    const [existingFund] = await db
      .select({ id: funds.id })
      .from(funds)
      .where(eq(funds.slug, NEW_FUND.slug))
      .limit(1);

    let fundId = existingFund?.id ?? null;

    if (!fundId) {
      const [bench] = await db
        .select({ id: securities.id })
        .from(securities)
        .where(eq(securities.ticker, NEW_FUND.benchmarkTicker))
        .limit(1);
      if (!bench) throw new Error(`Benchmark ${NEW_FUND.benchmarkTicker} not found — run db:seed first.`);

      if (apply) {
        const [created] = await db
          .insert(funds)
          .values({
            name: NEW_FUND.name,
            slug: NEW_FUND.slug,
            baseCurrency: NEW_FUND.baseCurrency,
            benchmarkSecurityId: bench.id,
            strategyDescription: NEW_FUND.strategyDescription,
            inceptionDate: NEW_FUND.inceptionDate,
            startingNav: NEW_FUND.startingNav,
          })
          .returning({ id: funds.id });
        fundId = created.id;

        for (const c of NEW_FUND_CONSTRAINTS) {
          await db.insert(fundConstraints).values({
            fundId,
            constraintType: c.type,
            value: c.value,
            isHard: c.isHard,
          });
        }
      }
      report.fund = { slug: NEW_FUND.slug, status: apply ? "created" : "would create" };
    } else {
      report.fund = { slug: NEW_FUND.slug, status: "already exists" };
    }

    // ---- 2. Users ----
    const emails = TEAM.map((t) => t.email);
    const existingUsers = await db
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(inArray(users.email, emails));
    const byEmail = new Map(existingUsers.map((u) => [u.email.toLowerCase(), u]));

    const userReport: Array<Record<string, unknown>> = [];
    for (const t of TEAM) {
      const found = byEmail.get(t.email.toLowerCase());
      if (found) {
        const needsRole = found.role !== t.role;
        if (apply && needsRole) {
          await db.update(users).set({ role: t.role }).where(eq(users.id, found.id));
        }
        userReport.push({
          email: t.email,
          status: needsRole ? (apply ? `role -> ${t.role}` : `would set role ${t.role}`) : "already correct",
        });
      } else if (apply) {
        await db
          .insert(users)
          .values({ email: t.email, fullName: t.fullName, role: t.role })
          .onConflictDoNothing({ target: users.email });
        userReport.push({ email: t.email, status: "created" });
      } else {
        userReport.push({ email: t.email, status: "would create" });
      }
    }
    report.users = userReport;

    // ---- 3. Fund memberships ----
    const allUsers = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.email, emails));
    const idByEmail = new Map(allUsers.map((u) => [u.email.toLowerCase(), u.id]));

    const allFunds = await db.select({ id: funds.id, slug: funds.slug }).from(funds);
    const fundIdBySlug = new Map(allFunds.map((f) => [f.slug, f.id]));
    if (fundId) fundIdBySlug.set(NEW_FUND.slug, fundId);

    const memberReport: Array<Record<string, unknown>> = [];
    for (const t of TEAM) {
      for (const slug of t.funds) {
        const fId = fundIdBySlug.get(slug);
        const uId = idByEmail.get(t.email.toLowerCase());
        if (!fId) {
          memberReport.push({ email: t.email, fund: slug, status: "fund not found" });
          continue;
        }
        if (!uId) {
          memberReport.push({ email: t.email, fund: slug, status: apply ? "user missing" : "pending user" });
          continue;
        }
        const existing = await db
          .select({ fundId: fundMembers.fundId })
          .from(fundMembers)
          .where(
            and(eq(fundMembers.fundId, fId), eq(fundMembers.userId, uId), isNull(fundMembers.endDate))
          )
          .limit(1);
        if (existing.length > 0) {
          memberReport.push({ email: t.email, fund: slug, status: "already assigned" });
          continue;
        }
        if (apply) {
          await db
            .insert(fundMembers)
            .values({ fundId: fId, userId: uId, roleInFund: "pm", startDate: START_DATE })
            .onConflictDoNothing();
        }
        memberReport.push({ email: t.email, fund: slug, status: apply ? "assigned as PM" : "would assign as PM" });
      }
    }
    report.memberships = memberReport;

    // ---- 4. Wrong-address sign-ins ----
    const strays = await db
      .select({ email: users.email, role: users.role })
      .from(users)
      .where(inArray(users.email, PERSONAL));
    report.personalAddressSignIns = strays.length
      ? strays
      : "none — everyone is on their LSE address";

    return NextResponse.json({
      ok: true,
      applied: apply,
      hint: apply
        ? "Everyone must sign in with their LSE address, or they will be created again as an analyst."
        : "Dry run. Re-run with &apply=1 to write.",
      ...report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("seed-team failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
