import { db } from "@/db/client";
import {
  transactions,
  funds as fundsTable,
  securities,
  users,
  tradeAttachments,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { serif, numeric } from "@/lib/typography";

export const dynamic = "force-dynamic";

export default async function AdminTransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
    .where(eq(transactions.id, id))
    .limit(1);
  if (rows.length === 0) notFound();
  const { txn, fund, security, executedBy } = rows[0];

  const attachments = await db
    .select()
    .from(tradeAttachments)
    .where(eq(tradeAttachments.transactionId, id));

  const sym = txn.currency === "GBP" ? "£" : txn.currency === "EUR" ? "€" : "$";
  const baseSym =
    fund?.baseCurrency === "GBP" ? "£" : fund?.baseCurrency === "EUR" ? "€" : "$";

  const overridden = txn.overriddenConstraints as
    | {
        violations: Array<{
          type: string;
          message: string;
          currentValue: string;
          limit: string;
        }>;
        justification?: string;
        acceptedAt?: string;
      }
    | null;

  return (
    <main style={{ padding: "28px 32px 64px" }}>
      <div style={{ marginBottom: 6 }}>
        <Link
          href="/dashboard/admin/transactions"
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
            textDecoration: "none",
          }}
        >
          ← All transactions
        </Link>
      </div>
      <div style={{ marginTop: 14 }}>
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
          {fund?.name ?? "Fund"} · Transaction
        </div>
        <h1
          style={{
            ...serif,
            fontWeight: 400,
            fontSize: 28,
            color: "#00183A",
            margin: 0,
          }}
        >
          {txn.transactionType.toUpperCase()}{" "}
          {Math.abs(Number(txn.quantity)).toLocaleString("en-GB", {
            maximumFractionDigits: 0,
          })}{" "}
          {security?.ticker ?? "—"} @ {sym}
          {Number(txn.price).toFixed(2)}
        </h1>
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            color: "#6B6B66",
            marginTop: 6,
          }}
        >
          {txn.id}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 28 }}>
        <DetailCard label="Executed at" value={new Date(txn.executedAt).toLocaleString("en-GB")} />
        <DetailCard
          label="Submitted by"
          value={executedBy?.fullName ?? executedBy?.email ?? "—"}
        />
        <DetailCard label="Fund" value={fund?.name ?? "—"} />
        <DetailCard label="Security" value={security?.name ?? "—"} />
        <DetailCard
          label="Side"
          value={txn.transactionType.toUpperCase()}
          tone={
            txn.transactionType === "buy" || txn.transactionType === "cover"
              ? "good"
              : "neutral"
          }
        />
        <DetailCard
          label="Quantity (signed)"
          value={Number(txn.quantity).toLocaleString()}
          monospace
        />
        <DetailCard
          label="Price (native)"
          value={`${sym}${Number(txn.price).toFixed(2)}`}
          monospace
        />
        <DetailCard
          label="FX to base"
          value={Number(txn.fxRateToBase).toFixed(4)}
          monospace
          tone={txn.notes?.includes("FALLBACK") ? "warn" : undefined}
        />
        <DetailCard
          label="Cash impact (native)"
          value={`${sym}${Math.abs(Number(txn.cashImpact)).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          monospace
          tone={Number(txn.cashImpact) >= 0 ? "good" : "neutral"}
        />
        <DetailCard
          label="Fee (base)"
          value={`${baseSym}${Number(txn.feeAmount).toFixed(2)}`}
          monospace
        />
      </div>

      <div style={{ marginTop: 28 }}>
        <SectionLabel>Rationale</SectionLabel>
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            padding: "16px 20px",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            color: "#0A0A0A",
            lineHeight: 1.55,
          }}
        >
          {txn.rationale}
        </div>
      </div>

      {attachments.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <SectionLabel>Attached memos</SectionLabel>
          <div style={{ display: "grid", gap: 8 }}>
            {attachments.map((a) => (
              <a
                key={a.id}
                href={a.storageUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  background: "white",
                  border: "1px solid #D9D9D2",
                  padding: "12px 16px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  fontSize: 13,
                  color: "#00183A",
                  textDecoration: "none",
                  fontFamily: "system-ui, sans-serif",
                }}
              >
                <span style={{ fontSize: 16 }}>📄</span>
                <span style={{ flex: 1 }}>{a.filename}</span>
                <span style={{ ...numeric, fontSize: 11, color: "#6B6B66" }}>
                  {(a.sizeBytes / 1024).toFixed(0)} KB
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {overridden && (
        <div style={{ marginTop: 28 }}>
          <SectionLabel>Soft constraint overrides</SectionLabel>
          <div
            style={{
              background: "#FBF3E5",
              border: "1px solid #E8D7AA",
              padding: "16px 20px",
              fontFamily: "system-ui, sans-serif",
              fontSize: 13,
              color: "#5A3F08",
            }}
          >
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
              {overridden.violations.map((v, i) => (
                <li key={i}>
                  <strong>{v.type}</strong>: {v.message}
                </li>
              ))}
            </ul>
            <div
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px solid #E8D7AA",
              }}
            >
              <strong>Justification:</strong> {overridden.justification ?? "(none)"}
            </div>
          </div>
        </div>
      )}

      {txn.notes && (
        <div style={{ marginTop: 28 }}>
          <SectionLabel>Notes</SectionLabel>
          <div
            style={{
              background: "white",
              border: "1px solid #D9D9D2",
              padding: "12px 16px",
              fontFamily: "system-ui, sans-serif",
              fontSize: 12,
              color: "#6B6B66",
            }}
          >
            {txn.notes}
          </div>
        </div>
      )}

      <div style={{ marginTop: 32 }}>
        <SectionLabel>Admin actions</SectionLabel>
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            padding: "16px 20px",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            color: "#6B6B66",
          }}
        >
          Admin-only counter-trade tooling will live here. For now, mistakes
          are corrected by entering a counter-trade through the normal trade
          ticket. Reach the fund &rarr;{" "}
          <Link
            href={`/dashboard/funds/${fund?.slug ?? ""}`}
            style={{ color: "#00183A", textDecoration: "underline" }}
          >
            {fund?.name}
          </Link>{" "}
          to enter one.
        </div>
      </div>
    </main>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "#6B6B66",
        fontWeight: 500,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function DetailCard({
  label,
  value,
  monospace,
  tone,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  tone?: "good" | "warn" | "neutral";
}) {
  const valueColor =
    tone === "good" ? "#1F5C3A" : tone === "warn" ? "#5A3F08" : "#00183A";
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #D9D9D2",
        padding: "14px 18px",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "#6B6B66",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          ...(monospace ? numeric : {}),
          color: valueColor,
          fontSize: 14,
        }}
      >
        {value}
      </div>
    </div>
  );
}
