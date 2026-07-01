"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface MemberData {
  userId?: string;
  fullName: string;
  roleInFund: "pm" | "senior_analyst" | "analyst";
  bio: string;
  linkedinUrl: string;
  graduationYear: string;
  hasHeadshot?: boolean;
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
  lineHeight: 1.5,
};

export default function TeamMemberEditor({
  fundSlug,
  initial,
}: {
  fundSlug: string;
  initial?: MemberData;
}) {
  const router = useRouter();
  const isEdit = Boolean(initial?.userId);

  const [fullName, setFullName] = useState(initial?.fullName ?? "");
  const [roleInFund, setRoleInFund] = useState<MemberData["roleInFund"]>(initial?.roleInFund ?? "analyst");
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [linkedinUrl, setLinkedinUrl] = useState(initial?.linkedinUrl ?? "");
  const [graduationYear, setGraduationYear] = useState(initial?.graduationYear ?? "");
  const [headshot, setHeadshot] = useState<File | null>(null);
  const [removeHeadshot, setRemoveHeadshot] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("fullName", fullName);
    fd.set("roleInFund", roleInFund);
    fd.set("bio", bio);
    fd.set("linkedinUrl", linkedinUrl);
    fd.set("graduationYear", graduationYear);
    if (headshot) fd.set("headshot", headshot);
    if (removeHeadshot) fd.set("removeHeadshot", "true");
    try {
      const url = isEdit ? `/api/funds/${fundSlug}/team/${initial!.userId}` : `/api/funds/${fundSlug}/team`;
      const res = await fetch(url, { method: isEdit ? "PATCH" : "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setBusy(false);
        return;
      }
      router.push(`/dashboard/funds/${fundSlug}/team`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  async function remove() {
    if (!isEdit) return;
    if (!confirm("Remove this person from the fund's team?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/funds/${fundSlug}/team/${initial!.userId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Remove failed");
        setBusy(false);
        return;
      }
      router.push(`/dashboard/funds/${fundSlug}/team`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <div style={{ background: "white", border: "1px solid #D9D9D2", padding: "22px 24px", maxWidth: 620 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 16, marginBottom: 16 }}>
        <div>
          <label style={LABEL}>Full name</label>
          <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} style={INPUT} placeholder="Jane Smith" />
        </div>
        <div>
          <label style={LABEL}>Role</label>
          <select value={roleInFund} onChange={(e) => setRoleInFund(e.target.value as MemberData["roleInFund"])} style={INPUT}>
            <option value="pm">Portfolio Manager</option>
            <option value="senior_analyst">Senior Analyst</option>
            <option value="analyst">Analyst</option>
          </select>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={LABEL}>Bio</label>
        <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} style={{ ...INPUT, resize: "vertical" }} placeholder="Coverage area and focus." />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 16, marginBottom: 16 }}>
        <div>
          <label style={LABEL}>LinkedIn URL <span style={{ textTransform: "none", letterSpacing: 0, color: "#9A9A8E" }}>— optional</span></label>
          <input type="url" value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} style={INPUT} placeholder="https://linkedin.com/in/…" />
        </div>
        <div>
          <label style={LABEL}>Grad year <span style={{ textTransform: "none", letterSpacing: 0, color: "#9A9A8E" }}>— optional</span></label>
          <input type="number" value={graduationYear} onChange={(e) => setGraduationYear(e.target.value)} style={INPUT} placeholder="2027" />
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <label style={LABEL}>Headshot <span style={{ textTransform: "none", letterSpacing: 0, color: "#9A9A8E" }}>— optional, image under 5 MB</span></label>
        <input type="file" accept="image/*" onChange={(e) => setHeadshot(e.target.files?.[0] ?? null)} style={{ fontSize: 13, fontFamily: "system-ui, sans-serif" }} />
        {isEdit && initial?.hasHeadshot && !headshot ? (
          <label style={{ display: "block", fontSize: 12, color: "#6B6B66", marginTop: 8 }}>
            <input type="checkbox" checked={removeHeadshot} onChange={(e) => setRemoveHeadshot(e.target.checked)} style={{ marginRight: 6 }} />
            Remove current headshot (revert to initials)
          </label>
        ) : null}
      </div>

      {error ? (
        <div style={{ background: "#F8E8E8", border: "1px solid #DBB2B2", padding: "10px 12px", marginBottom: 16, color: "#7A1F1F", fontSize: 12.5, lineHeight: 1.5 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button type="button" onClick={save} disabled={busy} style={btn(true, busy)}>
          {busy ? "Saving…" : isEdit ? "Save changes" : "Add member"}
        </button>
        {isEdit ? (
          <button type="button" onClick={remove} disabled={busy} style={{ ...btn(false, busy), borderColor: "#7A1F1F", color: "#7A1F1F", marginLeft: "auto" }}>
            Remove
          </button>
        ) : null}
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
