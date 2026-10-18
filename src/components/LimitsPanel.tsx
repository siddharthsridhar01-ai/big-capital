/**
 * Limits panel for the fund dashboard.
 *
 * Answers what the rest of the dashboard doesn't: is this book on mandate right
 * now? checkTrade() only speaks when a PM tries to trade, so without this a fund
 * can sit off-mandate indefinitely and only find out when a trade is blocked.
 *
 * One line per limit — label, bar, value, status — so a full mandate fits in a
 * glance without scrolling. Rows sort by utilisation, tightest first: the limit
 * closest to binding is the one that matters before the next trade.
 *
 * Server component — pure presentation of loadBookLimits() output.
 */

import { serif, numeric } from "@/lib/typography";
import type { BookLimitsResult, LimitWithForward } from "@/lib/book-limits";
import { RAMP_UP_DAYS } from "@/lib/constraints";

/** Amber from 80% of limit. A convention, not a standard — one number, one place. */
const WARN_AT = 0.8;

const INK = "#00183A";
const MUTED = "#9A9A8E";
const RULE = "#E5E5DE";
const TRACK = "#F0EFEA";
const OK = "#2F5D45";
const WARN = "#8A6D1F";
const BAD = "#7A1F1F";

function fmt(v: number, isPct: boolean) {
  return isPct ? `${(v * 100).toFixed(1)}%` : String(Math.round(v));
}

interface Row {
  key: string;
  label: string;
  detail?: string;
  value: string;
  status: string;
  utilisation: number;
  colour: string;
  breached: boolean;
  /** Where the limit will stand once queued orders fill, when there are any. */
  forwardUtil?: number;
  /** The tighter of now and after-queue — what the row sorts by. */
  sortKey: number;
}

/**
 * A cash floor and a cash ceiling measure the same thing against two bounds.
 * Shown separately they printed the same percentage twice, and the floor drew a
 * bar reading "3% used" when the floor was in fact comfortably satisfied.
 */
function toRows(limits: LimitWithForward[]): Row[] {
  const floor = limits.find((l) => l.constraintType === "min_cash_pct");
  const ceiling = limits.find((l) => l.constraintType === "max_cash_pct");
  const rows: Row[] = [];

  for (const l of limits) {
    // The cash FLOOR is not shown alongside the ceiling. Printing "2.0%–15.0%"
    // reads as a band a PM must sit inside, when in practice only the ceiling
    // binds: these funds are trying to get invested, not to hold a minimum. The
    // floor is still enforced on every trade, and appears as its own row below
    // if it is ever actually breached, so it is never hidden when it matters.
    // ...and if the QUEUE would take cash below the floor, that is shown too:
    // it is the warning that the later orders will be refused at the open.
    if (l.constraintType === "min_cash_pct" && ceiling && !l.breached && !l.forward?.breached) continue;

    const isFloorBreach = l.constraintType === "min_cash_pct";
    const breached = l.breached;
    const util = l.utilisation ?? 0;
    const colour = breached ? BAD : l.exempt ? MUTED : util >= WARN_AT ? WARN : OK;

    const f = l.forward;
    const changes = f && Math.abs(f.current - l.current) > 1e-9;
    const fUtil = f?.utilisation ?? 0;
    const breachesLater = Boolean(f?.breached && !breached && !f.exempt);
    const nowStr = fmt(l.current, l.isPct || isFloorBreach);
    const fwdStr = changes ? ` → ${fmt(f!.current, l.isPct || isFloorBreach)}` : "";
    // The binding name can change once the queue fills — Financials now,
    // Industrials after — so show the forward one when it differs.
    const detail = changes && f!.detail && f!.detail !== l.detail
      ? `${l.detail ?? "—"} → ${f!.detail}`
      : l.detail;

    rows.push({
      key: l.constraintType,
      label: isFloorBreach ? "Cash floor" : l.constraintType === "max_cash_pct" ? "Cash" : l.label,
      detail,
      value: isFloorBreach
        ? `${nowStr}${fwdStr} / min ${fmt(l.limit, true)}`
        : `${nowStr}${fwdStr} / ${fmt(l.limit, l.isPct)}`,
      status: breached
        ? "Breach"
        : breachesLater
          ? "After queue"
          : l.exempt === "ramp-up"
            ? "N/A"
            : `${Math.round((changes ? fUtil : util) * 100)}%`,
      utilisation: isFloorBreach ? 1 : util,
      colour: breachesLater ? BAD : changes && !l.exempt && fUtil >= WARN_AT && !breached ? WARN : colour,
      breached: breached || breachesLater,
      forwardUtil: changes && !isFloorBreach ? fUtil : undefined,
      sortKey: isFloorBreach || breachesLater ? 1.01 : Math.max(util, changes ? fUtil : 0),
    });
  }

  return rows.sort((a, b) => b.sortKey - a.sortKey);
}

