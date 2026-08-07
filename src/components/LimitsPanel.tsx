/**
 * Limits panel for the fund dashboard.
 *
 * Answers the question the rest of the dashboard doesn't: is this book on
 * mandate right now? `checkTrade` only speaks when a PM tries to trade, so
 * without this a fund can sit off-mandate indefinitely and only find out when a
 * trade is blocked.
 *
 * Bars show utilisation, not raw value, so the eye lands on the tight ones. A
 * breach clamps the bar at full rather than overflowing — the number carries the
 * magnitude; a bar three times its container just distorts the row.
 *
 * Server component — pure presentation of loadBookLimits() output.
 */

import { serif, numeric } from "@/lib/typography";
import type { BookLimitsResult } from "@/lib/book-limits";

/**
 * Amber from 80% of the limit. A convention rather than a standard — PMs learn
 * to read the colour, so it is deliberately one number in one place.
 */
const WARN_AT = 0.8;

const INK = "#00183A";
const MUTED = "#9A9A8E";
const LABEL = "#6B6B66";
const RULE = "#ECEBE4";
const TRACK = "#F1EFE8";
const OK = "#1F5C3A";
const WARN = "#8A6D1F";
const BAD = "#7A1F1F";

function fmt(v: number, isPct: boolean) {
  return isPct ? `${(v * 100).toFixed(1)}%` : String(Math.round(v));
}

export default function LimitsPanel({ data }: { data: BookLimitsResult }) {
  if (data.limits.length === 0 && data.hardRules.length === 0) return null;

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ ...serif, fontSize: 18, color: INK, margin: "0 0 10px" }}>Limits</h2>

      <div style={{ background: "white", border: `1px solid ${RULE}`, padding: "14px 18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: MUTED }}>
            Mandate
          </span>
          <span style={{ fontSize: 10, color: data.breachCount > 0 ? BAD : MUTED }}>
            {data.breachCount === 0
              ? "within limits"
              : `${data.breachCount} breach${data.breachCount === 1 ? "" : "es"}`}
          </span>
        </div>

        {data.limits.map((l, i) => {
          const util = l.utilisation ?? 0;
          const colour = l.breached ? BAD : util >= WARN_AT ? WARN : OK;
          const pctOfLimit = l.utilisation == null ? null : Math.round(l.utilisation * 100);

          return (
            <div
              key={l.constraintType}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "9px 0",
                borderBottom: i < data.limits.length - 1 ? `1px solid ${RULE}` : "none",
              }}
            >
              <span style={{ flex: "0 0 150px", fontSize: 13, color: INK }}>
                {l.label}
                {l.detail ? <span style={{ color: MUTED }}> · {l.detail}</span> : null}
              </span>

              <div style={{ flex: 1, height: 5, background: TRACK, minWidth: 40 }}>
                <div style={{ width: `${Math.max(util * 100, 1)}%`, height: "100%", background: colour }} />
              </div>

              <span style={{ ...numeric, flex: "0 0 110px", textAlign: "right", fontSize: 12, color: l.breached ? BAD : INK }}>
                {fmt(l.current, l.isPct)} / {fmt(l.limit, l.isPct)}
              </span>

              <span style={{ flex: "0 0 74px", textAlign: "right", fontSize: 10, color: l.breached ? BAD : l.exempt ? MUTED : colour }}>
                {l.breached ? "breach" : l.exempt === "ramp-up" ? "ramp-up" : pctOfLimit != null ? `${pctOfLimit}%` : ""}
              </span>
            </div>
          );
        })}

        {data.hardRules.length > 0 ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", paddingTop: 12 }}>
            {data.hardRules.map((r) => (
              <span
                key={r.constraintType}
                style={{ fontSize: 10, padding: "3px 9px", background: "#EEF3EF", color: OK }}
              >
                {r.label}
              </span>
            ))}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: MUTED }}>enforced at trade</span>
          </div>
        ) : null}

        {data.limits.some((l) => l.exempt === "ramp-up") ? (
          <div style={{ fontSize: 10, color: MUTED, marginTop: 10, lineHeight: 1.5 }}>
            Cash limits don&rsquo;t bind while the fund is still building its book. Concentration
            limits apply from day one.
          </div>
        ) : null}
      </div>
    </div>
  );
}
