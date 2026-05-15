import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#FAFAF7",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <svg
          width="44"
          height="76"
          viewBox="0 0 110 190"
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: "block", margin: "0 auto 12px" }}
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
        <div
          style={{
            fontFamily: "Georgia, 'Source Serif Pro', serif",
            fontSize: 22,
            color: "#00183A",
          }}
        >
          BIG <em style={{ fontStyle: "italic" }}>Capital</em>
        </div>
        <div
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            color: "#6B6B66",
            marginTop: 4,
          }}
        >
          Create your account
        </div>
      </div>

      <SignUp
        appearance={{
          variables: {
            colorPrimary: "#00183A",
            fontFamily: "system-ui, -apple-system, sans-serif",
          },
        }}
      />
    </main>
  );
}
