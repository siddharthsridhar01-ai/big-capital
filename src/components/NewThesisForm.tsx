"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { serif, numeric } from "@/lib/typography";

interface UniverseEntry {
  securityId: string;
  ticker: string;
  name: string;
  exchange: string;
  currency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
  gicsSector: string | null;
}

interface Props {
  fundSlug: string;
  fundBaseCurrency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
  universe: UniverseEntry[];
  /** Preselect this security (e.g. arriving from a trade's "New thesis" link). */
  initialSecurityId?: string;
  /** If set, auto-link this trade to the thesis once it's created. */
  linkTxId?: string;
}

type Conviction = "high" | "medium" | "low";
type HoldingPeriod = "short" | "medium" | "long" | "indefinite";

const PERIOD_LABELS: Record<HoldingPeriod, string> = {
  short: "Short (< 3 months)",
  medium: "Medium (3-12 months)",
  long: "Long (1-3 years)",
  indefinite: "Indefinite",
};

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#6B6B66",
  fontWeight: 500,
  marginBottom: 10,
};

const LABEL: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  fontSize: 12,
  color: "#0A0A0A",
  marginBottom: 6,
  fontWeight: 500,
  display: "block",
};

const INPUT: React.CSSProperties = {
  width: "100%",
  border: "1px solid #D9D9D2",
  borderRadius: 3,
  padding: "8px 11px",
  fontSize: 13,
  outline: "none",
  fontFamily: "system-ui, sans-serif",
  color: "#0A0A0A",
  background: "white",
  boxSizing: "border-box",
};

