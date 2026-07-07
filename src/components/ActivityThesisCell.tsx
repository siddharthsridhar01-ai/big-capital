"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export interface ThesisOption {
  id: string;
  title: string;
}

interface Props {
  fundSlug: string;
  txId: string;
  /** Currently-linked thesis, if any. */
  linkedThesisId: string | null;
  linkedThesisTitle: string | null;
  /** Whether this transaction type can carry a thesis (buy/sell/short/cover). */
  linkable: boolean;
  securityId: string | null;
  /** Active theses for this trade's security, offered in the picker. */
  options: ThesisOption[];
}

const MUTED = "#9A9A8E";
const NAVY = "#00183A";
const AMBER = "#8A6D1F";

export default function ActivityThesisCell({
  fundSlug,
  txId,
  linkedThesisId,
  linkedThesisTitle,
  linkable,
  securityId,
  options,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already linked → show the thesis as a quiet link to its page.
  if (linkedThesisId) {
    return (
      <Link
        href={`/dashboard/funds/${fundSlug}/theses/${linkedThesisId}`}
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          color: MUTED,
          textDecoration: "none",
          maxWidth: 220,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          display: "inline-block",
        }}
        title={linkedThesisTitle ?? "View thesis"}
      >
        <span style={{ color: "#C9C9C0" }}>↳ </span>
        <span style={{ borderBottom: "1px solid #E5E5DE" }}>{linkedThesisTitle ?? "Thesis"}</span>
      </Link>
    );
  }

  // Not linkable (dividend, cash, fx, corporate action) → nothing.
  if (!linkable) return <span style={{ width: 1 }} />;

  const link = async (thesisId: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/funds/${fundSlug}/transactions/${txId}/thesis`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thesisId }),
        }
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Couldn't link thesis");
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't link thesis");
    } finally {
      setSaving(false);
    }
  };

  const newHref = securityId
    ? `/dashboard/funds/${fundSlug}/theses/new?securityId=${securityId}`
    : `/dashboard/funds/${fundSlug}/theses/new`;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          color: AMBER,
          background: "none",
          border: "none",
          borderBottom: "1px dashed #D9C79A",
          padding: 0,
          cursor: "pointer",
        }}
        title="Link this trade to a thesis"
      >
        Link thesis
      </button>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
        justifyContent: "flex-end",
        maxWidth: 320,
      }}
    >
      {options.length > 0 ? (
        options.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={saving}
            onClick={() => link(o.id)}
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 11,
              color: NAVY,
              background: "white",
              border: "1px solid #D9D9D2",
              borderRadius: 2,
              padding: "2px 8px",
              cursor: saving ? "default" : "pointer",
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={`Link to "${o.title}"`}
          >
            {o.title}
          </button>
        ))
      ) : (
        <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: MUTED }}>
          No thesis yet for this holding
        </span>
      )}
      <Link
        href={newHref}
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          color: "#1F5C3A",
          textDecoration: "none",
          border: "1px solid #CDE0D2",
          borderRadius: 2,
          padding: "2px 8px",
        }}
      >
        + New thesis
      </Link>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          color: MUTED,
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "2px 4px",
        }}
        aria-label="Cancel"
      >
        ✕
      </button>
      {error && (
        <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 10, color: "#7A1F1F", width: "100%", textAlign: "right" }}>
          {error}
        </span>
      )}
    </div>
  );
}
