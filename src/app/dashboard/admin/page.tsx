import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { serif } from "@/lib/typography";
import AdminFundsPanel from "@/components/AdminFundsPanel";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
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

  const allFunds = await db
    .select({
      id: fundsTable.id,
      slug: fundsTable.slug,
      name: fundsTable.name,
      baseCurrency: fundsTable.baseCurrency,
    })
    .from(fundsTable)
    .where(eq(fundsTable.isActive, true));

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
      <div style={{ marginTop: 14, marginBottom: 28 }}>
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
          Admin
        </div>
        <h1
          style={{
            ...serif,
            fontWeight: 400,
            fontSize: 30,
            color: "#00183A",
            margin: 0,
          }}
        >
          System administration
        </h1>
        <div
          style={{
            marginTop: 6,
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            color: "#6B6B66",
            maxWidth: 640,
            lineHeight: 1.55,
          }}
        >
          Tools for managing the fund system. Available only to users with admin
          role. Standard PMs do not see this section.
        </div>
      </div>

      <div style={{ display: "grid", gap: 28 }}>
        <section>
          <SectionLabel>Transactions</SectionLabel>
          <Link
            href="/dashboard/admin/transactions"
            style={{
              display: "block",
              background: "white",
              border: "1px solid #D9D9D2",
              padding: "16px 20px",
              fontFamily: "system-ui, sans-serif",
              fontSize: 13,
              color: "#0A0A0A",
              textDecoration: "none",
            }}
          >
            <div style={{ ...serif, fontSize: 15, color: "#00183A", marginBottom: 4 }}>
              All transactions →
            </div>
            <div style={{ color: "#6B6B66" }}>
              View every trade across every fund. Each transaction has full
              detail including PDF memos, soft-constraint overrides, and audit
              metadata.
            </div>
          </Link>
        </section>

        <section>
          <SectionLabel>Fund management</SectionLabel>
          <AdminFundsPanel funds={allFunds} />
        </section>
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
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  );
}