export default function NewThesisForm({
  fundSlug,
  fundBaseCurrency,
  universe,
  initialSecurityId,
  linkTxId,
}: Props) {
  const router = useRouter();

  const [securityId, setSecurityId] = useState(initialSecurityId ?? "");
  const [securityFilter, setSecurityFilter] = useState("");
  const [conviction, setConviction] = useState<Conviction>("medium");
  const [holdingPeriod, setHoldingPeriod] = useState<HoldingPeriod>("medium");
  const [summary, setSummary] = useState("");
  const [targetWeightPct, setTargetWeightPct] = useState(""); // user enters as %, e.g. "5"
  const [targetPriceNative, setTargetPriceNative] = useState("");
  const [memoFile, setMemoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtered list of universe entries based on search box
  const filteredUniverse = useMemo(() => {
    const q = securityFilter.trim().toLowerCase();
    const base = !q
      ? universe
      : universe.filter(
          (u) =>
            u.ticker.toLowerCase().includes(q) ||
            u.name.toLowerCase().includes(q) ||
            (u.gicsSector?.toLowerCase().includes(q) ?? false)
        );
    // Keep the currently-selected security pinned at the top so it's always
    // visible (e.g. when preselected from a trade's "New thesis" link, or after
    // clicking a name further down the list).
    let list = base;
    if (securityId) {
      const sel = universe.find((u) => u.securityId === securityId);
      if (sel) list = [sel, ...base.filter((u) => u.securityId !== securityId)];
    }
    return list.slice(0, 50);
  }, [universe, securityFilter, securityId]);

  const selectedSecurity = useMemo(
    () => universe.find((u) => u.securityId === securityId) ?? null,
    [universe, securityId]
  );
  const currencySymbol =
    selectedSecurity?.currency === "GBP"
      ? "£"
      : selectedSecurity?.currency === "EUR"
        ? "€"
        : "$";

  const summaryLen = summary.trim().length;
  const summaryValid = summaryLen > 0 && summaryLen <= 500;

  const canSubmit =
    !!securityId &&
    !!conviction &&
    !!holdingPeriod &&
    summaryValid &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const form = new FormData();
    form.append("securityId", securityId);
    form.append("conviction", conviction);
    form.append("holdingPeriod", holdingPeriod);
    form.append("summary", summary.trim());
    if (targetWeightPct) {
      // User input is "5" for 5% — convert to 0.05 for storage
      const n = Number(targetWeightPct);
      if (Number.isFinite(n)) form.append("targetWeightPct", String(n / 100));
    }
    if (targetPriceNative) {
      form.append("targetPriceNative", targetPriceNative);
    }
    if (memoFile) {
      form.append("memo", memoFile);
    }

    try {
      const res = await fetch(`/api/funds/${fundSlug}/theses`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }

      // If we arrived from a specific trade's "New thesis" link, attach the
      // freshly-created thesis to that trade automatically, so the user doesn't
      // have to link it by hand. Best-effort: if it fails, the thesis is still
      // created and can be linked manually from the activity feed.
      if (linkTxId && data.thesisId) {
        try {
          await fetch(`/api/funds/${fundSlug}/transactions/${linkTxId}/thesis`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ thesisId: data.thesisId }),
          });
        } catch {
          // ignore — thesis exists; linking can be redone from the feed
        }
        // Return to the fund page so the now-linked trade is visible.
        router.push(`/dashboard/funds/${fundSlug}`);
        router.refresh();
        return;
      }

      // Otherwise, go to the thesis list as before.
      router.push(`/dashboard/funds/${fundSlug}/theses`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        background: "white",
        border: "1px solid #D9D9D2",
        padding: "24px 28px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {/* SECURITY */}
      <div style={{ marginBottom: 28 }}>
        <div style={SECTION_HEADER}>Security</div>
        <input
          type="text"
          value={securityFilter}
          onChange={(e) => setSecurityFilter(e.target.value)}
          placeholder="Filter by ticker, name, or sector…"
          style={{ ...INPUT, marginBottom: 8 }}
        />
        <div
          style={{
            maxHeight: 260,
            overflowY: "auto",
            border: "1px solid #E5E5DE",
            background: "#FAFAF7",
          }}
        >
          {filteredUniverse.length === 0 ? (
            <div
              style={{
                padding: "16px 14px",
                color: "#9A9A8E",
                fontSize: 12,
                textAlign: "center",
              }}
            >
              {universe.length === 0
                ? "Universe is empty"
                : "No matches"}
            </div>
          ) : (
            filteredUniverse.map((u) => {
              const isSelected = u.securityId === securityId;
              return (
                <div
                  key={u.securityId}
                  onClick={() => setSecurityId(u.securityId)}
                  style={{
                    padding: "9px 14px",
                    borderBottom: "1px solid #F0EFEA",
                    background: isSelected ? "#E8E4D4" : "transparent",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div style={{ flex: "0 0 70px" }}>
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#00183A",
                      }}
                    >
                      {u.ticker}
                    </span>
                    <div style={{ fontSize: 10, color: "#6B6B66" }}>
                      {u.exchange}
                    </div>
                  </div>
                  <div style={{ flex: 1, fontSize: 12, color: "#0A0A0A" }}>
                    {u.name}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#6B6B66",
                      flex: "0 0 auto",
                    }}
                  >
                    {u.gicsSector ?? "—"}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* CONVICTION */}
      <div style={{ marginBottom: 28 }}>
        <div style={SECTION_HEADER}>Conviction</div>
        <div style={{ display: "flex", gap: 0 }}>
          {(["high", "medium", "low"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setConviction(c)}
              type="button"
              style={{
                flex: 1,
                padding: "10px 16px",
                border: "1px solid #D9D9D2",
                background: conviction === c ? "#00183A" : "white",
                color: conviction === c ? "white" : "#6B6B66",
                fontFamily: "system-ui, sans-serif",
                fontSize: 12,
                fontWeight: conviction === c ? 600 : 400,
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {c}
            </button>
          ))}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#6B6B66",
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          How strongly do you believe this thesis will play out?
        </div>
      </div>

      {/* HOLDING PERIOD */}
      <div style={{ marginBottom: 28 }}>
        <div style={SECTION_HEADER}>Holding period</div>
        <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
          {(["short", "medium", "long", "indefinite"] as HoldingPeriod[]).map(
            (p) => (
              <button
                key={p}
                onClick={() => setHoldingPeriod(p)}
                type="button"
                style={{
                  flex: 1,
                  minWidth: 140,
                  padding: "10px 12px",
                  border: "1px solid #D9D9D2",
                  background: holdingPeriod === p ? "#00183A" : "white",
                  color: holdingPeriod === p ? "white" : "#6B6B66",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 11,
                  fontWeight: holdingPeriod === p ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                {PERIOD_LABELS[p]}
              </button>
            )
          )}
        </div>
      </div>

      {/* TARGETS (optional) */}
      <div style={{ marginBottom: 28 }}>
        <div style={SECTION_HEADER}>Targets (optional)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={LABEL}>Target weight (%)</label>
            <input
              type="number"
              value={targetWeightPct}
              onChange={(e) => setTargetWeightPct(e.target.value)}
              step="0.1"
              min="0"
              max="50"
              placeholder="e.g. 5"
              style={{ ...INPUT, ...numeric }}
            />
            <div
              style={{
                fontSize: 10,
                color: "#9A9A8E",
                marginTop: 4,
              }}
            >
              Intended position size as % of NAV
            </div>
          </div>
          <div>
            <label style={LABEL}>Target price ({currencySymbol})</label>
            <input
              type="number"
              value={targetPriceNative}
              onChange={(e) => setTargetPriceNative(e.target.value)}
              step="0.01"
              min="0"
              placeholder={selectedSecurity ? "e.g. 150.00" : "Select a security first"}
              disabled={!selectedSecurity}
              style={{ ...INPUT, ...numeric }}
            />
            <div
              style={{
                fontSize: 10,
                color: "#9A9A8E",
                marginTop: 4,
              }}
            >
              Where you expect the stock to trade
            </div>
          </div>
        </div>
      </div>

      {/* SUMMARY */}
      <div style={{ marginBottom: 28 }}>
        <div style={SECTION_HEADER}>
          Summary{" "}
          <span
            style={{
              textTransform: "none",
              letterSpacing: 0,
              color: summaryValid
                ? "#1F5C3A"
                : summaryLen > 0
                  ? "#7A1F1F"
                  : "#9A9A8E",
              fontWeight: 400,
              marginLeft: 4,
            }}
          >
            ({summaryLen}/500)
          </span>
        </div>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={4}
          placeholder="A 1-2 sentence summary of the thesis. What you believe, why now, what could prove it wrong."
          style={{
            ...INPUT,
            resize: "vertical",
            lineHeight: 1.5,
            wordBreak: "break-word",
            overflowWrap: "break-word",
          }}
        />
      </div>

      {/* MEMO PDF (optional) */}
      <div style={{ marginBottom: 28 }}>
        <div style={SECTION_HEADER}>Memo PDF (optional)</div>
        <div
          style={{
            border: "1px dashed #D9D9D2",
            padding: "16px",
            background: "#FAFAF7",
            textAlign: "center",
            color: "#6B6B66",
            fontSize: 12,
          }}
        >
          {memoFile ? (
            <div>
              <div
                style={{
                  fontSize: 13,
                  color: "#00183A",
                  fontWeight: 500,
                  marginBottom: 4,
                }}
              >
                {memoFile.name}
              </div>
              <div style={{ fontSize: 11, color: "#6B6B66" }}>
                {(memoFile.size / 1024).toFixed(0)} KB
              </div>
              <button
                type="button"
                onClick={() => setMemoFile(null)}
                style={{
                  marginTop: 8,
                  background: "none",
                  border: "none",
                  color: "#7A1F1F",
                  cursor: "pointer",
                  fontSize: 11,
                  fontFamily: "system-ui, sans-serif",
                  textDecoration: "underline",
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <label style={{ cursor: "pointer" }}>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setMemoFile(f);
                }}
                style={{ display: "none" }}
              />
              <div>
                <div style={{ marginBottom: 4 }}>
                  Drop a PDF here, or{" "}
                  <span
                    style={{
                      color: "#00183A",
                      textDecoration: "underline",
                    }}
                  >
                    browse
                  </span>
                </div>
                <div style={{ fontSize: 11 }}>PDF only · max 10 MB</div>
              </div>
            </label>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#9A9A8E",
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          Long-form memo — full thesis write-up, scenarios, financials. The
          summary above is what surfaces in lists; the PDF is for the deep
          dive.
        </div>
      </div>

      {/* ERROR */}
      {error ? (
        <div
          style={{
            background: "#F8E8E8",
            border: "1px solid #DBB2B2",
            padding: "12px 14px",
            marginBottom: 16,
            color: "#7A1F1F",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* SUBMIT */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          marginTop: 16,
        }}
      >
        <button
          type="button"
          onClick={() => router.push(`/dashboard/funds/${fundSlug}/theses`)}
          style={{
            padding: "10px 18px",
            background: "white",
            border: "1px solid #D9D9D2",
            color: "#6B6B66",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            padding: "10px 22px",
            background: canSubmit ? "#00183A" : "#9A9A8E",
            border: "1px solid",
            borderColor: canSubmit ? "#00183A" : "#9A9A8E",
            color: "white",
            cursor: canSubmit ? "pointer" : "not-allowed",
            fontSize: 13,
            fontFamily: "system-ui, sans-serif",
            fontWeight: 500,
          }}
        >
          {submitting ? "Saving…" : "Create thesis"}
        </button>
      </div>
    </div>
  );
}
