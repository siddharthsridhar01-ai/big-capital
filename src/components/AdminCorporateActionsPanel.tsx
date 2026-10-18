"use client";

import { useEffect, useState } from "react";

/**
 * The corporate action feed.
 *
 * Every event the system has seen — splits it booked automatically, warnings
 * from SEC filings and headlines, unexplained price moves, holdings that have
 * stopped being priced — and what was done about each, with every fund's
 * before and after.
 *
 * Booking a takeover, merger or spin-off is always PREVIEW FIRST: the admin
 * sees each affected fund's shares, cash and realised P&L before anything is
 * written, then confirms. Nothing here can change a portfolio in one click.
 */

type Severity = "info" | "warning" | "critical";
type Event = {
  id: string;
  securityId: string;
  ticker: string;
  securityName: string | null;
  currency: string | null;
  fund: string | null;
  kind: string;
  status: "detected" | "booked" | "dismissed";
  source: string;
  title: string;
  detail: string | null;
  evidenceUrl: string | null;
  eventDate: string | null;
  detectedAt: string;
  impact: {
    severity?: Severity;
    funds?: Impact[];
    before?: { shares: string };
    after?: { shares: string };
    cashInLieu?: string;
  } | null;
};
type Impact = {
  fund: string;
  before: { heldShares: string; avgCost: string };
  after: { heldShares: string; receivedShares: string; cashChange: string };
  realisedPnl: string;
  entries: number;
};
type Held = { id: string; ticker: string; name: string; currency: string; funds: string[] };
type DealType = "cash" | "shares" | "mixed" | "spin_off";

const KIND_LABEL: Record<string, string> = {
  split: "Stock split",
  takeover_cash: "Cash takeover",
  merger_stock: "Merger",
  spin_off: "Spin-off",
  filing: "SEC filing",
  news: "Headline",
  large_move: "Unexplained move",
  stale_price: "Stopped being priced",
};

const C = {
  ink: "#00183A", muted: "#6B6B66", faint: "#9A9A8E", line: "#E5E5DE",
  green: "#2F5D45", amber: "#8A6D1F", red: "#7A1F1F",
};

export default function AdminCorporateActionsPanel() {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [held, setHeld] = useState<Held[]>([]);
  const [filter, setFilter] = useState<"review" | "all">("review");
  const [booking, setBooking] = useState<{ securityId: string; ticker: string; currency: string; eventId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/admin/corporate-actions");
      const data = await res.json();
      if (!data.ok) return setError(data.error ?? "Could not load the feed");
      setEvents(data.events);
      setHeld(data.held ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  }
  useEffect(() => { void load(); }, []);

  async function dismiss(e: Event) {
    const reason = window.prompt(`Why does ${e.ticker} not need action?`);
    if (!reason) return;
    const res = await fetch("/api/admin/corporate-actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss", eventId: e.id, reason }),
    });
    const data = await res.json();
    if (!data.ok) setError(data.error);
    else void load();
  }

  const needsReview = (e: Event) => e.status === "detected" && e.impact?.severity !== "info";
  const shown = (events ?? []).filter((e) => filter === "all" || needsReview(e));
  const reviewCount = (events ?? []).filter(needsReview).length;

  const BOX: React.CSSProperties = { border: `1px solid ${C.line}`, background: "white", padding: "16px 20px", fontFamily: "system-ui, sans-serif" };

  return (
    <div style={BOX}>
      <div style={{ fontSize: 13, color: "#444", lineHeight: 1.6, marginBottom: 14 }}>
        Stock splits are booked automatically. Takeovers, mergers and spin-offs are detected from
        SEC filings, headlines and price moves, and booked here after you preview the effect on every fund.
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        {(["review", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: "5px 12px", fontSize: 12, cursor: "pointer",
              border: `1px solid ${filter === f ? C.ink : C.line}`,
              background: filter === f ? C.ink : "white", color: filter === f ? "white" : C.muted,
            }}
          >
            {f === "review" ? `Needs review${reviewCount ? ` (${reviewCount})` : ""}` : "All events"}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <select
          value=""
          onChange={(e) => {
            const h = held.find((x) => x.id === e.target.value);
            if (h) setBooking({ securityId: h.id, ticker: h.ticker, currency: h.currency });
          }}
          style={{ fontSize: 12, padding: "5px 8px", border: `1px solid ${C.line}`, color: C.ink }}
        >
          <option value="">Book an event for a holding…</option>
          {held.map((h) => (
            <option key={h.id} value={h.id}>{h.ticker} · {h.name} ({h.funds.join(", ")})</option>
          ))}
        </select>
      </div>

      {error ? <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{error}</div> : null}

      {booking ? (
        <BookingForm
          target={booking}
          onClose={() => setBooking(null)}
          onBooked={() => { setBooking(null); void load(); }}
        />
      ) : null}

      {!events ? (
        <div style={{ fontSize: 12, color: C.faint }}>Loading…</div>
      ) : shown.length === 0 ? (
        <div style={{ fontSize: 12, color: C.faint, padding: "14px 0" }}>
          {filter === "review" ? "Nothing needs review." : "No corporate actions recorded yet."}
        </div>
      ) : (
        shown.map((e) => <EventRow key={e.id} e={e} onBook={() => setBooking({ securityId: e.securityId, ticker: e.ticker, currency: e.currency ?? "", eventId: e.id })} onDismiss={() => dismiss(e)} />)
      )}
    </div>
  );
}

