"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * PM control for featuring a thesis on the public fund page.
 *
 * When the position is open and not yet disclosed, featuring it publishes the
 * holding ahead of the disclosure lag. The server asks for acknowledgement in
 * that case; this shows the warning in plain terms and makes confirming a
 * deliberate second click rather than an accident.
 */
export default function FeatureThesisControl({
  fundSlug,
  thesisId,
  featured,
  approved,
  safeToFeature,
  disclosedOnly,
}: {
  fundSlug: string;
  thesisId: string;
  featured: boolean;
  approved: boolean;
  safeToFeature: boolean;
  disclosedOnly: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function send(next: boolean, acknowledgeDisclosure = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/funds/${fundSlug}/theses/${thesisId}/feature`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featured: next, acknowledgeDisclosure }),
      });
      const data = await res.json();
      if (data.needsAcknowledgement) {
        setConfirming(true);
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Failed");
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const BOX: React.CSSProperties = {
    marginTop: 16, padding: "12px 14px", border: "1px solid #E5E5DE",
    background: "white", fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#444",
  };
  const LINK: React.CSSProperties = {
    background: "none", border: "none", padding: 0, fontSize: 12,
    cursor: busy ? "default" : "pointer", textDecoration: "underline",
  };

  if (!approved) {
    return (
      <div style={{ ...BOX, color: "#9A9A8E" }}>
        Only approved theses can be featured on the public page.
      </div>
    );
  }

  if (featured) {
    return (
      <div style={BOX}>
        <span style={{ color: "#2F5D45", fontWeight: 600 }}>Featured</span> on the public fund page.{" "}
        <button onClick={() => send(false)} disabled={busy} style={{ ...LINK, color: "#7A1F1F" }}>
          Remove from public page
        </button>
        {error ? <div style={{ color: "#7A1F1F", marginTop: 6 }}>{error}</div> : null}
      </div>
    );
  }

  if (!safeToFeature && disclosedOnly) {
    return (
      <div style={{ ...BOX, color: "#9A9A8E" }}>
        This fund only features closed or already-disclosed positions. This one is open and not yet
        published, so it can be featured once it appears in disclosed holdings or is closed.
      </div>
    );
  }

  if (confirming) {
    return (
      <div style={{ ...BOX, borderLeft: "3px solid #8A6D1F", background: "#FBFAF6" }}>
        <div style={{ fontWeight: 600, color: "#8A6D1F", marginBottom: 6 }}>
          This publishes a live position
        </div>
        <div style={{ lineHeight: 1.55, marginBottom: 10 }}>
          The fund still holds this and it has not appeared in disclosed holdings yet. Featuring it
          reveals the position ahead of your disclosure lag, which exists so nobody can trade ahead
          of the fund.
        </div>
        <button
          onClick={() => send(true, true)}
          disabled={busy}
          style={{ padding: "6px 12px", border: "none", background: "#8A6D1F", color: "white", fontSize: 12, cursor: busy ? "default" : "pointer", marginRight: 10 }}
        >
          {busy ? "Featuring…" : "Feature anyway"}
        </button>
        <button onClick={() => setConfirming(false)} disabled={busy} style={{ ...LINK, color: "#6B6B66" }}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={BOX}>
      <button onClick={() => send(true)} disabled={busy} style={{ ...LINK, color: "#00183A" }}>
        {busy ? "Working…" : "Feature on the public fund page"}
      </button>
      {!safeToFeature ? (
        <span style={{ color: "#8A6D1F", marginLeft: 8 }}>· open, undisclosed position</span>
      ) : null}
      {error ? <div style={{ color: "#7A1F1F", marginTop: 6 }}>{error}</div> : null}
    </div>
  );
}
