import Link from "next/link";
import { serif as serif_, numeric } from "@/lib/typography";

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#FAFAF7",
        color: "#0A0A0A",
        ...serif_,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/big-capital-logo.png"
        alt="BIG Capital"
        style={{ height: 130, width: "auto", marginBottom: 12 }}
      />
      <h1
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        BIG Capital
      </h1>
      <p
        style={{
          fontSize: "1.1rem",
          color: "#6B6B66",
          maxWidth: 520,
          marginTop: 16,
          lineHeight: 1.55,
        }}
      >
        A student-run investment fund running paper-traded portfolios across six
        equity strategies.
      </p>
      <p
        style={{
          fontSize: "0.85rem",
          color: "#6B6B66",
          marginTop: 32,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Site under construction.
      </p>
    </main>
  );
}
