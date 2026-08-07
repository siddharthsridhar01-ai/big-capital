"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Conviction = "high" | "medium" | "low";
type HoldingPeriod = "short" | "medium" | "long" | "indefinite";

const PERIOD_LABELS: Record<HoldingPeriod, string> = {
  short: "Short (< 3 months)",
  medium: "Medium (3-12 months)",
  long: "Long (1-3 years)",
  indefinite: "Indefinite",
};

const LABEL: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "#6B6B66",
  marginBottom: 6,
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
  lineHeight: 1.5,
};

function pill(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 80,
    padding: "7px 10px",
    border: "1px solid #D9D9D2",
    marginLeft: "-1px",
    background: active ? "#00183A" : "white",
    color: active ? "white" : "#6B6B66",
    fontFamily: "system-ui, sans-serif",
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
  };
}

export default function ThesisUpdateForm({
  fundSlug,
  thesisId,
  currency = "USD",
}: {
  fundSlug: string;
  thesisId: string;
  currency?: string;
}) {
  const router = useRouter();
  const sym = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";

  const [note, setNote] = useState("");
  const [conviction, setConviction] = useState<Conviction | "">("");
  const [holdingPeriod, setHoldingPeriod] = useState<HoldingPeriod | "">("");
  const [targetWeightPct, setTargetWeightPct] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
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
    if (targetWeightPct.trim()) form.append("targetWeightPct", targetWeightPct.trim());
    if (targetPrice.trim()) form.append("targetPriceNative", targetPrice.trim());
    if (attachment) form.append("attachment", attachment);

    try {
      const res = await fetch(
        `/api/funds/${fundSlug}/theses/${thesisId}/updates`,
        { method: "POST", body: form }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      setNote("");
      setConviction("");
      setHoldingPeriod("");
      setTargetWeightPct("");
      setTargetPrice("");
      setAttachment(null);
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        background: "white",
        border: "1px solid #D9D9D2",
        padding: "18px 20px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ marginBottom: 18 }}>
        <label style={LABEL}>Update note (required)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="What's changed, a new data point, a revised view…"
          style={{ ...INPUT, resize: "vertical" }}
        />
      </div>

      <div style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "#9A9A8E", marginBottom: 10 }}>
        Revisions (optional)
      </div>

      {/* CONVICTION */}
      <div style={{ marginBottom: 14 }}>
        <label style={LABEL}>Conviction</label>
        <div style={{ display: "flex" }}>
          <button type="button" onClick={() => setConviction("")} style={pill(conviction === "")}>
            No change
          </button>
          {(["high", "medium", "low"] as Conviction[]).map((c) => (
            <button key={c} type="button" onClick={() => setConviction(c)} style={{ ...pill(conviction === c), textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* HOLDING PERIOD */}
      <div style={{ marginBottom: 14 }}>
        <label style={LABEL}>Holding period</label>
        <div style={{ display: "flex", flexWrap: "wrap" }}>
          <button type="button" onClick={() => setHoldingPeriod("")} style={pill(holdingPeriod === "")}>
            No change
          </button>
          {(["short", "medium", "long", "indefinite"] as HoldingPeriod[]).map((p) => (
            <button key={p} type="button" onClick={() => setHoldingPeriod(p)} style={{ ...pill(holdingPeriod === p), minWidth: 110 }}>
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* TARGETS */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        <div>
          <label style={LABEL}>Target weight (%), optimal size</label>
          <input
            type="number"
            value={targetWeightPct}
            onChange={(e) => setTargetWeightPct(e.target.value)}
            step="0.1"
            min="0"
            max="50"
            placeholder="leave blank for no change"
            style={INPUT}
          />
        </div>
        <div>
          <label style={LABEL}>Target price ({sym})</label>
          <input
            type="number"
            value={targetPrice}
            onChange={(e) => setTargetPrice(e.target.value)}
            step="0.01"
            min="0"
            placeholder="leave blank for no change"
            style={INPUT}
          />
        </div>
      </div>

      {/* PDF */}
      <div style={{ marginBottom: 16 }}>
        <label style={LABEL}>Attach PDF (optional)</label>
        <div style={{ border: "1px dashed #D9D9D2", padding: "12px", background: "#FAFAF7", textAlign: "center", color: "#6B6B66", fontSize: 12 }}>
          {attachment ? (
            <div>
              <div style={{ fontSize: 13, color: "#00183A", fontWeight: 500 }}>{attachment.name}</div>
              <div style={{ fontSize: 11, color: "#6B6B66", marginTop: 2 }}>{(attachment.size / 1024).toFixed(0)} KB</div>
              <button type="button" onClick={() => setAttachment(null)} style={{ marginTop: 6, background: "none", border: "none", color: "#7A1F1F", cursor: "pointer", fontSize: 11, textDecoration: "underline" }}>
                Remove
              </button>
            </div>
          ) : (
            <label style={{ cursor: "pointer" }}>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setAttachment(f);
                }}
                style={{ display: "none" }}
              />
              <div>
                Drop a PDF here, or <span style={{ color: "#00183A", textDecoration: "underline" }}>browse</span>
                <div style={{ fontSize: 11, marginTop: 2 }}>PDF only · max 10 MB</div>
              </div>
            </label>
          )}
        </div>
      </div>

      {error ? (
        <div style={{ background: "#F8E8E8", border: "1px solid #DBB2B2", padding: "10px 12px", marginBottom: 14, color: "#7A1F1F", fontSize: 12, lineHeight: 1.5 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            padding: "9px 18px",
            background: canSubmit ? "#00183A" : "#9A9A8E",
            border: "1px solid",
            borderColor: canSubmit ? "#00183A" : "#9A9A8E",
            color: "white",
            cursor: canSubmit ? "pointer" : "not-allowed",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {submitting ? "Adding…" : "Add update"}
        </button>
      </div>
    </div>
  );
}
