"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  validateLimits,
  type LimitSetting,
  type LimitSpec,
} from "@/lib/limit-catalogue";

const C = {
  ink: "#00183A", muted: "#6B6B66", faint: "#9A9A8E", line: "#E5E5DE",
  row: "#F0EFEA", red: "#7A1F1F", green: "#2F5D45", amber: "#8A6D1F",
};

type Loaded = {
  fund: { slug: string; name: string };
  catalogue: LimitSpec[];
  settings: LimitSetting[];
  defaults: LimitSetting[];
  lastChange: { at: string; by: string | null; action: string } | null;
};

function show(spec: LimitSpec, s: LimitSetting): string {
  if (!s.enabled) return "off";
  if (spec.kind === "flag") return "on";
  const v = Number(s.value);
  const body = spec.kind === "percent" ? `${+(v * 100).toFixed(2)}%` : String(v);
  return `${body} (${s.isHard ? "hard" : "soft"})`;
}

/** Editable text per row, so a value can be typed freely before it parses. */
function toText(spec: LimitSpec, s: LimitSetting): string {
  if (spec.kind === "flag") return "";
  const v = Number(s.value);
  return spec.kind === "percent" ? String(+(v * 100).toFixed(4)) : String(v);
}

export default function LimitsEditor({ slug }: { slug: string }) {
  const router = useRouter();
  const [data, setData] = useState<Loaded | null>(null);
  const [edit, setEdit] = useState<LimitSetting[]>([]);
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/admin/funds/${slug}/limits`);
    const d = await res.json();
    if (!d.ok) return setServerErrors([d.error ?? "Could not load limits"]);
    setData(d);
    setEdit(d.settings);
    setText(Object.fromEntries(d.catalogue.map((spec: LimitSpec, i: number) => [spec.type, toText(spec, d.settings[i])])));
  }
  useEffect(() => { void load(); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const specOf = (type: string) => data!.catalogue.find((c) => c.type === type)!;

  function update(type: string, patch: Partial<LimitSetting>) {
    setSaved(null);
    setEdit((prev) => prev.map((s) => (s.type === type ? { ...s, ...patch } : s)));
  }
  function updateText(type: string, raw: string) {
    setText((t) => ({ ...t, [type]: raw }));
    const spec = specOf(type);
    const n = Number(raw);
    update(type, { value: raw.trim() === "" || !Number.isFinite(n) ? NaN : spec.kind === "percent" ? n / 100 : n });
  }

  const errors = useMemo(() => (edit.length ? validateLimits(edit) : []), [edit]);
  const changes = useMemo(() => {
    if (!data) return [];
    return data.catalogue
      .map((spec, i) => {
        const a = data.settings[i];
        const b = edit[i];
        if (!b) return null;
        const before = show(spec, a);
        const after = show(spec, b);
        return before === after ? null : { label: spec.label, before, after };
      })
      .filter(Boolean) as Array<{ label: string; before: string; after: string }>;
  }, [data, edit]);

  async function submit(reset: boolean) {
    if (reset) {
      if (!window.confirm(`Restore the default limits for ${data!.fund.name}? Current settings will be replaced.`)) return;
    } else {
      const lines = changes.map((c) => `${c.label}: ${c.before} → ${c.after}`).join("\n");
      if (!window.confirm(`Save these changes? They apply to the next trade.\n\n${lines}`)) return;
    }
    setBusy(true);
    setServerErrors([]);
    try {
      const res = await fetch(`/api/admin/funds/${slug}/limits`, {
        method: reset ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reset ? { action: "reset" } : { limits: edit }),
      });
      const d = await res.json();
      if (!d.ok) return setServerErrors(d.errors ?? [d.error ?? "Save failed"]);
      await load();
      setSaved(reset ? "Defaults restored." : "Saved.");
      router.refresh();
    } catch (e) {
      setServerErrors([e instanceof Error ? e.message : "Network error"]);
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: C.faint }}>{serverErrors[0] ?? "Loading…"}</div>;
  }

  const groups = ["Mandate", "Concentration", "Exposure", "Cash"] as const;
  const canSave = changes.length > 0 && errors.length === 0 && !busy;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      {groups.map((g) => (
        <div key={g} style={{ background: "white", border: `1px solid ${C.line}`, marginBottom: 14 }}>
          <div style={{ padding: "9px 16px", borderBottom: `1px solid ${C.line}`, fontSize: 10, letterSpacing: "0.07em", textTransform: "uppercase", color: C.faint }}>
            {g}
          </div>
          {data.catalogue.map((spec, i) => {
            if (spec.group !== g) return null;
            const s = edit[i];
            const d = data.defaults[i];
            const differs = show(spec, s) !== show(spec, d);
            return (
              <div key={spec.type} style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 16px", borderBottom: `1px solid ${C.row}`, opacity: s.enabled ? 1 : 0.6 }}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => update(spec.type, { enabled: e.target.checked })}
                  aria-label={`Enable ${spec.label}`}
                />
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.ink }}>{spec.label}</div>
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.45 }}>
                    {spec.description}
                    {differs ? <span style={{ color: C.faint }}> Default: {show(spec, d)}.</span> : null}
                  </div>
                </div>

                {spec.kind !== "flag" ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      value={text[spec.type] ?? ""}
                      onChange={(e) => updateText(spec.type, e.target.value)}
                      disabled={!s.enabled}
                      inputMode="decimal"
                      style={{ width: 76, padding: "5px 7px", border: `1px solid ${C.line}`, fontSize: 13, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    />
                    <span style={{ fontSize: 12, color: C.muted, width: 14 }}>{spec.kind === "percent" ? "%" : ""}</span>
                  </div>
                ) : (
                  <div style={{ width: 94 }} />
                )}

                <div style={{ display: "flex" }}>
                  {(["hard", "soft"] as const).map((h) => {
                    const on = (h === "hard") === s.isHard;
                    return (
                      <button
                        key={h}
                        disabled={!s.enabled}
                        onClick={() => update(spec.type, { isHard: h === "hard" })}
                        title={h === "hard" ? "Blocks the trade" : "Warns; a written justification lets it through"}
                        style={{
                          padding: "4px 10px", fontSize: 11, marginLeft: -1, cursor: s.enabled ? "pointer" : "default",
                          border: `1px solid ${C.line}`, background: on ? C.ink : "white", color: on ? "white" : C.muted,
                          textTransform: "capitalize",
                        }}
                      >
                        {h}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {[...errors, ...serverErrors].length ? (
        <div style={{ border: `1px solid #E0B8B8`, background: "#FBF3F3", padding: "10px 14px", marginBottom: 12 }}>
          {[...errors, ...serverErrors].map((e) => (
            <div key={e} style={{ fontSize: 12, color: C.red, lineHeight: 1.6 }}>{e}</div>
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={() => submit(false)}
          disabled={!canSave}
          style={{ padding: "8px 16px", border: "none", fontSize: 12.5, color: "white", background: canSave ? C.ink : "#C9C9C0", cursor: canSave ? "pointer" : "default" }}
        >
          {busy ? "Saving…" : changes.length ? `Save ${changes.length} change${changes.length === 1 ? "" : "s"}` : "No changes"}
        </button>
        <button
          onClick={() => submit(true)}
          disabled={busy}
          style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: C.muted, textDecoration: "underline", cursor: busy ? "default" : "pointer" }}
        >
          Reset to defaults
        </button>
        {saved ? <span style={{ fontSize: 12, color: C.green }}>{saved}</span> : null}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.faint }}>
          {data.lastChange
            ? `Last changed ${new Date(data.lastChange.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${data.lastChange.by ? ` by ${data.lastChange.by}` : ""}`
            : "Not changed since set up"}
        </span>
      </div>
    </div>
  );
}
