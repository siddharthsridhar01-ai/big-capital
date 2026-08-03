"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { numeric } from "@/lib/typography";

export interface PendingOrderRow {
  id: string;
  ticker: string;
  securityName: string;
  side: string;
  quantity: string;
  submittedAt: string;
  rationale: string;
}

/**
 * Queued market-on-open orders. These were submitted while the security's
 * market was shut and will execute at that market's next opening price.
 * Cancellation is only permitted while the market is still closed (the API
 * enforces this) — otherwise someone could watch the open and back out.
 */
export default function PendingOrdersPanel({
  fundSlug,
  orders,
  canManage,
}: {
  fundSlug: string;
  orders: PendingOrderRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (orders.length === 0) return null;

  const cancel = async (id: string, ticker: string) => {
    if (!confirm(`Cancel the queued order for ${ticker}?`)) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/funds/${fundSlug}/pending-orders/${id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Couldn't cancel that order.");
      } else {
        router.refresh();
      }
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section style={{ marginTop: 28 }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#6B6B66",
          fontWeight: 500,
          marginBottom: 8,
        }}
      >
        Queued orders · fill at next open
      </div>
      <div style={{ border: "1px solid #E5E5DE", background: "white" }}>
        {orders.map((o, i) => (
          <div
            key={o.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "11px 16px",
              borderBottom: i < orders.length - 1 ? "1px solid #F0F0EC" : "none",
              fontFamily: "system-ui, sans-serif",
              fontSize: 12.5,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ color: "#00183A", fontWeight: 600 }}>
                {o.side.toUpperCase()} {o.quantity} · {o.ticker}
              </div>
              <div style={{ color: "#9A9A8E", fontSize: 11, marginTop: 2 }}>
                {o.securityName} · queued{" "}
                {new Date(o.submittedAt).toLocaleString("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
            <div
              style={{
                ...numeric,
                fontSize: 11,
                color: "#8A6D1F",
                whiteSpace: "nowrap",
              }}
            >
              awaiting open
            </div>
            {canManage && (
              <button
                onClick={() => cancel(o.id, o.ticker)}
                disabled={busyId === o.id}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#7A1F1F",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 12,
                  cursor: busyId === o.id ? "wait" : "pointer",
                  padding: 0,
                }}
              >
                {busyId === o.id ? "…" : "Cancel"}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && (
        <div
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#7A1F1F",
            marginTop: 6,
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          color: "#9A9A8E",
          marginTop: 6,
        }}
      >
        These execute at the exchange&apos;s next opening price. They can only be
        cancelled while that market is closed.
      </div>
    </section>
  );
}
