"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Approve or reject an analyst's thesis update. Shown only to the fund's PM.
 *
 * Until approved, the update is visible but does not move the thesis's current
 * conviction or targets — so approving it is a real decision, not a formality.
 */
export default function UpdateApprovalActions({
  fundSlug,
  thesisId,
  updateId,
}: {
  fundSlug: string;
  thesisId: string;
  updateId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/funds/${fundSlug}/theses/${thesisId}/updates/${updateId}/approval`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) setError(data.error ?? "Failed");
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const BTN: React.CSSProperties = {
    padding: "5px 12px", fontSize: 11, cursor: busy ? "default" : "pointer",
    fontFamily: "system-ui, sans-serif",
  };

  return (
    <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
      <button
        onClick={() => decide("approve")}
        disabled={busy}
        style={{ ...BTN, background: "#2F5D45", color: "white", border: "none" }}
      >
        Approve
      </button>
      <button
        onClick={() => decide("reject")}
        disabled={busy}
        style={{ ...BTN, background: "white", color: "#7A1F1F", border: "1px solid #7A1F1F" }}
      >
        Reject
      </button>
      {error ? <span style={{ fontSize: 11, color: "#7A1F1F" }}>{error}</span> : null}
    </div>
  );
}