function EventRow({ e, onBook, onDismiss }: { e: Event; onBook: () => void; onDismiss: () => void }) {
  const sev = e.impact?.severity ?? "info";
  const accent = e.status === "booked" ? C.green : e.status === "dismissed" ? C.faint : sev === "critical" ? C.red : sev === "warning" ? C.amber : C.faint;
  const statusLabel = e.status === "booked" ? "Booked" : e.status === "dismissed" ? "Dismissed" : sev === "info" ? "For information" : "Needs review";
  const bookable = e.status === "detected" && ["filing", "news", "large_move", "stale_price"].includes(e.kind);

  return (
    <div style={{ borderTop: `1px solid ${C.line}`, borderLeft: `3px solid ${accent}`, padding: "11px 0 11px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontSize: 13, color: C.ink }}>
          <strong>{e.ticker}</strong>
          <span style={{ color: C.muted }}> · {KIND_LABEL[e.kind] ?? e.kind}</span>
          {e.fund ? <span style={{ color: C.faint }}> · {e.fund}</span> : null}
        </span>
        <span style={{ fontSize: 11, color: accent, whiteSpace: "nowrap" }}>
          {statusLabel}{e.eventDate ? ` · ${e.eventDate}` : ""}
        </span>
      </div>
      {e.detail ? <div style={{ fontSize: 12, color: "#444", lineHeight: 1.55, marginTop: 4, whiteSpace: "pre-wrap" }}>{e.detail}</div> : null}

      {e.kind === "split" && e.impact?.before ? (
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
          {e.impact.before.shares} → {e.impact.after?.shares} shares
          {e.impact.cashInLieu && e.impact.cashInLieu !== "0" ? ` · cash in lieu ${e.impact.cashInLieu}` : ""}
        </div>
      ) : null}

      {e.impact?.funds?.length ? <ImpactTable impacts={e.impact.funds} /> : null}

      <div style={{ display: "flex", gap: 14, marginTop: 6 }}>
        {e.evidenceUrl ? (
          <a href={e.evidenceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.ink }}>Source ↗</a>
        ) : null}
        {bookable ? (
          <>
            <button onClick={onBook} style={linkBtn(C.ink)}>Book…</button>
            <button onClick={onDismiss} style={linkBtn(C.muted)}>No action needed</button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ImpactTable({ impacts }: { impacts: Impact[] }) {
  return (
    <div style={{ overflowX: "auto", marginTop: 8 }}>
      <table style={{ borderCollapse: "collapse", fontSize: 11.5, minWidth: 460 }}>
        <thead>
          <tr style={{ color: C.faint, textAlign: "left" }}>
            {["Fund", "Shares before", "Shares after", "Received", "Cash", "Realised P&L"].map((h) => (
              <th key={h} style={{ padding: "3px 12px 3px 0", fontWeight: 500 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {impacts.map((i) => (
            <tr key={i.fund} style={{ color: "#333", fontVariantNumeric: "tabular-nums" }}>
              <td style={{ padding: "3px 12px 3px 0" }}>{i.fund}</td>
              <td style={{ padding: "3px 12px 3px 0" }}>{i.before.heldShares}</td>
              <td style={{ padding: "3px 12px 3px 0" }}>{i.after.heldShares}</td>
              <td style={{ padding: "3px 12px 3px 0" }}>{i.after.receivedShares}</td>
              <td style={{ padding: "3px 12px 3px 0" }}>{i.after.cashChange}</td>
              <td style={{ padding: "3px 12px 3px 0", color: Number(i.realisedPnl) < 0 ? C.red : Number(i.realisedPnl) > 0 ? C.green : "#333" }}>
                {i.realisedPnl}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BookingForm({
  target,
  onClose,
  onBooked,
}: {
  target: { securityId: string; ticker: string; currency: string; eventId?: string };
  onClose: () => void;
  onBooked: () => void;
}) {
  const [deal, setDeal] = useState<DealType>("cash");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [ratio, setRatio] = useState("");
  const [cash, setCash] = useState("");
  const [symbol, setSymbol] = useState("");
  const [receivedPrice, setReceivedPrice] = useState("");
  const [parentPrice, setParentPrice] = useState("");
  const [preview, setPreview] = useState<{ title: string; summary: string; impacts: Impact[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function payload(apply: boolean) {
    const spin = deal === "spin_off";
    return {
      action: "book",
      kind: spin ? "spin_off" : "merger",
      securityId: target.securityId,
      effectiveDate: date,
      ratio: deal === "cash" ? "0" : ratio,
      cashPerShare: deal === "cash" || deal === "mixed" ? cash : "0",
      receivedSymbol: deal === "cash" ? undefined : symbol,
      receivedPrice: deal === "cash" ? undefined : receivedPrice,
      parentPrice: spin ? parentPrice : undefined,
      eventId: target.eventId,
      apply,
    };
  }

  async function submit(apply: boolean) {
    if (apply && !window.confirm(`Book this for every fund holding ${target.ticker}? It rewrites their holdings.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/corporate-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload(apply)),
      });
      const data = await res.json();
      if (!data.ok) return setError(data.error ?? "Failed");
      if (apply) onBooked();
      else setPreview({ title: data.title, summary: data.summary, impacts: data.impacts });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const reset = () => setPreview(null);
  const field = (label: string, value: string, set: (v: string) => void, placeholder: string, hint?: string) => (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => { set(e.target.value); reset(); }}
        placeholder={placeholder}
        style={{ width: "100%", maxWidth: 260, padding: "6px 8px", border: `1px solid ${C.line}`, fontSize: 13 }}
      />
      {hint ? <div style={{ fontSize: 10.5, color: C.faint, marginTop: 2 }}>{hint}</div> : null}
    </label>
  );

  return (
    <div style={{ border: `1px solid ${C.ink}`, padding: "14px 16px", margin: "4px 0 16px", background: "#FBFBF8" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <strong style={{ fontSize: 13, color: C.ink }}>Book a corporate action for {target.ticker}</strong>
        <button onClick={onClose} style={linkBtn(C.muted)}>Cancel</button>
      </div>

      <div style={{ display: "flex", gap: 0, marginBottom: 12, flexWrap: "wrap" }}>
        {([["cash", "Cash takeover"], ["shares", "Share merger"], ["mixed", "Cash and shares"], ["spin_off", "Spin-off"]] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => { setDeal(k); reset(); }}
            style={{
              padding: "6px 12px", fontSize: 12, cursor: "pointer", marginLeft: -1,
              border: `1px solid ${C.line}`, background: deal === k ? C.ink : "white", color: deal === k ? "white" : C.muted,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {field("Effective date", date, setDate, "YYYY-MM-DD", deal === "spin_off" ? "The ex-date" : "The date the deal completes")}
      {deal === "cash" || deal === "mixed"
        ? field(`Cash per ${target.ticker} share (${target.currency})`, cash, setCash, "e.g. 48.20")
        : null}
      {deal !== "cash" ? (
        <>
          {field(deal === "spin_off" ? "Spin-off ticker" : "Acquirer ticker", symbol, setSymbol, "e.g. ACME.L", "The exact Yahoo symbol")}
          {field(
            deal === "spin_off" ? `Spin-off shares per ${target.ticker} share` : `Acquirer shares per ${target.ticker} share`,
            ratio, setRatio, "e.g. 0.5"
          )}
          {field(deal === "spin_off" ? "Spin-off's first-day price" : "Acquirer's price on the effective date", receivedPrice, setReceivedPrice, "in its own currency")}
        </>
      ) : null}
      {deal === "spin_off" ? field(`${target.ticker}'s ex-date price`, parentPrice, setParentPrice, `in ${target.currency}`) : null}

      {error ? <div style={{ color: C.red, fontSize: 12, margin: "6px 0" }}>{error}</div> : null}

      {preview ? (
        <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 10, paddingTop: 10 }}>
          <div style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{preview.title}</div>
          <div style={{ fontSize: 12, color: "#444", marginTop: 2 }}>{preview.summary}</div>
          <ImpactTable impacts={preview.impacts} />
          <button
            onClick={() => submit(true)}
            disabled={busy}
            style={{ marginTop: 12, padding: "7px 14px", border: "none", background: C.red, color: "white", fontSize: 12, cursor: busy ? "default" : "pointer" }}
          >
            {busy ? "Booking…" : `Confirm and book for ${preview.impacts.length} fund${preview.impacts.length === 1 ? "" : "s"}`}
          </button>
        </div>
      ) : (
        <button
          onClick={() => submit(false)}
          disabled={busy}
          style={{ marginTop: 4, padding: "7px 14px", border: `1px solid ${C.ink}`, background: "white", color: C.ink, fontSize: 12, cursor: busy ? "default" : "pointer" }}
        >
          {busy ? "Working…" : "Preview the effect on each fund"}
        </button>
      )}
    </div>
  );
}

function linkBtn(color: string): React.CSSProperties {
  return { background: "none", border: "none", padding: 0, fontSize: 11, color, cursor: "pointer", textDecoration: "underline" };
}
