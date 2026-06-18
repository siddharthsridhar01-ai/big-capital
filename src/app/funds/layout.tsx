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
          <svg width="20" height="34" viewBox="0 0 110 190" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
          <span style={{ ...serif, fontSize: 18, color: "#00183A" }}>
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
