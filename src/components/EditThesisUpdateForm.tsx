"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Conviction = "" | "high" | "medium" | "low";
type HoldingPeriod = "" | "short" | "medium" | "long" | "indefinite";

interface Props {
  fundSlug: string;
  thesisId: string;
  updateId: string;
  currencySymbol: string;
  initial: {
    note: string;
    conviction: Conviction;
    holdingPeriod: HoldingPeriod;
    targetWeightPct: string; // as % e.g. "5"
    targetPriceNative: string;
    attachmentFilename: string | null;
  };
}

const PERIOD_LABELS: Record<string, string> = {
  "": "No change",
  short: "Short",
  medium: "Medium",
  long: "Long",
  indefinite: "Indefinite",
};

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#6B6B66",
  fontWeight: 500,
  marginBottom: 10,
};
const LABEL: React.CSSProperties = { fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#0A0A0A", marginBottom: 6, fontWeight: 500, display: "block" };
const INPUT: React.CSSProperties = { width: "100%", border: "1px solid #D9D9D2", borderRadius: 3, padding: "8px 11px", fontSize: 13, outline: "none", fontFamily: "system-ui, sans-serif", color: "#0A0A0A", background: "white", boxSizing: "border-box" };

export default function EditThesisUpdateForm({ fundSlug, thesisId, updateId, currencySymbol, initial }: Props) {
  const router = useRouter();
  const [note, setNote] = useState(initial.note);
  const [conviction, setConviction] = useState<Conviction>(initial.conviction);
  const [holdingPeriod, setHoldingPeriod] = useState<HoldingPeriod>(initial.holdingPeriod);
  const [targetWeightPct, setTargetWeightPct] = useState(initial.targetWeightPct);
  const [targetPriceNative, setTargetPriceNative] = useState(initial.targetPriceNative);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = note.trim().length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const form = new FormData();
    form.append("note", note.trim());
    if (conviction) form.append("conviction", conviction);
    if (holdingPeriod) form.append("holdingPeriod", holdingPeriod);
    if (targetWeightPct) {
      const n = Number(targetWeightPct);
      if (Number.isFinite(n)) form.append("targetWeightPct", String(n));
    }
    if (targetPriceNative) form.append("targetPriceNative", targetPriceNative);
    if (file) form.append("attachment", file);
    try {
      const res = await fetch(`/api/funds/${fundSlug}/theses/${thesisId}/updates/${updateId}`, {
        method: "PATCH",
        body: form,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      router.push(`/dashboard/funds/${fundSlug}/theses/${thesisId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setSubmitting(false);
    }
  }

  const seg = (active: boolean): React.CSSProperties => ({
    flex: 1, textAlign: "center", padding: "8px 6px", fontFamily: "system-ui, sans-serif",
    fontSize: 12, cursor: "pointer", background: active ? "#00183A" : "white",
    color: active ? "white" : "#6B6B66", fontWeight: active ? 600 : 400, border: "none",
  });

  return (
    <div style={{ border: "1px solid #E5E5DE", borderRadius: 10, background: "#FDFDFB", padding: 24, maxWidth: 720 }}>
      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Update note</div>
        <textarea style={{ ...INPUT, minHeight: 96, resize: "vertical", lineHeight: 1.5 }} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Revised conviction <span style={{ color: "#9A9A8E" }}>(optional)</span></div>
        <div style={{ display: "flex", border: "1px solid #D9D9D2", borderRadius: 4, overflow: "hidden" }}>
          {(["", "high", "medium", "low"] as Conviction[]).map((c) => (
            <button key={c || "none"} type="button" style={seg(conviction === c)} onClick={() => setConviction(c)}>
              {c === "" ? "No change" : c.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Revised holding period <span style={{ color: "#9A9A8E" }}>(optional)</span></div>
        <div style={{ display: "flex", border: "1px solid #D9D9D2", borderRadius: 4, overflow: "hidden" }}>
          {(["", "short", "medium", "long", "indefinite"] as HoldingPeriod[]).map((h) => (
            <button key={h || "none"} type="button" style={seg(holdingPeriod === h)} onClick={() => setHoldingPeriod(h)}>
              {PERIOD_LABELS[h]}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Revised targets <span style={{ color: "#9A9A8E" }}>(optional)</span></div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={LABEL}>Target weight (%)</label>
            <input style={INPUT} value={targetWeightPct} onChange={(e) => setTargetWeightPct(e.target.value)} placeholder="leave blank for no change" inputMode="decimal" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LABEL}>Target price ({currencySymbol})</label>
            <input style={INPUT} value={targetPriceNative} onChange={(e) => setTargetPriceNative(e.target.value)} placeholder="leave blank for no change" inputMode="decimal" />
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_HEADER}>Attachment PDF <span style={{ color: "#9A9A8E" }}>(optional)</span></div>
        {initial.attachmentFilename && !file && (
          <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66", marginBottom: 8 }}>
            Current: <span style={{ color: "#00183A" }}>{initial.attachmentFilename}</span>. Uploading a new file replaces it.
          </div>
        )}
        <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66" }} />
        {file && <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#1F5C3A", marginTop: 6 }}>New file: {file.name} ({(file.size / 1024 / 1024).toFixed(1)}MB)</div>}
        <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", marginTop: 6 }}>PDF only · max 10 MB</div>
      </div>

      {error && <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#7A1F1F", marginBottom: 16 }}>{error}</div>}

      <div style={{ display: "flex", gap: 12 }}>
        <button type="button" disabled={!canSubmit} onClick={handleSubmit} style={{ background: canSubmit ? "#00183A" : "#C9C9C0", color: "white", border: "none", borderRadius: 4, padding: "11px 22px", fontSize: 14, fontWeight: 500, fontFamily: "system-ui, sans-serif", cursor: canSubmit ? "pointer" : "default" }}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={() => router.push(`/dashboard/funds/${fundSlug}/theses/${thesisId}`)} style={{ background: "none", color: "#6B6B66", border: "1px solid #D9D9D2", borderRadius: 4, padding: "11px 22px", fontSize: 14, fontFamily: "system-ui, sans-serif", cursor: "pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
