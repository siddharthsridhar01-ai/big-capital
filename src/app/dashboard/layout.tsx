import { getOrCreateUser } from "@/lib/auth";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { redirect } from "next/navigation";
import SearchModal from "@/components/SearchModal";
import { serif } from "@/lib/typography";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const roleLabel =
    user.role === "admin"
      ? "Admin"
      : user.role === "pm"
        ? "Portfolio Manager"
        : "Analyst";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#FAFAF7",
        color: "#0A0A0A",
      }}
    >
      <header
        style={{
          background: "white",
          borderBottom: "1px solid #D9D9D2",
          padding: "14px 32px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
          <Link
            href="/dashboard"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              textDecoration: "none",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/big-capital-icon.png"
              alt=""
              style={{ height: 44, width: "auto", display: "block" }}
            />
            <span style={{ ...serif, color: "#00183A", display: "flex", flexDirection: "column", lineHeight: 1.02 }}>
              <span style={{ fontSize: 21, fontWeight: 600, letterSpacing: "0.02em" }}>BIG</span>
              <span style={{ fontSize: 21, fontStyle: "italic", fontWeight: 400 }}>Capital</span>
            </span>
          </Link>
          <nav style={{ display: "flex", gap: 4 }}>
            <Link
              href="/dashboard"
              style={{
                fontFamily: "system-ui, sans-serif",
                fontSize: 13,
                color: "#00183A",
                background: "rgba(0,24,58,0.06)",
                padding: "6px 12px",
                borderRadius: 4,
                fontWeight: 500,
                textDecoration: "none",
              }}
            >
              Funds
            </Link>
            {user.role === "admin" && (
              <Link
                href="/dashboard/admin"
                style={{
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 13,
                  color: "#6B6B66",
                  padding: "6px 12px",
                  borderRadius: 4,
                  textDecoration: "none",
                }}
              >
                Admin
              </Link>
            )}
          </nav>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
          }}
        >
          <SearchModal />
          <span
            style={{
              background:
                user.role === "admin"
                  ? "#E8F0E8"
                  : user.role === "pm"
                    ? "#E5E5DE"
                    : "#F0EAE0",
              color:
                user.role === "admin"
                  ? "#1F5C3A"
                  : user.role === "pm"
                    ? "#00183A"
                    : "#5A3F08",
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 3,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            {roleLabel}
          </span>
          <span>{user.fullName}</span>
          <UserButton afterSignOutUrl="/" />
        </div>
      </header>
      {children}
    </div>
  );
}
