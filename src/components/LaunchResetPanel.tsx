"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Launch reset control.
 *
 * The most destructive action in the system: it deletes every trade and NAV
 * snapshot across all funds, and cannot be undone. So it is deliberately
 * three steps — preview, type the word, confirm — rather than a button that
 * does it on one click.
 *
 * The preview is a real dry run against the database, not a guess, so what is
 * shown is what will actually be deleted.
 */
type Row = {
  fund: string;
  name: string;
  transactions: number;
  navSnapshots: number;
  theses: string | number;
  startingCapital: string;
};

export default function LaunchResetPanel({ defaultDate }: { defaultDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(defaultDate);
  const [preview, setPreview] = useState<Row[] | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function call(apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ date });
      if (apply) {
        qs.set("apply", "1");
        qs.set("confirm", "RESET");
      }
      const res = await fetch(`/api/admin/reset-for-launch?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Failed (${res.status})`);
        return;
      }
      if (apply) {
        setDone(`All funds reset to ${date}. ${data.report?.length ?? 0} funds are flat at starting capital.`);
        setPreview(null);
        setConfirmText("");
        router.refresh();
      } else {
        setPreview(data.report ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const L: React.CSSProperties = { fontSize: 12, color: "#6B6B66" };
  const ready = confirmText.trim() === "RESET";

  if (done) {
    return (
      <div style={{ border: "1px solid #E5E5DE", borderLeft: "3px solid #2F5D45", background: "#F7FAF8", padding: "14px 18px", fontSize: 13 }}>
        <strong style={{ color: "#2F5D45" }}>Done. </strong>
        {done}
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid #E5E5DE", background: "white", padding: "16px 20px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ fontSize: 13, color: "#444", lineHeight: 1.6, marginBottom: 12 }}>
        Deletes every trade, position and NAV snapshot across all funds, and sets
        inception to the date below. Securities, prices, FX, universes, constraints,
        team and research are kept. <strong>This cannot be undone.</strong>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <label style={L}>Inception date</label>
        <input
          type="date"
          value={date}
          onChange={(e) => { setDate(e.target.value); setPreview(null); setConfirmText(""); }}
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
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #00183A" }}>
                {["Fund", "Trades", "NAV snapshots", "Restarts at"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "0 10px 6px 0", color: "#9A9A8E", fontWeight: 500, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={r.fund} style={{ borderBottom: "1px solid #E5E5DE" }}>
                  <td style={{ padding: "7px 10px 7px 0" }}>{r.name}</td>
                  <td style={{ padding: "7px 10px 7px 0", fontVariantNumeric: "tabular-nums" }}>{r.transactions}</td>
                  <td style={{ padding: "7px 10px 7px 0", fontVariantNumeric: "tabular-nums" }}>{r.navSnapshots}</td>
                  <td style={{ padding: "7px 10px 7px 0", fontVariantNumeric: "tabular-nums" }}>{Number(r.startingCapital).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ ...L, marginBottom: 6 }}>
            Type <strong style={{ color: "#7A1F1F" }}>RESET</strong> to confirm.
          </div>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESET"
            style={{ padding: "6px 10px", border: "1px solid #D9D9D2", fontSize: 13, width: 140, marginRight: 10 }}
          />
          <button
            onClick={() => call(true)}
            disabled={busy || !ready}
            style={{
              padding: "7px 14px", border: "none", fontSize: 12, color: "white",
              background: ready ? "#7A1F1F" : "#D9D9D2",
              cursor: busy || !ready ? "default" : "pointer",
            }}
          >
            {busy ? "Resetting…" : `Reset all funds to ${date}`}
          </button>
        </>
      ) : null}

      {error ? <div style={{ color: "#7A1F1F", marginTop: 10, fontSize: 12 }}>{error}</div> : null}
    </div>
  );
}