export default function LimitsPanel({ data }: { data: BookLimitsResult }) {
  const rows = toRows(data.limits);
  if (rows.length === 0 && data.hardRules.length === 0) return null;
  const hasExempt = data.limits.some((l) => l.exempt === "ramp-up");

  return (
    <div style={{ marginTop: 28, marginBottom: 36 }}>
      <h2 style={{ ...serif, fontSize: 18, color: INK, margin: "0 0 10px" }}>Limits</h2>

      <div style={{ background: "white", border: `1px solid ${RULE}`, padding: "14px 18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase", color: MUTED }}>
            Mandate
          </span>
          <span style={{ ...numeric, fontSize: 11, color: data.breachCount > 0 ? BAD : MUTED }}>
            {data.breachCount === 0 ? "Within limits" : `${data.breachCount} breach${data.breachCount === 1 ? "" : "es"}`}
            {data.forwardBreachCount > 0 ? (
              <span style={{ color: BAD }}> · {data.forwardBreachCount} after queued orders</span>
            ) : null}
          </span>
        </div>
        {data.pendingOrdersIncluded > 0 ? (
          <div style={{ fontSize: 11, color: WARN, margin: "-4px 0 10px", lineHeight: 1.5 }}>
            Showing where each limit stands now, and after {data.pendingOrdersIncluded} queued order
            {data.pendingOrdersIncluded === 1 ? "" : "s"} fill at their latest prices.
          </div>
        ) : null}

        {rows.map((r, i) => (
          <div
            key={r.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "8px 0",
              borderTop: i === 0 ? `1px solid ${RULE}` : "none",
              borderBottom: `1px solid ${RULE}`,
            }}
          >
            <span
              style={{
                flex: "0 0 190px",
                fontSize: 12,
                color: INK,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {r.label}
              {r.detail ? <span style={{ color: MUTED }}> · {r.detail}</span> : null}
            </span>

            <div style={{ flex: "1 1 auto", height: 4, background: TRACK, borderRadius: 2, overflow: "hidden", position: "relative" }}>
              {/* After queued orders: a lighter band behind the current bar. */}
              {r.forwardUtil != null ? (
                <div style={{ position: "absolute", left: 0, top: 0, width: `${Math.max(Math.min(r.forwardUtil, 1) * 100, 1)}%`, height: "100%", background: r.colour, opacity: 0.3 }} />
              ) : null}
              <div style={{ position: "relative", width: `${Math.max(Math.min(r.utilisation, 1) * 100, 1)}%`, height: "100%", background: r.colour }} />
            </div>

            <span style={{ ...numeric, flex: "0 0 190px", textAlign: "right", fontSize: 11, color: r.breached ? BAD : MUTED, whiteSpace: "nowrap" }}>
              {r.value}
            </span>

            <span style={{ ...numeric, flex: "0 0 74px", textAlign: "right", fontSize: 11, color: r.colour }}>
              {r.status}
            </span>
          </div>
        ))}

        {data.hardRules.length > 0 ? (
          <div style={{ display: "flex", gap: 6, paddingTop: 12 }}>
            {data.hardRules.map((h) => (
              <span key={h.constraintType} style={{ fontSize: 10, color: MUTED, border: `1px solid ${RULE}`, padding: "2px 8px" }}>
                {h.label}
              </span>
            ))}
          </div>
        ) : null}

        {hasExempt ? (
          <div style={{ fontSize: 10, color: MUTED, paddingTop: 10 }}>
            Cash limits apply from {RAMP_UP_DAYS} days after inception.
          </div>
        ) : null}
      </div>
    </div>
  );
}
