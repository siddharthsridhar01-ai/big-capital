"use client";

import { useState } from "react";
import Link from "next/link";
import { currencySymbol } from "@/lib/currency";

const C = {
  ink: "#00183A", muted: "#6B6B66", faint: "#9A9A8E", line: "#E5E5DE",
  row: "#F0EFEA", red: "#7A1F1F", green: "#2F5D45", amber: "#8A6D1F",
};

type Line = {
  line: number; ticker: string; name: string | null; side: string; shares: number;
  price: string | null; currency: string | null; valueBase: string | null;
  status: "ok" | "soft" | "hard" | "error"; messages: string[];
};
type Summary = {
  orders: number; ok: number; breaches: number; errors: number;
  buysBase: string; salesBase: string; endCashBase: string; endCashPct: string;
  endGrossPct: string; endNetPct: string; endPositions: number;
  pendingOrdersIncluded: number; baseCurrency: string;
};

const sym = currencySymbol;
const pct = (v: string) => `${(Number(v) * 100).toFixed(1)}%`;
const money = (v: string, c: string) => `${sym(c)}${Math.round(Number(v)).toLocaleString("en-GB")}`;

const STATUS: Record<Line["status"], { label: string; colour: string }> = {
  ok: { label: "OK", colour: C.green },
  soft: { label: "Soft breach", colour: C.amber },
  hard: { label: "Hard breach", colour: C.red },
  error: { label: "Error", colour: C.red },
};

