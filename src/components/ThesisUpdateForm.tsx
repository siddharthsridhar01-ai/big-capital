"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ThesisUpdateForm({
  fundSlug,
  thesisId,
}: {
  fundSlug: string;
  thesisId: string;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = note.trim().length >= 5 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/funds/${fundSlug}/theses/${thesisId}/updates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: note.trim() }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      setNote("");
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Add an update to this thesis — what's changed, a new data point, a revised view…"
        style={{
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
          resize: "vertical",
          lineHeight: 1.5,
        }}
      />
      {error ? (
        <div style={{ fontSize: 11, color: "#7A1F1F", marginTop: 6 }}>
          {error}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: 8,
        }}
      >
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            padding: "8px 16px",
            background: canSubmit ? "#00183A" : "#9A9A8E",
            border: "1px solid",
            borderColor: canSubmit ? "#00183A" : "#9A9A8E",
            color: "white",
            cursor: canSubmit ? "pointer" : "not-allowed",
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {submitting ? "Adding…" : "Add update"}
        </button>
      </div>
    </div>
  );
}
