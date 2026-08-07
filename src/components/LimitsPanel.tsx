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
import type { BookLimitsResult } from "@/lib/book-limits";
import { RAMP_UP_DAYS, type LimitUtilisation } from "@/lib/constraints";

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
}

/**
 * A cash floor and a cash ceiling measure the same thing against two bounds.
 * Shown separately they printed the same percentage twice, and the floor drew a
 * bar reading "3% used" when the floor was in fact comfortably satisfied.
 */
function toRows(limits: LimitUtilisation[]): Row[] {
  const floor = limits.find((l) => l.constraintType === "min_cash_pct");
  const ceiling = limits.find((l) => l.constraintType === "max_cash_pct");
  const rows: Row[] = [];

  for (const l of limits) {
    if (l.constraintType === "min_cash_pct" && ceiling) continue;

    const isCashPair = l.constraintType === "max_cash_pct" && floor;
    const breached = isCashPair ? l.breached || floor!.breached : l.breached;
    const util = l.utilisation ?? 0;
    const colour = breached ? BAD : l.exempt ? MUTED : util >= WARN_AT ? WARN : OK;

    rows.push({
      key: l.constraintType,
      label: isCashPair ? "Cash" : l.label,
      detail: isCashPair ? undefined : l.detail,
      value: isCashPair
        ? `${fmt(l.current, true)} / ${fmt(floor!.limit, true)}–${fmt(l.limit, true)}`
        : `${fmt(l.current, l.isPct)} / ${fmt(l.limit, l.isPct)}`,
      status: breached ? "Breach" : l.exempt === "ramp-up" ? "N/A" : `${Math.round(util * 100)}%`,
      utilisation: util,
      colour,
      breached,
    });
  }

  return rows.sort((a, b) => b.utilisation - a.utilisation);
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
          </span>
        </div>

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

            <div style={{ flex: "1 1 auto", height: 4, background: TRACK, borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${Math.max(Math.min(r.utilisation, 1) * 100, 1)}%`, height: "100%", background: r.colour }} />
            </div>

            <span style={{ ...numeric, flex: "0 0 150px", textAlign: "right", fontSize: 11, color: r.breached ? BAD : MUTED, whiteSpace: "nowrap" }}>
              {r.value}
            </span>

            <span style={{ ...numeric, flex: "0 0 62px", textAlign: "right", fontSize: 11, color: r.colour }}>
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
            N/A — cash limits apply from {RAMP_UP_DAYS} days after inception.
          </div>
        ) : null}
      </div>
    </div>
  );
}
