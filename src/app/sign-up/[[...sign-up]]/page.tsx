import { SignUp } from "@clerk/nextjs";
import { serif as serif_, numeric } from "@/lib/typography";

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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/big-capital-logo.png"
          alt="BIG Capital"
          style={{ height: 76, width: "auto", display: "block", margin: "0 auto 8px" }}
        />
        <div
          style={{
            ...serif_,
            fontSize: 22,
            color: "#00183A",
            display: "none",
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
