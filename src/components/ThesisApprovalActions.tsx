"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ThesisApprovalActions({
  fundSlug,
  thesisId,
}: {
  fundSlug: string;
  thesisId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "reject") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/funds/${fundSlug}/theses/${thesisId}/approval`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Failed (${res.status})`);
        setBusy(null);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {error && <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#7A1F1F" }}>{error}</span>}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => act("approve")}
        style={{
          background: "#1F5C3A",
          color: "white",
          border: "none",
          borderRadius: 4,
          padding: "6px 14px",
          fontSize: 12,
          fontWeight: 600,
          fontFamily: "system-ui, sans-serif",
          cursor: busy ? "default" : "pointer",
          opacity: busy === "approve" ? 0.7 : 1,
        }}
      >
        {busy === "approve" ? "Approving…" : "Approve"}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => act("reject")}
        style={{
          background: "white",
          color: "#7A1F1F",
          border: "1px solid #D9B3B3",
          borderRadius: 4,
          padding: "6px 14px",
          fontSize: 12,
          fontWeight: 500,
          fontFamily: "system-ui, sans-serif",
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy === "reject" ? "Rejecting…" : "Reject"}
      </button>
    </div>
  );
}
