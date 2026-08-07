"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { numeric } from "@/lib/typography";

type Outcome = "win" | "loss" | "break_even";

const OUTCOME_LABELS: Record<Outcome, string> = {
  win: "Win",
  loss: "Loss",
  break_even: "Break-even",
};

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#6B6B66",
  fontWeight: 500,
  marginBottom: 8,
};

const LABEL: React.CSSProperties = {
  display: "block",
  fontFamily: "system-ui, sans-serif",
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

export default function PostMortemForm({
  fundSlug,
  thesisId,
  defaultOutcome,
  realisedPnlDisplay,
}: {
  fundSlug: string;
  thesisId: string;
  defaultOutcome: Outcome;
  realisedPnlDisplay: string | null;
}) {
  const router = useRouter();

  const [outcome, setOutcome] = useState<Outcome>(defaultOutcome);
  const [realisedReturnPct, setRealisedReturnPct] = useState("");
  const [whatWorked, setWhatWorked] = useState("");
  const [whatDidntWork, setWhatDidntWork] = useState("");
  const [lessons, setLessons] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lessonsLen = lessons.trim().length;
  const lessonsValid = lessonsLen > 0;
  const canSubmit = !!outcome && lessonsValid && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const form = new FormData();
    form.append("outcome", outcome);
    form.append("lessonsLearned", lessons.trim());
    if (whatWorked.trim()) form.append("whatWorked", whatWorked.trim());
    if (whatDidntWork.trim())
      form.append("whatDidntWork", whatDidntWork.trim());
    if (realisedReturnPct.trim())
      form.append("realisedReturnPct", realisedReturnPct.trim());
    if (attachment) form.append("attachment", attachment);

    try {
      const res = await fetch(
        `/api/funds/${fundSlug}/theses/${thesisId}/post-mortem`,
        { method: "POST", body: form }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      router.push(data.redirectTo ?? `/dashboard/funds/${fundSlug}/theses/${thesisId}`);
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
        padding: "20px 24px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {/* OUTCOME */}
      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Outcome</div>
        <div style={{ display: "flex", gap: 0 }}>
          {(["win", "loss", "break_even"] as Outcome[]).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setOutcome(o)}
              style={{
                flex: 1,
                padding: "9px 14px",
                border: "1px solid #D9D9D2",
                marginLeft: "-1px",
                background: outcome === o ? "#00183A" : "white",
                color: outcome === o ? "white" : "#6B6B66",
                fontSize: 12,
                fontWeight: outcome === o ? 600 : 400,
                cursor: "pointer",
                letterSpacing: "0.03em",
              }}
            >
              {OUTCOME_LABELS[o]}
            </button>
          ))}
        </div>
        {realisedPnlDisplay ? (
          <div style={{ fontSize: 11, color: "#6B6B66", marginTop: 6 }}>
            Realised P&amp;L on the most recent close for this holding:{" "}
            <span style={{ ...numeric, color: "#00183A" }}>
              {realisedPnlDisplay}
            </span>{" "}
            (outcome pre-selected from this; adjust if needed).
          </div>
        ) : null}
      </div>

      {/* REALISED RETURN */}
      <div style={{ marginBottom: 22 }}>
        <label style={LABEL}>Realised return (%) (optional)</label>
        <input
          type="number"
          value={realisedReturnPct}
          onChange={(e) => setRealisedReturnPct(e.target.value)}
          step="0.1"
          placeholder="e.g. 12.5 or -8.0"
          style={{ ...INPUT, ...numeric, maxWidth: 220 }}
        />
        <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 4 }}>
          Your estimate of the thesis&rsquo;s realised return. Left blank if
          you&rsquo;d rather not commit to a figure.
        </div>
      </div>

      {/* WHAT WORKED / WHAT DIDN'T */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 22,
        }}
      >
        <div>
          <label style={LABEL}>What worked (optional)</label>
          <textarea
            value={whatWorked}
            onChange={(e) => setWhatWorked(e.target.value)}
            rows={3}
            placeholder="Which parts of the thesis played out?"
            style={{ ...INPUT, resize: "vertical" }}
          />
        </div>
        <div>
          <label style={LABEL}>What didn&rsquo;t (optional)</label>
          <textarea
            value={whatDidntWork}
            onChange={(e) => setWhatDidntWork(e.target.value)}
            rows={3}
            placeholder="What went against you, or surprised you?"
            style={{ ...INPUT, resize: "vertical" }}
          />
        </div>
      </div>

      {/* LESSONS */}
      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Lessons learned</div>
        <textarea
          value={lessons}
          onChange={(e) => setLessons(e.target.value)}
          rows={4}
          placeholder="What would you do differently next time? What's the transferable lesson for the next idea?"
          style={{ ...INPUT, resize: "vertical" }}
        />
      </div>

      {/* ATTACHMENT */}
      <div style={{ marginBottom: 22 }}>
        <div style={SECTION_HEADER}>Attachment PDF (optional)</div>
        <div
          style={{
            border: "1px dashed #D9D9D2",
            padding: "14px",
            background: "#FAFAF7",
            textAlign: "center",
            color: "#6B6B66",
            fontSize: 12,
          }}
        >
          {attachment ? (
            <div>
              <div style={{ fontSize: 13, color: "#00183A", fontWeight: 500 }}>
                {attachment.name}
              </div>
              <div style={{ fontSize: 11, color: "#6B6B66", marginTop: 2 }}>
                {(attachment.size / 1024).toFixed(0)} KB
              </div>
              <button
                type="button"
                onClick={() => setAttachment(null)}
                style={{
                  marginTop: 6,
                  background: "none",
                  border: "none",
                  color: "#7A1F1F",
                  cursor: "pointer",
                  fontSize: 11,
                  textDecoration: "underline",
                }}
              >
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
                Drop a PDF here, or{" "}
                <span style={{ color: "#00183A", textDecoration: "underline" }}>
                  browse
                </span>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  PDF only · max 10 MB
                </div>
              </div>
            </label>
          )}
        </div>
      </div>

      {error ? (
        <div
          style={{
            background: "#F8E8E8",
            border: "1px solid #DBB2B2",
            padding: "12px 14px",
            marginBottom: 16,
            color: "#7A1F1F",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            padding: "10px 22px",
            background: canSubmit ? "#00183A" : "#9A9A8E",
            border: "1px solid",
            borderColor: canSubmit ? "#00183A" : "#9A9A8E",
            color: "white",
            cursor: canSubmit ? "pointer" : "not-allowed",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {submitting ? "Saving…" : "Record post-mortem"}
        </button>
      </div>
    </div>
  );
}
