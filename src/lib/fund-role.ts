/**
 * Whether a person may publish to, approve for, or trade a specific fund.
 *
 * Authority over a fund comes from the seat held IN THAT FUND, not from the
 * global role. The global role is "pm" if someone is a PM of ANY fund, so using
 * it here meant a PM of Global Equity sitting as an analyst on European Equity
 * could publish theses there without review. That is the gap this closes.
 *
 * Admins always qualify: they are platform-wide and exist to correct things.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { fundMembers } from "@/db/schema";

export async function isFundPm(
  user: { id: string; role: string },
  fundId: string
): Promise<boolean> {
  if (user.role === "admin") return true;
  const [seat] = await db
    .select({ roleInFund: fundMembers.roleInFund })
    .from(fundMembers)
    .where(
      and(eq(fundMembers.fundId, fundId), eq(fundMembers.userId, user.id), isNull(fundMembers.endDate))
    )
    .limit(1);
  return seat?.roleInFund === "pm";
}
