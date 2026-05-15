import Link from "next/link";

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#FAFAF7",
        color: "#0A0A0A",
        fontFamily: "Georgia, 'Source Serif Pro', serif",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <svg
        width="60"
        height="100"
        viewBox="0 0 110 190"
        xmlns="http://www.w3.org/2000/svg"
        style={{ marginBottom: 24 }}
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
      <h1
        style={{
          fontSize: "2.5rem",
          fontWeight: 400,
          color: "#00183A",
          margin: 0,
          letterSpacing: "-0.01em",
        }}
      >
        BIG <em style={{ fontStyle: "italic" }}>Capital</em>
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
