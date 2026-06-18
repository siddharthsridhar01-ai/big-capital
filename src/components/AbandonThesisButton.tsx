"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AbandonThesisButton({
  fundSlug,
  thesisId,
}: {
  fundSlug: string;
  thesisId: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function abandon() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/funds/${fundSlug}/theses/${thesisId}/abandon`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  if (!confirming) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif" }}>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          style={{
            background: "none",
            border: "none",
            color: "#7A1F1F",
            cursor: "pointer",
            fontSize: 12,
            textDecoration: "underline",
            padding: 0,
          }}
        >
          Abandon this thesis
        </button>
        <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 4 }}>
          For an idea you&rsquo;re no longer pursuing. Only available before any
          trade is placed.
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 12, color: "#0A0A0A", marginBottom: 10, lineHeight: 1.5 }}>
        Abandon this thesis? It will be marked <strong>Abandoned</strong> and can
        no longer be traded against or updated. This can&rsquo;t be undone.
      </div>
      {error ? (
        <div style={{ fontSize: 11, color: "#7A1F1F", marginBottom: 8 }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={abandon}
          disabled={submitting}
          style={{
            padding: "8px 16px",
            background: "#7A1F1F",
            border: "1px solid #7A1F1F",
            color: "white",
            cursor: submitting ? "wait" : "pointer",
            fontSize: 12,
            fontWeight: 500,
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? "Abandoning…" : "Yes, abandon"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={submitting}
          style={{
            padding: "8px 16px",
            background: "white",
            border: "1px solid #D9D9D2",
            color: "#6B6B66",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
