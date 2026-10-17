/**
 * Feature or unfeature a thesis on the public fund page.
 *
 *   POST /api/funds/<slug>/theses/<thesisId>/feature
 *        { featured: boolean, acknowledgeDisclosure?: boolean }
 *
 * The fund's PM decides. Only approved theses can be featured — publishing
 * unreviewed research would bypass the approval the analyst's work went through.
 *
 * Featuring an open, undisclosed position reveals it ahead of the holdings lag.
 * The PM must acknowledge that explicitly, and a fund with featureDisclosedOnly
 * set will not allow it at all.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { funds } from "@/db/schema";
import { theses } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { isFundPm } from "@/lib/fund-role";
import { featureSafety } from "@/lib/feature-safety";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; thesisId: string }> }
) {
  const { slug, thesisId } = await params;
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });

  const [fund] = await db
    .select({ id: funds.id, featureDisclosedOnly: funds.featureDisclosedOnly })
    .from(funds)
    .where(eq(funds.slug, slug))
    .limit(1);
  if (!fund) return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });

  if (!(await isFundPm(user, fund.id))) {
    return NextResponse.json({ ok: false, error: "Only the fund's PM can feature theses." }, { status: 403 });
  }

  let body: { featured?: boolean; acknowledgeDisclosure?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const featured = Boolean(body.featured);

  const [t] = await db
    .select({
      id: theses.id,
      status: theses.status,
      approvalStatus: theses.approvalStatus,
      securityId: theses.securityId,
    })
    .from(theses)
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (!t) return NextResponse.json({ ok: false, error: "Thesis not found" }, { status: 404 });

  if (featured) {
    if (t.approvalStatus !== "approved") {
      return NextResponse.json(
        { ok: false, error: "Only approved theses can be featured." },
        { status: 400 }
      );
    }

    const safety = await featureSafety(fund.id, t);
    if (!safety.safe) {
      if (fund.featureDisclosedOnly) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "This fund only features closed or already-disclosed positions. This position is open and has not been published yet.",
          },
          { status: 400 }
        );
      }
      if (!body.acknowledgeDisclosure) {
        return NextResponse.json(
          {
            ok: false,
            needsAcknowledgement: true,
            error:
              "This position is open and not yet disclosed. Featuring it publishes the holding ahead of your disclosure lag.",
          },
          { status: 409 }
        );
      }
    }
  }

  await db
    .update(theses)
    .set({ isFeatured: featured, featuredAt: featured ? new Date() : null })
    .where(eq(theses.id, thesisId));

  return NextResponse.json({ ok: true, featured });
}
