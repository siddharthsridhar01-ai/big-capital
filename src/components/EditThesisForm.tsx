"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Conviction = "high" | "medium" | "low";
type HoldingPeriod = "short" | "medium" | "long" | "indefinite";

interface Props {
  fundSlug: string;
  thesisId: string;
  ticker: string;
  securityName: string;
  currencySymbol: string;
  initial: {
    conviction: Conviction;
    holdingPeriod: HoldingPeriod;
    summary: string;
    targetWeightPct: string; // as % e.g. "5" (already converted from stored 0.05)
    targetPriceNative: string;
    memoFilename: string | null;
  };
}

const PERIOD_LABELS: Record<HoldingPeriod, string> = {
  short: "Short (< 3 months)",
  medium: "Medium (3-12 months)",
  long: "Long (1-3 years)",
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

const LABEL: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  fontSize: 12,
  color: "#0A0A0A",
  marginBottom: 6,
  fontWeight: 500,
  display: "block",
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

export default function EditThesisForm({
  fundSlug,
  thesisId,
  ticker,
  securityName,
  currencySymbol,
  initial,
}: Props) {
  const router = useRouter();

  const [conviction, setConviction] = useState<Conviction>(initial.conviction);
  const [holdingPeriod, setHoldingPeriod] = useState<HoldingPeriod>(initial.holdingPeriod);
  const [summary, setSummary] = useState(initial.summary);
  const [targetWeightPct, setTargetWeightPct] = useState(initial.targetWeightPct);
  const [targetPriceNative, setTargetPriceNative] = useState(initial.targetPriceNative);
  const [memoFile, setMemoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summaryTrimmed = summary.trim();
  const canSubmit = summaryTrimmed.length > 0 && summaryTrimmed.length <= 500 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const form = new FormData();
    form.append("conviction", conviction);
    form.append("holdingPeriod", holdingPeriod);
    form.append("summary", summaryTrimmed);
    if (targetWeightPct) {
      const n = Number(targetWeightPct);
      if (Number.isFinite(n)) form.append("targetWeightPct", String(n / 100));
    }
    if (targetPriceNative) form.append("targetPriceNative", targetPriceNative);
    if (memoFile) form.append("memo", memoFile);

    try {
      const res = await fetch(`/api/funds/${fundSlug}/theses/${thesisId}`, {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  const seg = (active: boolean): React.CSSProperties => ({
    flex: 1,
    textAlign: "center",
    padding: "9px 8px",
    fontFamily: "system-ui, sans-serif",
    fontSize: 13,
    cursor: "pointer",
    background: active ? "#00183A" : "white",
    color: active ? "white" : "#6B6B66",
    fontWeight: active ? 600 : 400,
    border: "none",
  });

  return (
    <div style={{ border: "1px solid #E5E5DE", borderRadius: 10, background: "#FDFDFB", padding: 24, maxWidth: 720 }}>
      {/* Security (locked) */}
      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Security</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "10px 12px", background: "#F4F3EE", border: "1px solid #E5E5DE", borderRadius: 4 }}>
          <span style={{ fontFamily: "system-ui, sans-serif", fontWeight: 700, fontSize: 13, color: "#00183A" }}>{ticker}</span>
          <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#6B6B66" }}>{securityName}</span>
          <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", marginLeft: "auto" }}>
            Security can&rsquo;t be changed
          </span>
        </div>
      </div>

      {/* Conviction */}
      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Conviction</div>
        <div style={{ display: "flex", border: "1px solid #D9D9D2", borderRadius: 4, overflow: "hidden" }}>
          {(["high", "medium", "low"] as const).map((c) => (
            <button key={c} type="button" style={seg(conviction === c)} onClick={() => setConviction(c)}>
              {c.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Holding period */}
      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Holding period</div>
        <div style={{ display: "flex", border: "1px solid #D9D9D2", borderRadius: 4, overflow: "hidden" }}>
          {(["short", "medium", "long", "indefinite"] as HoldingPeriod[]).map((h) => (
            <button key={h} type="button" style={seg(holdingPeriod === h)} onClick={() => setHoldingPeriod(h)}>
              {PERIOD_LABELS[h]}
            </button>
          ))}
        </div>
      </div>

      {/* Targets */}
      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Targets (optional)</div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={LABEL}>Target weight (%)</label>
            <input style={INPUT} value={targetWeightPct} onChange={(e) => setTargetWeightPct(e.target.value)} placeholder="e.g. 5" inputMode="decimal" />
            <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", marginTop: 4 }}>Intended position size as % of NAV</div>
          </div>
          <div style={{ flex: 1 }}>
            <label style={LABEL}>Target price ({currencySymbol})</label>
            <input style={INPUT} value={targetPriceNative} onChange={(e) => setTargetPriceNative(e.target.value)} placeholder="e.g. 150.00" inputMode="decimal" />
            <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", marginTop: 4 }}>Where you expect the stock to trade</div>
          </div>
        </div>
      </div>

      {/* Summary */}
      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>
          Summary <span style={{ color: "#9A9A8E" }}>({summaryTrimmed.length}/500)</span>
        </div>
        <textarea
          style={{ ...INPUT, minHeight: 120, resize: "vertical", lineHeight: 1.5 }}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={500}
        />
      </div>

      {/* Memo */}
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_HEADER}>Memo PDF (optional)</div>
        {initial.memoFilename && !memoFile && (
          <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66", marginBottom: 8 }}>
            Current: <span style={{ color: "#00183A" }}>{initial.memoFilename}</span> — uploading a new file replaces it.
          </div>
        )}
        <input
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => setMemoFile(e.target.files?.[0] ?? null)}
          style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66" }}
        />
        {memoFile && (
          <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#1F5C3A", marginTop: 6 }}>
            New file: {memoFile.name} ({(memoFile.size / 1024 / 1024).toFixed(1)}MB)
          </div>
        )}
        <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", marginTop: 6 }}>PDF only · max 10 MB</div>
      </div>

      {error && (
        <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#7A1F1F", marginBottom: 16 }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          style={{
            background: canSubmit ? "#00183A" : "#C9C9C0",
            color: "white",
            border: "none",
            borderRadius: 4,
            padding: "11px 22px",
            fontSize: 14,
            fontWeight: 500,
            fontFamily: "system-ui, sans-serif",
            cursor: canSubmit ? "pointer" : "default",
          }}
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/dashboard/funds/${fundSlug}/theses/${thesisId}`)}
          style={{
            background: "none",
            color: "#6B6B66",
            border: "1px solid #D9D9D2",
            borderRadius: 4,
            padding: "11px 22px",
            fontSize: 14,
            fontFamily: "system-ui, sans-serif",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
