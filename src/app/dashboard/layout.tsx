import { getOrCreateUser } from "@/lib/auth";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { redirect } from "next/navigation";

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
        fontFamily: "Georgia, 'Source Serif Pro', serif",
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
            <svg
              width="22"
              height="38"
              viewBox="0 0 110 190"
              xmlns="http://www.w3.org/2000/svg"
            >
              <g fill="#00183A">
                <polygon points="55,4 86,28 24,28" />
                <polygon points="24,28 32,28 32,156 24,162" />
                <polygon points="38,32 50,32 50,156 38,156" />
                <polygon points="56,32 60,32 60,156 56,156" />
                <polygon points="66,32 78,32 78,156 66,156" />
                <polygon points="84,28 86,28 86,162 78,156" />
                <polygon points="24,162 86,162 55,186" />
              </g>
            </svg>
            <span
              style={{
                fontFamily: "Georgia, 'Source Serif Pro', serif",
                fontSize: 15,
                color: "#00183A",
                fontWeight: 500,
              }}
            >
              BIG <em style={{ fontStyle: "italic", fontWeight: 400 }}>Capital</em>
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
