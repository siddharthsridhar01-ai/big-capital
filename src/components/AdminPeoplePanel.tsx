"use client";

import { useEffect, useState } from "react";

/**
 * Provisioning people without the terminal.
 *
 * Paste a list in the form used when briefing it by hand:
 *
 *   Sarah Lee, s.lee-xin-ru@lse.ac.uk, european-equity, pm
 *   Jane Doe,  j.doe@lse.ac.uk,        long-short,      analyst
 *
 * Adding someone creates or matches their account by email and grants fund
 * access, so the entry confers real permissions rather than a display profile.
 * The table shows who has actually signed in, which a row's existence does not
 * tell you.
 */
type Person = {
  id: string;
  fullName: string;
  email: string;
  secondaryEmail: string | null;
  role: string;
  signedIn: boolean;
  firstSignInAt: string | null;
  funds: Array<{ slug: string; name: string; roleInFund: string }>;
};

const ROLE_LABEL: Record<string, string> = {
  pm: "Portfolio Manager",
  senior_analyst: "Senior Analyst",
  analyst: "Analyst",
};

export default function AdminPeoplePanel() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [funds, setFunds] = useState<Array<{ slug: string; name: string }>>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<Record<string, unknown>> | null>(null);
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  /**
   * Placeholder rows from the old display-only team page, and the system
   * account. Hidden by default: they are artefacts, and flagging them as "not
   * signed in" alongside real people is noise rather than information.
   */
  function isArtefact(p: Person) {
    return p.email.endsWith("@bigcapital.invalid");
  }

  async function setRole(userId: string, role: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/people/role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) setError(data.error ?? "Could not change role");
      else await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function merge(sourceId: string, targetId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/people/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, targetId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) setError(data.error ?? "Merge failed");
      else { setMergeFrom(null); await load(); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    try {
      const res = await fetch("/api/admin/people");
      const data = await res.json();
      if (data.ok) {
        setPeople(data.people);
        setFunds(data.funds ?? []);
      } else setError(data.error ?? "Could not load");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  /** One person per line: name, email, fund slug, role. */
  function parse(raw: string) {
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [fullName, email, fund, role] = line.split(",").map((p) => (p ?? "").trim());
        return { fullName, email, fund, role: role || "analyst" };
      });
  }

  async function submit() {
    const entries = parse(text);
    if (entries.length === 0) return;
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/admin/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Failed (${res.status})`);
        return;
      }
      setResults(data.results);
      setText("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const BOX: React.CSSProperties = {
    border: "1px solid #E5E5DE",
    background: "white",
    padding: "16px 20px",
    fontFamily: "system-ui, sans-serif",
  };
  const MUTED: React.CSSProperties = { fontSize: 11, color: "#9A9A8E" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)", gap: 18 }}>
      <div style={BOX}>
        <div style={{ fontSize: 13, color: "#444", lineHeight: 1.6, marginBottom: 10 }}>
          One person per line: <strong>name, email, fund, role</strong>. They are created or
          matched by email and given access to that fund.
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          spellCheck={false}
          placeholder={"Sarah Lee, s.lee-xin-ru@lse.ac.uk, european-equity, pm\nJane Doe, j.doe@lse.ac.uk, long-short, analyst"}
          style={{
            width: "100%", padding: 10, border: "1px solid #D9D9D2",
            fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5,
            lineHeight: 1.6, resize: "vertical",
          }}
        />
        <div style={{ ...MUTED, margin: "8px 0 12px" }}>
          Roles: <code>pm</code>, <code>senior_analyst</code>, <code>analyst</code>. Funds:{" "}
          {funds.map((f) => f.slug).join(", ") || "loading…"}
        </div>
        <button
          onClick={submit}
          disabled={busy || text.trim().length === 0}
          style={{
            padding: "7px 14px", border: "none", fontSize: 12, color: "white",
            background: busy || !text.trim() ? "#D9D9D2" : "#00183A",
            cursor: busy || !text.trim() ? "default" : "pointer",
          }}
        >
          {busy ? "Adding…" : "Add people"}
        </button>

        {error ? <div style={{ color: "#7A1F1F", marginTop: 10, fontSize: 12 }}>{error}</div> : null}

        {results ? (
          <div style={{ marginTop: 14, fontSize: 12 }}>
            {results.map((r, i) => (
              <div key={i} style={{ padding: "4px 0", borderBottom: "1px solid #F0EFEA" }}>
                <span style={{ color: String(r.status).startsWith("skip") ? "#7A1F1F" : "#2F5D45" }}>
                  {String(r.status)}
                </span>
                {" · "}
                <span style={{ color: "#444" }}>{String(r.email)}</span>
                {r.reason ? <span style={{ color: "#9A9A8E" }}> — {String(r.reason)}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div style={BOX}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: "#9A9A8E" }}>
            People
          </span>
          <span style={MUTED}>
            {people
              ? `${people.filter((p) => !isArtefact(p) && p.signedIn).length} of ${people.filter((p) => !isArtefact(p)).length} signed in`
              : "…"}
          </span>
        </div>

        {people && people.some(isArtefact) ? (
          <button
            onClick={() => setShowAll((v) => !v)}
            style={{ background: "none", border: "none", padding: 0, marginBottom: 8, color: "#8A6D1F", fontSize: 11, cursor: "pointer", textDecoration: "underline" }}
          >
            {showAll ? "hide" : "show"} {people.filter(isArtefact).length} legacy entries
          </button>
        ) : null}

        {!people ? (
          <div style={MUTED}>Loading…</div>
        ) : people.length === 0 ? (
          <div style={MUTED}>Nobody yet.</div>
        ) : (
          people
            .filter((p) => showAll || !isArtefact(p))
            .map((p) => (
            <div key={p.id} style={{ padding: "9px 0", borderBottom: "1px solid #F0EFEA" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontSize: 13, color: isArtefact(p) ? "#9A9A8E" : "#00183A" }}>
                  {p.fullName}
                  {p.role === "admin" ? (
                    <span style={{ ...MUTED, marginLeft: 6, color: "#8A6D1F" }}>admin</span>
                  ) : null}
                </span>
                {/* Only say "not signed in" for real people awaiting onboarding. */}
                <span style={{ fontSize: 11, color: "#2F5D45", whiteSpace: "nowrap" }}>
                  {isArtefact(p) ? (
                    <span style={{ color: "#9A9A8E" }}>legacy entry</span>
                  ) : p.signedIn ? (
                    "signed in"
                  ) : (
                    <span style={{ color: "#8A6D1F" }}>not signed in</span>
                  )}
                </span>
              </div>
              {/* Primary address first, then any linked personal one beneath it,
                  mirroring how Clerk presents them. */}
              <div style={MUTED}>{p.email}</div>
              {p.secondaryEmail ? (
                <div style={{ ...MUTED, color: "#C4C4BC" }}>{p.secondaryEmail}</div>
              ) : null}
              <div style={{ ...MUTED, marginTop: 2 }}>
                {p.funds.length === 0
                  ? "no fund"
                  : p.funds.map((f) => `${f.slug} · ${ROLE_LABEL[f.roleInFund] ?? f.roleInFund}`).join("   ")}
              </div>

              {mergeFrom === p.id ? (
                <div style={{ marginTop: 6, fontSize: 11 }}>
                  <span style={{ color: "#7A1F1F" }}>Merge this record into: </span>
                  <select
                    onChange={(e) => e.target.value && merge(p.id, e.target.value)}
                    defaultValue=""
                    disabled={busy}
                    style={{ fontSize: 11, padding: "2px 4px", border: "1px solid #D9D9D2" }}
                  >
                    <option value="">choose…</option>
                    {people!.filter((o) => o.id !== p.id).map((o) => (
                      <option key={o.id} value={o.id}>{o.fullName} · {o.email}</option>
                    ))}
                  </select>
                  <button onClick={() => setMergeFrom(null)} style={{ marginLeft: 8, background: "none", border: "none", color: "#6B6B66", fontSize: 11, cursor: "pointer" }}>cancel</button>
                </div>
              ) : (
                <div style={{ marginTop: 4, display: "flex", gap: 12 }}>
                  <button
                    onClick={() => setMergeFrom(p.id)}
                    style={{ background: "none", border: "none", padding: 0, color: "#8A6D1F", fontSize: 11, cursor: "pointer", textDecoration: "underline" }}
                  >
                    merge into another record
                  </button>
                  {/* Platform-wide access, separate from any fund role. */}
                  {!isArtefact(p) ? (
                    <button
                      onClick={() => setRole(p.id, p.role === "admin" ? "pm" : "admin")}
                      disabled={busy}
                      style={{ background: "none", border: "none", padding: 0, color: p.role === "admin" ? "#7A1F1F" : "#2F5D45", fontSize: 11, cursor: busy ? "default" : "pointer", textDecoration: "underline" }}
                    >
                      {p.role === "admin" ? "remove admin" : "make admin"}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
