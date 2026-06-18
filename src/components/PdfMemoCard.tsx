import React from "react";

/**
 * Compact PDF memo chip — a clickable card with a stylised first-page
 * placeholder thumbnail and the filename. Opens the (private, streamed) memo
 * in a new tab. Presentational only; safe to use in server components.
 *
 * The thumbnail is a deliberate stylisation (faint placeholder lines), not a
 * real page render — zero extra cost, no thumbnail generation/storage.
 */
export default function PdfMemoCard({
  href,
  filename,
  subtitle = "Investment memo",
}: {
  href: string;
  filename: string;
  subtitle?: string;
}) {
  // Faint placeholder "text" lines for the mini page.
  const line = (top: number, left: number, right: number, color = "#CBCBC3") => (
    <span
      style={{
        position: "absolute",
        top,
        left,
        right,
        height: 3,
        background: color,
        borderRadius: 1,
      }}
    />
  );

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        textDecoration: "none",
        display: "inline-flex",
        gap: 10,
        alignItems: "center",
        background: "#FAFAF7",
        border: "1px solid #E5E5DE",
        borderRadius: 8,
        padding: "8px 12px",
        maxWidth: "100%",
      }}
    >
      {/* Mini page thumbnail */}
      <span
        style={{
          position: "relative",
          width: 46,
          height: 60,
          flex: "0 0 auto",
          display: "block",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            background: "#fff",
            border: "0.5px solid #D9D9D2",
            borderRadius: 4,
            overflow: "hidden",
            display: "block",
          }}
        >
          {line(8, 6, 22, "#9A9A8E")}
          {line(17, 6, 7)}
          {line(24, 6, 7)}
          {line(31, 6, 14)}
          {line(38, 6, 7)}
          {line(45, 6, 18)}
        </span>
        <span
          style={{
            position: "absolute",
            bottom: 4,
            left: 4,
            background: "#FBE9E9",
            color: "#8A2020",
            fontSize: 11,
            fontWeight: 500,
            padding: "0px 5px",
            borderRadius: 3,
            letterSpacing: "0.04em",
            lineHeight: 1.4,
          }}
        >
          PDF
        </span>
      </span>

      {/* Filename + subtitle */}
      <span style={{ minWidth: 0, display: "block" }}>
        <span
          style={{
            display: "block",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            fontWeight: 600,
            color: "#00183A",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {filename}
        </span>
        <span
          style={{
            display: "block",
            fontFamily: "system-ui, sans-serif",
            fontSize: 11,
            color: "#6B6B66",
            marginTop: 2,
          }}
        >
          {subtitle}
        </span>
      </span>
    </a>
  );
}
