"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Clear pre-launch theses and letters, without touching trading.
 *
 * Preview first: it lists exactly what would go, so nothing is deleted on trust.
 * Anything created on or after the cutoff is kept, which protects research a PM
 * has already written for the launch.
 */
type Preview = {
  theses: Array<{ fund: string; title: string; created: string | null }>;
  letters: Array<{ fund: string; period: string }>;
};

export default function ClearResearchPanel() {
  const router = useRouter();
  const [before, setBefore] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function call(apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ before });
      if (apply) {
        qs.set("apply", "1");
        qs.set("confirm", "CLEAR");
      }
      const res = await fetch(`/api/admin/clear-research?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Failed (${res.status})`);
        return;
      }
      if (apply) {
        setDone(`Removed ${data.theses.length} theses and ${data.letters.length} letters created before ${before}.`);
        setPreview(null);
        setConfirmText("");
        router.refresh();
      } else {
        setPreview({ theses: data.theses, letters: data.letters });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const ready = confirmText.trim() === "CLEAR";
  const MUTED: React.CSSProperties = { fontSize: 12, color: "#6B6B66" };

  if (done) {
    return (
      <div style={{ border: "1px solid #E5E5DE", borderLeft: "3px solid #2F5D45", background: "#F7FAF8", padding: "14px 18px", fontSize: 13 }}>
        <strong style={{ color: "#2F5D45" }}>Done. </strong>{done}
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid #E5E5DE", background: "white", padding: "16px 20px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 13, color: "#444", lineHeight: 1.6, marginBottom: 12 }}>
        Deletes theses and monthly letters created <strong>before</strong> the date below, across all
        funds. Trades, queued orders, positions and NAV are not touched, and anything written on or
        after the date is kept.
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <label style={MUTED}>Created before</label>
        <input
          type="date"
          value={before}
          onChange={(e) => { setBefore(e.target.value); setPreview(null); setConfirmText(""); }}
          style={{ padding: "5px 8px", border: "1px solid #D9D9D2", fontSize: 13 }}
        />
        <button
          onClick={() => call(false)}
          disabled={busy}
          style={{ padding: "6px 12px", border: "1px solid #D9D9D2", background: "white", fontSize: 12, cursor: busy ? "default" : "pointer", color: "#00183A" }}
        >
          {busy && !preview ? "Checking…" : "Preview"}
        </button>
      </div>

      {preview ? (
        <>
          <div style={{ fontSize: 12, color: "#444", marginBottom: 8 }}>
            <strong>{preview.theses.length}</strong> theses and <strong>{preview.letters.length}</strong> letters would be removed.
          </div>
          {preview.theses.length + preview.letters.length > 0 ? (
            <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid #F0EFEA", padding: "6px 10px", marginBottom: 12, fontSize: 11.5 }}>
              {preview.theses.map((t, i) => (
                <div key={`t${i}`} style={{ padding: "3px 0", color: "#444" }}>
                  <span style={{ color: "#9A9A8E" }}>thesis · {t.fund} · {t.created}</span> &nbsp;{t.title}
                </div>
              ))}
              {preview.letters.map((l, i) => (
                <div key={`l${i}`} style={{ padding: "3px 0", color: "#444" }}>
                  <span style={{ color: "#9A9A8E" }}>letter · {l.fund}</span> &nbsp;{l.period}
                </div>
              ))}
            </div>
          ) : null}

          {preview.theses.length + preview.letters.length > 0 ? (
            <>
              <div style={{ ...MUTED, marginBottom: 6 }}>
                Type <strong style={{ color: "#7A1F1F" }}>CLEAR</strong> to confirm.
              </div>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="CLEAR"
                style={{ padding: "6px 10px", border: "1px solid #D9D9D2", fontSize: 13, width: 140, marginRight: 10 }}
              />
              <button
                onClick={() => call(true)}
                disabled={busy || !ready}
                style={{ padding: "7px 14px", border: "none", fontSize: 12, color: "white", background: ready ? "#7A1F1F" : "#D9D9D2", cursor: busy || !ready ? "default" : "pointer" }}
              >
                {busy ? "Clearing…" : "Clear research and letters"}
              </button>
            </>
          ) : null}
        </>
      ) : null}

      {error ? <div style={{ color: "#7A1F1F", marginTop: 10, fontSize: 12 }}>{error}</div> : null}
    </div>
  );
}
