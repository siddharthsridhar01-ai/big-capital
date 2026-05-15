import { db } from "@/db/client";
import {
  transactions,
  funds as fundsTable,
  securities,
  users,
  tradeAttachments,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { serif, numeric } from "@/lib/typography";

export const dynamic = "force-dynamic";

export default async function AdminTransactionsPage() {
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");
  if (user.role !== "admin") {
    return (
      <main style={{ padding: "28px 32px" }}>
        <div
          style={{
            background: "#FAEAEA",
            border: "1px solid #E0B8B8",
            color: "#7A1F1F",
            padding: "16px 20px",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          Admin role required.
        </div>
      </main>
    );
  }

  // Load all transactions across all funds, joined with metadata
  const rows = await db
    .select({
      txn: transactions,
      fund: fundsTable,
      security: securities,
      executedBy: users,
    })
    .from(transactions)
    .leftJoin(fundsTable, eq(transactions.fundId, fundsTable.id))
    .leftJoin(securities, eq(transactions.securityId, securities.id))
    .leftJoin(users, eq(transactions.executedByUserId, users.id))
    .orderBy(desc(transactions.executedAt))
    .limit(200);

  // For each transaction, check if it has an attachment
  const attachments = await db.select().from(tradeAttachments);
  const hasAttachment = new Map<string, boolean>();
  for (const a of attachments) hasAttachment.set(a.transactionId, true);

  return (
    <main style={{ padding: "28px 32px 64px" }}>
      <div style={{ marginBottom: 6 }}>
        <Link
          href="/dashboard"
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
            textDecoration: "none",
          }}
        >
          ← Dashboard
        </Link>
      </div>
      <div style={{ marginTop: 16, marginBottom: 24 }}>
        <div
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#6B6B66",
            fontWeight: 500,
            marginBottom: 6,
          }}
        >
          Admin · Transactions
        </div>
        <h1 style={{ ...serif, fontWeight: 400, fontSize: 30, color: "#00183A", margin: 0 }}>
          All transactions
        </h1>
        <div
          style={{
            marginTop: 6,
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
          }}
        >
          {rows.length} transaction{rows.length === 1 ? "" : "s"} across all funds (showing most recent 200)
        </div>
      </div>

      {rows.length === 0 ? (
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            padding: "24px 28px",
            textAlign: "center",
            color: "#6B6B66",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          No transactions yet.
        </div>
      ) : (
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Date", "Fund", "Side", "Ticker", "Qty", "Price", "Cash impact", "Memo", "By", ""].map((h) => (
                  <th
                    key={h}
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "#6B6B66",
                      borderBottom: "1px solid #E5E5DE",
                      padding: "10px 12px",
                      fontWeight: 500,
                      textAlign: ["Qty", "Price", "Cash impact"].includes(h) ? "right" : "left",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ txn, fund, security, executedBy }) => {
                const sym =
                  txn.currency === "GBP" ? "£" : txn.currency === "EUR" ? "€" : "$";
                const baseSym =
                  fund?.baseCurrency === "GBP"
                    ? "£"
                    : fund?.baseCurrency === "EUR"
                      ? "€"
                      : "$";
                const cashImpactBase = Number(txn.cashImpact) * Number(txn.fxRateToBase);
                return (
                  <tr key={txn.id}>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                        color: "#6B6B66",
                        fontSize: 11,
                      }}
                    >
                      {new Date(txn.executedAt).toLocaleString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        year: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                        color: "#00183A",
                      }}
                    >
                      {fund ? (
                        <Link
                          href={`/dashboard/funds/${fund.slug}`}
                          style={{ color: "#00183A", textDecoration: "none" }}
                        >
                          {fund.slug}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                        fontSize: 10,
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        fontWeight: 600,
                        color:
                          txn.transactionType === "buy" || txn.transactionType === "cover"
                            ? "#1F5C3A"
                            : "#7A1F1F",
                      }}
                    >
                      {txn.transactionType}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                        fontFamily: "ui-monospace, monospace",
                        color: "#00183A",
                      }}
                    >
                      {security?.ticker ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        ...numeric,
                      }}
                    >
                      {Math.abs(Number(txn.quantity)).toFixed(0)}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        ...numeric,
                        color: "#6B6B66",
                      }}
                    >
                      {sym}
                      {Number(txn.price).toFixed(2)}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        ...numeric,
                        color: cashImpactBase >= 0 ? "#1F5C3A" : "#7A1F1F",
                      }}
                    >
                      {cashImpactBase >= 0 ? "+" : "−"}
                      {baseSym}
                      {Math.abs(cashImpactBase).toLocaleString("en-GB", {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      })}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                        color: "#6B6B66",
                      }}
                    >
                      {hasAttachment.get(txn.id) ? "📄" : ""}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                        color: "#6B6B66",
                        fontSize: 11,
                      }}
                    >
                      {executedBy?.fullName ?? executedBy?.email ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid #F0EFEA",
                      }}
                    >
                      <Link
                        href={`/dashboard/admin/transactions/${txn.id}`}
                        style={{
                          color: "#00183A",
                          textDecoration: "none",
                          fontSize: 11,
                        }}
                      >
                        Details →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
