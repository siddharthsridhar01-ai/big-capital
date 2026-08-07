"use client";

import { useState } from "react";
import Link from "next/link";

interface Fund {
  id: string;
  slug: string;
  name: string;
  baseCurrency: string;
}

export default function AdminFundsPanel({ funds }: { funds: Fund[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleReset = async (slug: string, name: string) => {
    const confirmed = window.confirm(
      `Reset ${name}?\n\nThis will permanently delete:\n` +
        `  • All transactions in this fund\n` +
        `  • All positions (open and closed)\n` +
        `  • All trade attachments (PDF memos)\n\n` +
        `The fund returns to its inception state with full starting NAV in cash.\n\n` +
        `This action cannot be undone.`
    );
    if (!confirmed) return;
    setBusy(slug);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/funds/${slug}/reset`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Reset failed");
      } else {
        setResult(
          `Reset ${data.fund}: deleted ${data.deletedTransactions} transaction${data.deletedTransactions === 1 ? "" : "s"}.`
        );
      }
    } catch {
      setError("Network error during reset");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {result && (
        <div
          style={{
            background: "#EDF5EE",
            border: "1px solid #B8D4BB",
            color: "#1F5C3A",
            padding: "10px 14px",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          ✓ {result}
        </div>
      )}
      {error && (
        <div
          style={{
            background: "#FAEAEA",
            border: "1px solid #E0B8B8",
            color: "#7A1F1F",
            padding: "10px 14px",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          background: "white",
          border: "1px solid #D9D9D2",
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
        }}
      >
        {funds.map((f, idx) => (
          <div
            key={f.id}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "14px 18px",
              borderBottom:
                idx < funds.length - 1 ? "1px solid #E5E5DE" : "none",
              gap: 14,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ color: "#00183A", fontWeight: 500 }}>{f.name}</div>
              <div style={{ fontSize: 11, color: "#6B6B66", marginTop: 2 }}>
                {f.baseCurrency} · slug:{" "}
                <span style={{ fontFamily: "ui-monospace, monospace" }}>
                  {f.slug}
                </span>
              </div>
            </div>
            <Link
              href={`/dashboard/funds/${f.slug}`}
              style={{
                fontSize: 12,
                color: "#00183A",
                textDecoration: "none",
                padding: "6px 12px",
                border: "1px solid #C8C8C0",
                borderRadius: 3,
                background: "white",
              }}
            >
              View fund
            </Link>
            <button
              onClick={() => handleReset(f.slug, f.name)}
              disabled={busy === f.slug}
              style={{
                background: "white",
                border: "1px solid #E0B8B8",
                color: "#7A1F1F",
                fontSize: 12,
                padding: "6px 12px",
                borderRadius: 3,
                cursor: busy === f.slug ? "wait" : "pointer",
                fontFamily: "system-ui, sans-serif",
                opacity: busy === f.slug ? 0.6 : 1,
              }}
            >
              {busy === f.slug ? "Resetting…" : "Reset fund"}
            </button>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 12,
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          color: "#9A9A8E",
          lineHeight: 1.55,
        }}
      >
        Reset wipes all transactions, positions, and attachments for the fund
        and returns it to inception state. Use during testing. Once the fund
        is live with real PM trades, this destroys audit history. Be careful.
      </div>
    </div>
  );
}
