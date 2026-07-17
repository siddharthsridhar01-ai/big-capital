"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Result =
  | { kind: "success"; msg: string; warning?: string | null }
  | { kind: "info"; msg: string; warning?: string | null }
  | { kind: "error"; msg: string }
  | null;

export default function AddToUniverse({ fundSlug, mandateHint }: { fundSlug: string; mandateHint?: string | null }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  async function submit() {
    const s = symbol.trim();
    if (!s || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/funds/${fundSlug}/universe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: s }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setResult({ kind: "error", msg: data.error ?? "Something went wrong." });
      } else if (data.alreadyInWatchlist) {
        setResult({ kind: "info", msg: `${data.security.ticker} is already on this fund's watchlist.`, warning: data.warning });
      } else {
        const sec = data.security;
        const days = typeof data.daysStored === "number" && data.daysStored > 0 ? ` Loaded ${data.daysStored} days of price history.` : "";
        setResult({
          kind: "success",
          msg: `Added ${sec.ticker} — ${sec.name} (${sec.exchange}, ${sec.currency})${sec.type === "ETF" ? " · ETF" : ""}.${days}`,
          warning: data.warning,
        });
        setSymbol("");
        router.refresh();
      }
    } catch {
      setResult({ kind: "error", msg: "Network error — please try again." });
    } finally {
      setBusy(false);
    }
  }

  const color =
    result?.kind === "success" ? "#1F5C3A" : result?.kind === "error" ? "#7A1F1F" : "#6B6B66";

  return (
    <div
      style={{
        border: "1px solid #E5E5DE",
        borderRadius: 6,
        padding: "16px 18px",
        marginBottom: 24,
        background: "white",
        maxWidth: 720,
      }}
    >
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, fontWeight: 600, color: "#00183A", marginBottom: 4 }}>
        Add to watchlist
      </div>
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6B6B66", marginBottom: 12, lineHeight: 1.5 }}>
        Enter the exact ticker as listed on Yahoo Finance — including the exchange suffix for non-US names
        (e.g. <code>AAPL</code>, <code>AZN.L</code>, <code>7203.T</code>, <code>2330.TW</code>). It&apos;s
        validated live and added to this fund&apos;s watchlist.
        {mandateHint && (
          <span style={{ display: "block", marginTop: 6, color: "#8A6D1F" }}>Mandate: {mandateHint}</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="e.g. 2330.TW"
          disabled={busy}
          style={{
            flex: "0 1 240px",
            padding: "8px 10px",
            border: "1px solid #D9D9D2",
            borderRadius: 4,
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            textTransform: "uppercase",
          }}
        />
        <button
          onClick={submit}
          disabled={busy || !symbol.trim()}
          style={{
            padding: "8px 16px",
            background: busy || !symbol.trim() ? "#C8C8C0" : "#00183A",
            color: "white",
            border: "none",
            borderRadius: 4,
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            fontWeight: 500,
            cursor: busy || !symbol.trim() ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Checking…" : "Add"}
        </button>
      </div>
      {result && (
        <div style={{ marginTop: 12, fontFamily: "system-ui, sans-serif", fontSize: 12.5, color, lineHeight: 1.5 }}>
          {result.msg}
          {"warning" in result && result.warning && (
            <div style={{ marginTop: 4, color: "#8A6D1F" }}>⚠ {result.warning}</div>
          )}
        </div>
      )}
    </div>
  );
}
