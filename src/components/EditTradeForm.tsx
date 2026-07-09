"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  fundSlug: string;
  txnId: string;
  tradeLabel: string; // e.g. "BUY 5 SHEL @ £29.62"
  initial: {
    rationale: string;
  };
}

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#6B6B66",
  fontWeight: 500,
  marginBottom: 10,
};
const INPUT: React.CSSProperties = {
  width: "100%",
  border: "1px solid #D9D9D2",
  borderRadius: 3,
  padding: "8px 11px",
  fontSize: 13,
  outline: "none",
  fontFamily: "system-ui, sans-serif",
  color: "#0A0A0A",
  background: "white",
  boxSizing: "border-box",
};

export default function EditTradeForm({ fundSlug, txnId, tradeLabel, initial }: Props) {
  const router = useRouter();
  const [rationale, setRationale] = useState(initial.rationale);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = rationale.trim().length >= 20 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const form = new FormData();
    form.append("rationale", rationale.trim());
    try {
      const res = await fetch(`/api/funds/${fundSlug}/transactions/${txnId}`, {
        method: "PATCH",
        body: form,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      router.back();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div style={{ border: "1px solid #E5E5DE", borderRadius: 10, background: "#FDFDFB", padding: 24, maxWidth: 720 }}>
      <div
        style={{
          marginBottom: 20,
          padding: "10px 12px",
          background: "#F4F3EE",
          border: "1px solid #E5E5DE",
          borderRadius: 4,
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          color: "#00183A",
        }}
      >
        {tradeLabel}
        <span style={{ color: "#9A9A8E", marginLeft: 8 }}>
          — shares, price and date can&rsquo;t be changed (they&rsquo;re the trade record)
        </span>
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_HEADER}>
          Rationale <span style={{ color: rationale.trim().length >= 20 ? "#9A9A8E" : "#7A1F1F" }}>({rationale.trim().length} chars, min 20)</span>
        </div>
        <textarea
          style={{ ...INPUT, minHeight: 140, resize: "vertical", lineHeight: 1.5 }}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </div>

      {error && <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#7A1F1F", marginBottom: 16 }}>{error}</div>}

      <div style={{ display: "flex", gap: 12 }}>
        <button type="button" disabled={!canSubmit} onClick={handleSubmit} style={{ background: canSubmit ? "#00183A" : "#C9C9C0", color: "white", border: "none", borderRadius: 4, padding: "11px 22px", fontSize: 14, fontWeight: 500, fontFamily: "system-ui, sans-serif", cursor: canSubmit ? "pointer" : "default" }}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={() => router.back()} style={{ background: "none", color: "#6B6B66", border: "1px solid #D9D9D2", borderRadius: 4, padding: "11px 22px", fontSize: 14, fontFamily: "system-ui, sans-serif", cursor: "pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
