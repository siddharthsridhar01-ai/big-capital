"use client";
import { serif as serif_, numeric } from "@/lib/typography";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";

interface SearchResult {
  id: string;
  ticker: string;
  exchange: string;
  name: string;
  currency: "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR";
  gicsSector: string | null;
  gicsIndustry: string | null;
  latestPrice: string | null;
  latestPriceDate: string | null;
  livePrice: number | null;
  changePct: number | null;
  marketState: string | null;
}

export default function SearchModal() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  // Determine fund scope from URL: /dashboard/funds/[slug] → scope to that slug
  const fundSlugMatch = pathname?.match(/^\/dashboard\/funds\/([^/]+)/);
  const fundSlug = fundSlugMatch?.[1] ?? null;

  // Toggle modal with Cmd/Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      // Defer focus to next tick so the input is mounted
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
      setResults([]);
      setHighlightedIndex(0);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    if (query.trim().length === 0) {
      setResults([]);
      return;
    }
    debounceTimer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query.trim() });
        if (fundSlug) params.set("fund", fundSlug);
        const res = await fetch(`/api/search/securities?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setResults(data.results ?? []);
          setHighlightedIndex(0);
        }
      } finally {
        setLoading(false);
      }
    }, 150);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, fundSlug]);

  const navigateToResult = useCallback(
    (result: SearchResult) => {
      // URL-safe encoding: replace spaces in exchange name with underscores
      const safeExchange = result.exchange.replace(/ /g, "_");
      const target = fundSlug
        ? `/dashboard/funds/${fundSlug}/securities/${result.ticker}-${safeExchange}`
        : `/dashboard/securities/${result.ticker}-${safeExchange}`;
      setOpen(false);
      router.push(target);
    },
    [fundSlug, router]
  );

  // Arrow keys + Enter
  const handleInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[highlightedIndex]) {
      e.preventDefault();
      navigateToResult(results[highlightedIndex]);
    }
  };

  const currencySymbol = (c: string) =>
    c === "GBP" ? "£" : c === "EUR" ? "€" : "$";

  const fmt = (n: string) => {
    const num = Number(n);
    return new Intl.NumberFormat("en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  };

  return (
    <>
      {/* Search-trigger button in header — shows the modal on click */}
      <button
        onClick={() => setOpen(true)}
        suppressHydrationWarning
        style={{
          background: "white",
          border: "1px solid #D9D9D2",
          borderRadius: 4,
          padding: "5px 10px 5px 12px",
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          color: "#6B6B66",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 12,
          minWidth: 220,
        }}
        aria-label="Search securities"
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.3-4.3"></path>
          </svg>
          Search securities…
        </span>
        <span
          style={{
            marginLeft: "auto",
            background: "#F0EFEA",
            color: "#6B6B66",
            border: "1px solid #E0DFD8",
            borderRadius: 3,
            padding: "1px 6px",
            fontSize: 10,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          ⌘K
        </span>
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,24,58,0.32)",
            zIndex: 1000,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "10vh",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(640px, 92vw)",
              background: "#FAFAF7",
              borderRadius: 6,
              border: "1px solid #C8C8C0",
              boxShadow: "0 18px 50px rgba(0,24,58,0.22)",
              overflow: "hidden",
              fontFamily: "system-ui, sans-serif",
            }}
          >
            <div
              style={{
                borderBottom: "1px solid #D9D9D2",
                background: "white",
                padding: "14px 16px",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6B6B66"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8"></circle>
                <path d="m21 21-4.3-4.3"></path>
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleInputKey}
                placeholder={
                  fundSlug
                    ? "Search this fund's universe — ticker, name, or ISIN"
                    : "Search securities — ticker, name, or ISIN"
                }
                style={{
                  flex: 1,
                  border: "none",
                  outline: "none",
                  fontSize: 15,
                  fontFamily: "system-ui, sans-serif",
                  color: "#0A0A0A",
                  background: "transparent",
                }}
              />
              {fundSlug && (
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "#6B6B66",
                    background: "rgba(0,24,58,0.06)",
                    padding: "2px 8px",
                    borderRadius: 3,
                    fontWeight: 500,
                  }}
                >
                  {fundSlug}
                </span>
              )}
            </div>

            <div
              style={{
                maxHeight: 380,
                overflowY: "auto",
                background: "#FAFAF7",
              }}
            >
              {loading && query.length > 0 && results.length === 0 && (
                <div
                  style={{
                    padding: "32px 16px",
                    textAlign: "center",
                    color: "#6B6B66",
                    fontSize: 13,
                  }}
                >
                  Searching…
                </div>
              )}
              {!loading && query.length > 0 && results.length === 0 && (
                <div
                  style={{
                    padding: "32px 16px",
                    textAlign: "center",
                    color: "#6B6B66",
                    fontSize: 13,
                  }}
                >
                  No matches{fundSlug && ` in ${fundSlug}'s universe`}
                </div>
              )}
              {query.length === 0 && (
                <div
                  style={{
                    padding: "20px 16px",
                    color: "#6B6B66",
                    fontSize: 12,
                    lineHeight: 1.55,
                  }}
                >
                  Start typing to search by ticker (AAPL), company name
                  (Apple), or ISIN. Use arrow keys to navigate, Enter to
                  select.
                </div>
              )}
              {results.map((r, idx) => (
                <button
                  key={r.id}
                  onClick={() => navigateToResult(r)}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    width: "100%",
                    background:
                      idx === highlightedIndex ? "white" : "transparent",
                    border: "none",
                    borderLeft:
                      idx === highlightedIndex
                        ? "3px solid #00183A"
                        : "3px solid transparent",
                    padding: "12px 16px 12px 13px",
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: "system-ui, sans-serif",
                    transition: "background 0.05s",
                  }}
                >
                  <div style={{ flex: "0 0 92px" }}>
                    <div
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 13,
                        color: "#00183A",
                        fontWeight: 600,
                      }}
                    >
                      {r.ticker}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "#6B6B66",
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        marginTop: 1,
                      }}
                    >
                      {r.exchange}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: "#0A0A0A",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {r.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#6B6B66",
                        marginTop: 2,
                      }}
                    >
                      {r.gicsSector ?? "—"}
                    </div>
                  </div>
                  <div style={{ flex: "0 0 110px", textAlign: "right" }}>
                    {r.livePrice != null ? (
                      <>
                        <div
                          style={{
                            ...numeric,
                            fontSize: 14,
                            color: "#00183A",
                          }}
                        >
                          {currencySymbol(r.currency)}
                          {r.livePrice.toFixed(2)}
                        </div>
                        {r.changePct != null ? (
                          <div
                            style={{
                              ...numeric,
                              fontSize: 10,
                              marginTop: 1,
                              color:
                                r.changePct > 0
                                  ? "#1F5C3A"
                                  : r.changePct < 0
                                    ? "#7A1F1F"
                                    : "#6B6B66",
                            }}
                          >
                            {r.changePct > 0 ? "▲" : r.changePct < 0 ? "▼" : "·"}{" "}
                            {(Math.abs(r.changePct) * 100).toFixed(2)}%
                          </div>
                        ) : (
                          <div
                            style={{
                              fontSize: 10,
                              color: "#6B6B66",
                              marginTop: 1,
                            }}
                          >
                            Live
                          </div>
                        )}
                      </>
                    ) : r.latestPrice ? (
                      <>
                        <div
                          style={{
                            ...numeric,
                            fontSize: 14,
                            color: "#00183A",
                          }}
                        >
                          {currencySymbol(r.currency)}
                          {fmt(r.latestPrice)}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: "#6B6B66",
                            marginTop: 1,
                          }}
                        >
                          Close · {r.latestPriceDate}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: "#9A9A8E" }}>
                        no price
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
            <div
              style={{
                borderTop: "1px solid #D9D9D2",
                background: "white",
                padding: "8px 16px",
                fontSize: 10,
                color: "#9A9A8E",
                display: "flex",
                gap: 18,
              }}
            >
              <span>
                <kbd style={kbdStyle}>↑</kbd>
                <kbd style={kbdStyle}>↓</kbd> navigate
              </span>
              <span>
                <kbd style={kbdStyle}>↵</kbd> select
              </span>
              <span>
                <kbd style={kbdStyle}>esc</kbd> close
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const kbdStyle: React.CSSProperties = {
  background: "#F0EFEA",
  border: "1px solid #E0DFD8",
  borderRadius: 2,
  padding: "0 4px",
  fontSize: 10,
  fontFamily: "ui-monospace, monospace",
  color: "#6B6B66",
  marginRight: 4,
};
