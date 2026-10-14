"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Admin control for voiding a transaction.
 *
 * Voiding, not deletion: the row stays in the ledger and on the activity feed,
 * struck through, with who voided it and why. Deleting would remove the evidence
 * that the error happened, which contradicts what PMs are told about the ledger
 * being append-only.
 *
 * Deliberately a two-step action with a typed reason. This changes historic NAV,
 * so it should feel heavier than clicking a button.
 */
export default function VoidTradePanel({
  txnId,
  voided,
  voidReason,
  voidedBy,
  fundSlug,
}: {
  txnId: string;
  voided: boolean;
  voidReason: string | null;
  voidedBy: string | null;
  fundSlug: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(unvoid: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/transactions/${txnId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, unvoid }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Failed (${res.status})`);
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const BOX: React.CSSProperties = {
    background: "white",
    border: "1px solid #D9D9D2",
    padding: "16px 20px",
    fontFamily: "system-ui, sans-serif",
    fontSize: 13,
    color: "#444",
    lineHeight: 1.6,
  };

  if (voided) {
    return (
      <div style={{ ...BOX, borderLeft: "3px solid #7A1F1F", background: "#FCF7F7" }}>
        <div style={{ fontWeight: 600, color: "#7A1F1F", marginBottom: 6 }}>
          This trade is voided
        </div>
        <div style={{ marginBottom: 4 }}>{voidReason}</div>
        {voidedBy ? (
          <div style={{ fontSize: 12, color: "#9A9A8E" }}>Voided by {voidedBy}</div>
        ) : null}
        <div style={{ fontSize: 12, color: "#9A9A8E", marginTop: 10 }}>
          It is excluded from positions, NAV and cash, and remains in the ledger for audit.
        </div>
        <button
          onClick={() => send(true)}
          disabled={busy}
          style={{
            marginTop: 12, background: "white", border: "1px solid #D9D9D2",
            padding: "6px 12px", fontSize: 12, color: "#00183A", cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "Working…" : "Reinstate this trade"}
        </button>
        {error ? <div style={{ color: "#7A1F1F", marginTop: 8, fontSize: 12 }}>{error}</div> : null}
      </div>
    );
  }

  return (
    <div style={BOX}>
      {!open ? (
        <>
          <div style={{ marginBottom: 10 }}>
            A trade that should never have reached the ledger can be <strong>voided</strong>: it
            stays on the record, struck through, but stops affecting positions, NAV and cash.
            To correct a genuine decision you later regret, enter a counter-trade through the
            normal ticket instead &mdash; that is the honest record of what happened.
          </div>
          <button
            onClick={() => setOpen(true)}
            style={{
              background: "white", border: "1px solid #7A1F1F", padding: "6px 12px",
              fontSize: 12, color: "#7A1F1F", cursor: "pointer",
            }}
          >
            Void this trade
          </button>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 8, fontWeight: 600, color: "#00183A" }}>
            Why is this trade being voided?
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. size entered as 20,000 instead of 200; fund could not fund it"
            style={{
              width: "100%", padding: 8, border: "1px solid #D9D9D2",
              fontFamily: "system-ui, sans-serif", fontSize: 13, resize: "vertical",
            }}
          />
          <div style={{ fontSize: 12, color: "#9A9A8E", margin: "6px 0 12px" }}>
            Recorded permanently against the trade and visible to everyone. NAV should be
            recomputed over the affected dates afterwards.
          </div>
          <button
            onClick={() => send(false)}
            disabled={busy || reason.trim().length < 10}
            style={{
              background: reason.trim().length < 10 ? "#D9D9D2" : "#7A1F1F",
              border: "none", padding: "7px 14px", fontSize: 12, color: "white",
              cursor: busy || reason.trim().length < 10 ? "default" : "pointer",
            }}
          >
            {busy ? "Voiding…" : "Confirm void"}
          </button>
          <button
            onClick={() => { setOpen(false); setError(null); }}
            style={{
              marginLeft: 10, background: "none", border: "none",
              fontSize: 12, color: "#6B6B66", cursor: "pointer",
            }}
          >
            Cancel
          </button>
          {error ? <div style={{ color: "#7A1F1F", marginTop: 8, fontSize: 12 }}>{error}</div> : null}
          <div style={{ fontSize: 11, color: "#9A9A8E", marginTop: 10 }}>
            Fund: {fundSlug}
          </div>
        </>
      )}
    </div>
  );
}
