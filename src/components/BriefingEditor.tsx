"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface BriefingData {
  id?: string;
  period: string;
  title: string;
  macroSection: string;
  portfolioActivitySection: string;
  performanceCommentarySection: string;
  outlookSection: string;
  status?: "draft" | "published";
}

const LABEL: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "#6B6B66",
  marginBottom: 6,
};
const INPUT: React.CSSProperties = {
  width: "100%",
  border: "1px solid #D9D9D2",
  borderRadius: 3,
  padding: "9px 11px",
  fontSize: 14,
  outline: "none",
  fontFamily: "system-ui, sans-serif",
  color: "#0A0A0A",
  background: "white",
  boxSizing: "border-box",
  lineHeight: 1.6,
};

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function BriefingEditor({
  fundSlug,
  initial,
}: {
  fundSlug: string;
  initial?: BriefingData;
}) {
  const router = useRouter();
  const isEdit = Boolean(initial?.id);

  const [period, setPeriod] = useState(initial?.period ?? thisMonth());
  const [title, setTitle] = useState(initial?.title ?? "");
  const [macro, setMacro] = useState(initial?.macroSection ?? "");
  const [activity, setActivity] = useState(initial?.portfolioActivitySection ?? "");
  const [performance, setPerformance] = useState(initial?.performanceCommentarySection ?? "");
  const [outlook, setOutlook] = useState(initial?.outlookSection ?? "");
  const [status] = useState(initial?.status ?? "draft");

  const [busy, setBusy] = useState<null | "save" | "publish" | "unpublish">(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: "save" | "publish" | "unpublish") {
    setBusy(action);
    setError(null);
    const payload = {
      action,
      period,
      title,
      macroSection: macro,
      portfolioActivitySection: activity,
      performanceCommentarySection: performance,
      outlookSection: outlook,
      ...(action === "publish" && !isEdit ? { publish: true } : {}),
    };
    try {
      const url = isEdit
        ? `/api/funds/${fundSlug}/briefings/${initial!.id}`
        : `/api/funds/${fundSlug}/briefings`;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setBusy(null);
        return;
      }
      router.push(`/dashboard/funds/${fundSlug}/briefings`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(null);
    }
  }

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    rows: number,
    optional = false
  ) => (
    <div style={{ marginBottom: 18 }}>
      <label style={LABEL}>
        {label}
        {optional ? <span style={{ textTransform: "none", letterSpacing: 0, color: "#9A9A8E" }}> (optional)</span> : null}
      </label>
      <textarea value={value} onChange={(e) => set(e.target.value)} rows={rows} style={{ ...INPUT, resize: "vertical" }} />
    </div>
  );

  return (
    <div style={{ background: "white", border: "1px solid #D9D9D2", padding: "22px 24px", maxWidth: 760 }}>
      <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 16, marginBottom: 18 }}>
        <div>
          <label style={LABEL}>Period</label>
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={INPUT} disabled={isEdit} />
        </div>
        <div>
          <label style={LABEL}>Title</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. May 2026 monthly commentary" style={INPUT} />
        </div>
      </div>

      {field("Macro & market backdrop", macro, setMacro, 4)}
      {field("Portfolio activity", activity, setActivity, 4)}
      {field("Performance commentary", performance, setPerformance, 4)}
      {field("Outlook", outlook, setOutlook, 3, true)}

      {error ? (
        <div style={{ background: "#F8E8E8", border: "1px solid #DBB2B2", padding: "10px 12px", marginBottom: 16, color: "#7A1F1F", fontSize: 12.5, lineHeight: 1.5 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button type="button" onClick={() => submit("save")} disabled={busy !== null}
          style={btn(false, busy !== null)}>
          {busy === "save" ? "Saving…" : isEdit ? "Save changes" : "Save draft"}
        </button>

        {status === "published" && isEdit ? (
          <button type="button" onClick={() => submit("unpublish")} disabled={busy !== null} style={btn(false, busy !== null)}>
            {busy === "unpublish" ? "…" : "Unpublish"}
          </button>
        ) : (
          <button type="button" onClick={() => submit("publish")} disabled={busy !== null} style={btn(true, busy !== null)}>
            {busy === "publish" ? "Publishing…" : "Publish"}
          </button>
        )}

        {status === "published" ? (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#1F5C3A", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Published
          </span>
        ) : (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#9A9A8E", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Draft
          </span>
        )}
      </div>
    </div>
  );
}

function btn(primary: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: "9px 18px",
    background: disabled ? "#9A9A8E" : primary ? "#00183A" : "white",
    color: primary ? "white" : "#00183A",
    border: "1px solid",
    borderColor: disabled ? "#9A9A8E" : "#00183A",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
    fontWeight: 500,
    fontFamily: "system-ui, sans-serif",
  };
}