export default function BasketTrader({ fundSlug, fundName }: { fundSlug: string; fundName: string }) {
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [clean, setClean] = useState(false);
  const [parseErrors, setParseErrors] = useState<Array<{ line: number; message: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<number | null>(null);

  function reset() {
    setLines(null); setSummary(null); setClean(false); setParseErrors([]); setError(null);
  }

  async function call(apply: boolean) {
    setBusy(true); setError(null); setParseErrors([]);
    try {
      const res = await fetch(`/api/funds/${fundSlug}/basket`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, label, apply }),
      });
      const d = await res.json();
      if (d.parseErrors) { setParseErrors(d.parseErrors); setLines(null); return; }
      if (d.lines) { setLines(d.lines); setSummary(d.summary); setClean(Boolean(d.clean)); }
      if (!d.ok) { setError(d.error ?? "Failed"); return; }
      if (apply) setSubmitted(d.submitted);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  function removeFlagged() {
    if (!lines) return;
    const flagged = new Set(lines.filter((l) => l.status !== "ok").map((l) => l.line));
    setText(text.split(/\r?\n/).filter((_, i) => !flagged.has(i + 1)).join("\n"));
    reset();
  }

  async function loadFile(f: File) {
    setText(await f.text());
    reset();
  }

  if (submitted != null) {
    return (
      <div style={{ border: `1px solid ${C.line}`, borderLeft: `3px solid ${C.green}`, background: "white", padding: "16px 20px", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ fontSize: 14, color: C.ink, marginBottom: 6 }}>
          {submitted} order{submitted === 1 ? "" : "s"} queued for {fundName}.
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
          They fill at the next opening print, sales before purchases. Each is re-checked at fill.
        </div>
        <Link href={`/dashboard/funds/${fundSlug}`} style={{ fontSize: 12, color: C.ink }}>View the fund →</Link>
      </div>
    );
  }

  const base = summary?.baseCurrency ?? "GBP";
  const flaggedCount = lines?.filter((l) => l.status !== "ok").length ?? 0;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <div style={{ background: "white", border: `1px solid ${C.line}`, padding: "16px 18px", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional), e.g. October rebalance"
            maxLength={80}
            style={{ flex: "1 1 260px", padding: "7px 9px", border: `1px solid ${C.line}`, fontSize: 13 }}
          />
          <label style={{ fontSize: 12, color: C.ink, border: `1px solid ${C.line}`, padding: "7px 12px", cursor: "pointer" }}>
            Load CSV
            <input type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadFile(f); }} />
          </label>
        </div>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); reset(); }}
          rows={10}
          spellCheck={false}
          placeholder={"ticker, side, shares\nASML.AS, buy, 4\nSAN.MC, buy, 900\nNVDA, short, 40"}
          style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, lineHeight: 1.6, resize: "vertical" }}
        />
        <div style={{ fontSize: 11, color: C.faint, margin: "8px 0 12px", lineHeight: 1.5 }}>
          One order per line: ticker, side (buy, sell, short, cover), shares. Comma or tab separated.
          The basket is all or nothing — any line that breaches a limit stops the whole basket.
        </div>
        <button
          onClick={() => call(false)}
          disabled={busy || !text.trim()}
          style={{ padding: "7px 14px", border: `1px solid ${C.ink}`, background: "white", color: C.ink, fontSize: 12.5, cursor: busy || !text.trim() ? "default" : "pointer" }}
        >
          {busy && !lines ? "Checking…" : "Preview"}
        </button>
      </div>

      {parseErrors.length ? (
        <div style={{ border: "1px solid #E0B8B8", background: "#FBF3F3", padding: "10px 14px", marginBottom: 14 }}>
          {parseErrors.map((e) => (
            <div key={`${e.line}-${e.message}`} style={{ fontSize: 12, color: C.red, lineHeight: 1.6 }}>
              {e.line ? `Line ${e.line}: ` : ""}{e.message}
            </div>
          ))}
        </div>
      ) : null}

      {summary && lines ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 1, background: C.line, border: `1px solid ${C.line}`, marginBottom: 14 }}>
            {[
              ["Orders", `${summary.orders}`],
              ["Purchases", money(summary.buysBase, base)],
              ["Sales", money(summary.salesBase, base)],
              ["Cash after", pct(summary.endCashPct)],
              ["Gross after", pct(summary.endGrossPct)],
              ["Net after", pct(summary.endNetPct)],
              ["Names after", `${summary.endPositions}`],
            ].map(([k, v]) => (
              <div key={k} style={{ background: "white", padding: "10px 12px" }}>
                <div style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: C.faint }}>{k}</div>
                <div style={{ fontSize: 15, color: C.ink, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>
          {summary.pendingOrdersIncluded > 0 ? (
            <div style={{ fontSize: 11, color: C.amber, marginBottom: 10 }}>
              Estimated including {summary.pendingOrdersIncluded} queued order{summary.pendingOrdersIncluded === 1 ? "" : "s"} at last price.
            </div>
          ) : null}

          <div style={{ background: "white", border: `1px solid ${C.line}`, overflowX: "auto", marginBottom: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["Line", "Ticker", "Side", "Shares", "Price", "Value", "Status"].map((h, i) => (
                    <th key={h} style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: C.muted, borderBottom: `1px solid ${C.line}`, padding: "9px 12px", fontWeight: 500, textAlign: i >= 3 && i <= 5 ? "right" : "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const st = STATUS[l.status];
                  return (
                    <tr key={l.line}>
                      <td style={{ padding: "8px 12px", borderBottom: `1px solid ${C.row}`, color: C.faint }}>{l.line}</td>
                      <td style={{ padding: "8px 12px", borderBottom: `1px solid ${C.row}` }}>
                        <span style={{ fontFamily: "ui-monospace, monospace", color: C.ink }}>{l.ticker}</span>
                        {l.name ? <div style={{ fontSize: 10.5, color: C.faint }}>{l.name}</div> : null}
                      </td>
                      <td style={{ padding: "8px 12px", borderBottom: `1px solid ${C.row}`, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 600, color: l.side === "buy" || l.side === "cover" ? C.green : C.red }}>{l.side}</td>
                      <td style={{ padding: "8px 12px", borderBottom: `1px solid ${C.row}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.shares.toLocaleString("en-GB")}</td>
                      <td style={{ padding: "8px 12px", borderBottom: `1px solid ${C.row}`, textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.muted }}>{l.price && l.currency ? `${sym(l.currency)}${l.price}` : "—"}</td>
                      <td style={{ padding: "8px 12px", borderBottom: `1px solid ${C.row}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.valueBase ? money(l.valueBase, base) : "—"}</td>
                      <td style={{ padding: "8px 12px", borderBottom: `1px solid ${C.row}`, color: st.colour, fontSize: 11.5 }}>
                        {st.label}
                        {l.messages.map((m) => (
                          <div key={m} style={{ fontSize: 10.5, color: C.muted, marginTop: 2, maxWidth: 340 }}>{m}</div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {clean ? (
            <button
              onClick={() => { if (window.confirm(`Queue all ${summary.orders} orders for the next open?`)) void call(true); }}
              disabled={busy}
              style={{ padding: "8px 16px", border: "none", background: C.ink, color: "white", fontSize: 12.5, cursor: busy ? "default" : "pointer" }}
            >
              {busy ? "Submitting…" : `Submit ${summary.orders} order${summary.orders === 1 ? "" : "s"}`}
            </button>
          ) : (
            <div style={{ border: "1px solid #E0B8B8", background: "#FBF3F3", padding: "11px 14px" }}>
              <div style={{ fontSize: 12.5, color: C.red, marginBottom: 8 }}>
                {flaggedCount} line{flaggedCount === 1 ? "" : "s"} breach{flaggedCount === 1 ? "es" : ""} a limit or could not be checked. Nothing can be submitted until the basket is clean.
                Trade flagged lines individually through the ticket.
              </div>
              <button onClick={removeFlagged} style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: C.ink, textDecoration: "underline", cursor: "pointer" }}>
                Remove flagged lines
              </button>
            </div>
          )}
        </>
      ) : null}

      {error ? <div style={{ color: C.red, fontSize: 12, marginTop: 10 }}>{error}</div> : null}
    </div>
  );
}
