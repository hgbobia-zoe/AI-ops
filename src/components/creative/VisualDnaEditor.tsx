"use client";

// The Visual DNA editor + image-provider control. Lists edit as one-item-per-line; the five level dials are
// 0..100 sliders. The provider block selects the active model-agnostic image provider and stores its API key
// (write-only: the key value is never sent back, only whether it's set). Owner/admin only (page-gated too).

import { useState } from "react";
import { Loader2, Check, RotateCcw, Save, Cpu, KeyRound } from "lucide-react";
import {
  DNA_LISTS,
  DNA_LEVELS,
  type ZoeVisualDNA,
  type CreativeProviderStatus,
} from "@/lib/creative/types";

const inputCls = "w-full rounded border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30";
const toLines = (arr: string[]): string => arr.join("\n");
const fromLines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);

export function VisualDnaEditor({
  initialDna,
  initialProviders,
}: {
  initialDna: ZoeVisualDNA;
  initialProviders: CreativeProviderStatus[];
}): React.JSX.Element {
  const [dna, setDna] = useState<ZoeVisualDNA>(initialDna);
  const [providers, setProviders] = useState<CreativeProviderStatus[]>(initialProviders);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});

  function setList(key: keyof ZoeVisualDNA, value: string): void {
    setDna((d) => ({ ...d, [key]: fromLines(value) }));
  }
  function setLevel(key: keyof ZoeVisualDNA, value: number): void {
    setDna((d) => ({ ...d, [key]: value }));
  }

  async function save(reset = false): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/creative/visual-dna", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reset ? { reset: true } : { dna }),
      });
      const data = (await res.json()) as { ok?: boolean; dna?: ZoeVisualDNA; error?: string };
      if (!res.ok || !data.dna) {
        setError(data.error || "Save failed");
      } else {
        setDna(data.dna);
        setSavedAt(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
      }
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function selectProvider(id: string): Promise<void> {
    setError(null);
    try {
      const res = await fetch("/api/creative/provider", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ select: id }),
      });
      const data = (await res.json()) as { ok?: boolean; providers?: CreativeProviderStatus[]; error?: string };
      if (data.providers) setProviders(data.providers);
      if (!res.ok) setError(data.error || "Could not switch provider");
    } catch {
      setError("Could not switch provider");
    }
  }

  async function saveKey(providerId: string): Promise<void> {
    const apiKey = (keyDrafts[providerId] ?? "").trim();
    if (!apiKey) return;
    setError(null);
    try {
      const res = await fetch("/api/creative/provider", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId, apiKey }),
      });
      const data = (await res.json()) as { ok?: boolean; providers?: CreativeProviderStatus[]; error?: string };
      if (data.providers) setProviders(data.providers);
      if (!res.ok) setError(data.error || "Could not save key");
      else setKeyDrafts((k) => ({ ...k, [providerId]: "" }));
    } catch {
      setError("Could not save key");
    }
  }

  async function clearKey(providerId: string): Promise<void> {
    try {
      const res = await fetch("/api/creative/provider", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId, apiKey: "__clear__" }),
      });
      const data = (await res.json()) as { providers?: CreativeProviderStatus[] };
      if (data.providers) setProviders(data.providers);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-200">{error}</div>
      )}

      {/* Image provider (model-agnostic swap) */}
      <section className="rounded border border-border">
        <h2 className="flex items-center gap-2 border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">
          <Cpu className="size-3.5" /> Image provider (swappable)
        </h2>
        <div className="space-y-2 p-3">
          <p className="text-[12px] text-meta">The pipeline is model-agnostic. Pick the active provider; the mock provider needs no key and runs the full lifecycle with clearly-labelled placeholders.</p>
          {providers.map((p) => (
            <div key={p.id} className={`rounded border p-2.5 ${p.active ? "border-foreground/40 bg-foreground/[0.05]" : "border-border"}`}>
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[12.5px]">
                  <input type="radio" name="provider" checked={p.selected} onChange={() => selectProvider(p.id)} className="accent-white" />
                  <span className="font-medium text-foreground">{p.label}</span>
                  {p.active && <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200">Active</span>}
                  {p.selected && !p.active && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">Selected (needs key)</span>}
                </label>
                <span className="text-[11px] text-meta">{!p.requiresKey ? "no key needed" : p.keySet ? "key set" : "no key"}</span>
              </div>
              {p.requiresKey && (
                <div className="mt-2 flex items-center gap-1.5">
                  <KeyRound className="size-3.5 shrink-0 text-meta" />
                  <input
                    type="password"
                    className={inputCls}
                    placeholder={p.keySet ? "Key stored — enter to replace" : "Paste API key (write-only)"}
                    value={keyDrafts[p.id] ?? ""}
                    onChange={(e) => setKeyDrafts((k) => ({ ...k, [p.id]: e.target.value }))}
                  />
                  <button onClick={() => saveKey(p.id)} className="shrink-0 rounded border border-border px-2 py-1.5 text-[11.5px] text-foreground transition-colors hover:bg-[var(--row-hover)]">Save</button>
                  {p.keySet && <button onClick={() => clearKey(p.id)} className="shrink-0 rounded border border-border px-2 py-1.5 text-[11.5px] text-meta transition-colors hover:bg-[var(--row-hover)]">Clear</button>}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Level dials */}
      <section className="rounded border border-border">
        <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Dials</h2>
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
          {DNA_LEVELS.map((lv) => {
            const val = dna[lv.key] as number;
            return (
              <label key={lv.key} className="block">
                <span className="mb-1 flex items-center justify-between text-[12px]">
                  <span className="text-tertiary-text">{lv.label}</span>
                  <span className="tabular-nums text-meta">{val}</span>
                </span>
                <input type="range" min={0} max={100} value={val} onChange={(e) => setLevel(lv.key, Number(e.target.value))} className="w-full accent-white" />
              </label>
            );
          })}
        </div>
      </section>

      {/* Lists */}
      <section className="rounded border border-border">
        <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Direction (one per line)</h2>
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
          {DNA_LISTS.map((l) => (
            <label key={l.key} className="block">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.06em] text-meta">{l.label}</span>
              <textarea
                className={`${inputCls} min-h-[92px] resize-y font-mono text-[11.5px] leading-relaxed`}
                value={toLines(dna[l.key] as string[])}
                onChange={(e) => setList(l.key, e.target.value)}
              />
              <span className="mt-1 block text-[10.5px] text-meta">{l.help}</span>
            </label>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-2">
        <button onClick={() => save(false)} disabled={saving} className="inline-flex items-center gap-2 rounded border border-foreground/30 bg-foreground/10 px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/15 disabled:opacity-60">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save Visual DNA
        </button>
        <button onClick={() => save(true)} disabled={saving} className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] disabled:opacity-60">
          <RotateCcw className="size-3.5" /> Reset to default
        </button>
        {savedAt && <span className="inline-flex items-center gap-1 text-[11.5px] text-emerald-300"><Check className="size-3.5" /> Saved {savedAt}</span>}
      </div>
    </div>
  );
}
