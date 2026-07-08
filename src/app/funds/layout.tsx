import Link from "next/link";
import { serif } from "@/lib/typography";

export const metadata = {
  title: "Funds — BIG Capital",
  description:
    "Paper-traded equity strategies run by the BIG Capital student investment society.",
};

export default function PublicFundsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div style={{ minHeight: "100vh", background: "#FAFAF7", color: "#0A0A0A" }}>
      {/* Public header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 22,
          padding: "16px 32px",
          borderBottom: "1px solid #E5E5DE",
          background: "white",
        }}
      >
        <Link
          href="/funds"
          style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 10 }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/big-capital-logo.png"
            alt="BIG Capital"
            style={{ height: 42, width: "auto", display: "block" }}
          />
          <span style={{ ...serif, fontSize: 18, color: "#00183A", display: "none" }}>
            BIG <span style={{ fontStyle: "italic" }}>Capital</span>
          </span>
        </Link>

        <nav style={{ display: "flex", gap: 18, marginLeft: 8 }}>
          <Link href="/funds" style={navLink}>
            Funds
          </Link>
          <span style={{ ...navLink, color: "#C8C8C0", cursor: "default" }}>Insights</span>
          <span style={{ ...navLink, color: "#C8C8C0", cursor: "default" }}>About</span>
        </nav>

        <Link
          href="/sign-in"
          style={{
            marginLeft: "auto",
            fontSize: 12,
            color: "#00183A",
            textDecoration: "none",
            border: "1px solid #D9D9D2",
            borderRadius: 4,
            padding: "6px 14px",
          }}
        >
          Member login
        </Link>
      </header>

      {children}

      {/* Disclosure footer */}
      <footer
        style={{
          borderTop: "1px solid #E5E5DE",
          background: "white",
          padding: "18px 32px",
          marginTop: 40,
        }}
      >
        <div
          style={{
            maxWidth: 920,
            margin: "0 auto",
            fontSize: 11,
            color: "#9A9A8E",
            lineHeight: 1.7,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          BIG Capital is a student-run investment society. All portfolios are
          paper-traded for educational purposes — no client capital is managed
          and no figures represent real money. Holdings are disclosed on a lag
          and all performance is simulated. Nothing on this site is investment
          advice or an offer of any kind.
        </div>
      </footer>
    </div>
  );
}

const navLink: React.CSSProperties = {
  fontSize: 13,
  color: "#6B6B66",
  textDecoration: "none",
  fontFamily: "system-ui, sans-serif",
};
