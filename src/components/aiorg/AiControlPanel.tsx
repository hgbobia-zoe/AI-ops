"use client";

// AI Control Plane — the management panel (owner/admin). Choose the active AIProvider adapter, connect /
// disconnect the Claude session bridge, and toggle per-blade AI (enabled + auto-propose). Writes go to the
// manage-gated /api/ai/* endpoints; no credentials are ever shown here. Nothing here lets AI execute —
// execution stays behind the approval + outbox + send-gate path regardless of these toggles.

import { useState, useCallback } from "react";
import { Loader2, Cpu, Plug, SlidersHorizontal } from "lucide-react";
import type { AiProviderMeta } from "@/lib/ai/provider";
import type { BladeAiConfig } from "@/lib/ai/bladeConfig";

export function AiControlPanel({
  initialProviders,
  initialBridgeConnected,
  initialInlineReady,
  initialBlades,
}: {
  initialProviders: AiProviderMeta[];
  initialBridgeConnected: boolean;
  initialInlineReady: boolean;
  initialBlades: Record<string, BladeAiConfig>;
}): React.JSX.Element {
  const [providers, setProviders] = useState(initialProviders);
  const [bridge, setBridge] = useState(initialBridgeConnected);
  const [inlineReady, setInlineReady] = useState(initialInlineReady);
  const [blades, setBlades] = useState(initialBlades);
  const [busy, setBusy] = useState<string | null>(null);

  const active = providers.find((p) => p.active);

  const pickProvider = useCallback(async (id: string) => {
    setBusy(`prov:${id}`);
    try {
      const r = await fetch("/api/ai/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (r.ok) {
        const j = (await r.json()) as { providers: AiProviderMeta[] };
        setProviders(j.providers);
        // Re-read inline readiness from the provider GET (cheap).
        const g = await fetch("/api/ai/provider", { cache: "no-store" });
        if (g.ok) setInlineReady(((await g.json()) as { inlineReady: boolean }).inlineReady);
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const toggleBridge = useCallback(async () => {
    setBusy("bridge");
    try {
      const r = await fetch("/api/ai/bridge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connected: !bridge }) });
      if (r.ok) setBridge(((await r.json()) as { connected: boolean }).connected);
    } finally {
      setBusy(null);
    }
  }, [bridge]);

  const patchBlade = useCallback(async (blade: string, patch: Partial<BladeAiConfig>) => {
    setBusy(`blade:${blade}`);
    try {
      const r = await fetch("/api/ai/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blade, ...patch }) });
      if (r.ok) {
        const j = (await r.json()) as { config: BladeAiConfig };
        setBlades((b) => ({ ...b, [blade]: j.config }));
      }
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Provider */}
      <section className="surface border p-4">
        <h2 className="mb-1 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><Cpu className="size-4" /> AI provider</h2>
        <p className="mb-3 text-[12px] text-meta">
          The one adapter the whole app talks to. Session Bridge hands work to a connected Claude session (no per-call cost); the LLM adapter calls out only when a key is set. No credentials are shown or stored here.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => pickProvider(p.id)}
              disabled={busy === `prov:${p.id}`}
              className={`flex flex-col items-start gap-1 rounded border p-3 text-left transition-colors disabled:opacity-50 ${
                p.active ? "border-positive/50 bg-positive/[0.04]" : "border-border hover:bg-white/5"
              }`}
            >
              <span className="flex w-full items-center gap-2 text-[13px] font-medium text-foreground">
                {p.name}
                {busy === `prov:${p.id}` && <Loader2 className="ml-auto size-3.5 animate-spin" />}
                {p.active && busy !== `prov:${p.id}` && <span className="ml-auto text-[10px] uppercase tracking-wide text-positive">active</span>}
              </span>
              <span className="text-[11px] text-meta">{p.mode === "inline" ? "Inline (returns an answer directly)" : "Deferred (a session answers)"}</span>
            </button>
          ))}
        </div>
        {active && (
          <p className="mt-2 text-[11px] text-meta">
            Active: <span className="text-tertiary-text">{active.name}</span>
            {active.mode === "inline" ? ` · ${inlineReady ? "keyed and ready" : "no key set (will skip to deterministic rules)"}` : " · interprets via a connected session"}
          </p>
        )}
      </section>

      {/* Session bridge */}
      <section className="surface border p-4">
        <h2 className="mb-1 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><Plug className="size-4" /> Claude session bridge</h2>
        <p className="mb-3 text-[12px] text-meta">
          Marks whether a Claude / Claude Code session is connected to interpret and post results back. This is a replaceable local seam, swapped for Remote Control later without touching the rest of the app.
        </p>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 text-[12.5px] ${bridge ? "text-positive" : "text-meta"}`}>
            <span className={`size-2 rounded-full ${bridge ? "bg-positive" : "bg-[var(--bar)]"}`} aria-hidden />
            {bridge ? "Connected" : "Not connected"}
          </span>
          <button
            onClick={toggleBridge}
            disabled={busy === "bridge"}
            className="ml-auto flex items-center gap-1.5 rounded border border-white/15 px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
          >
            {busy === "bridge" ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />} {bridge ? "Mark disconnected" : "Mark connected"}
          </button>
        </div>
      </section>

      {/* Per-blade config */}
      <section className="surface border p-4">
        <h2 className="mb-1 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><SlidersHorizontal className="size-4" /> Per-blade AI</h2>
        <p className="mb-3 text-[12px] text-meta">
          Whether AI surfaces on each blade, and whether its agents may auto-raise proposals (still human-decided). Auto-propose is off by default. These never grant execution.
        </p>
        <div className="overflow-x-auto border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-[11px] uppercase tracking-[0.06em] text-meta">
                <th className="px-3 py-2 font-medium">Blade</th>
                <th className="px-3 py-2 font-medium">AI enabled</th>
                <th className="px-3 py-2 font-medium">Auto-propose</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(blades).map(([blade, cfg]) => (
                <tr key={blade} className="border-b border-rule">
                  <td className="px-3 py-2 font-mono text-[12.5px] text-tertiary-text">{blade}</td>
                  <td className="px-3 py-2">
                    <Toggle on={cfg.enabled} busy={busy === `blade:${blade}`} onClick={() => patchBlade(blade, { enabled: !cfg.enabled })} />
                  </td>
                  <td className="px-3 py-2">
                    <Toggle on={cfg.autoPropose} busy={busy === `blade:${blade}`} disabled={!cfg.enabled} onClick={() => patchBlade(blade, { autoPropose: !cfg.autoPropose })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Toggle({ on, busy, disabled, onClick }: { on: boolean; busy?: boolean; disabled?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide transition-colors disabled:opacity-40 ${
        on ? "border-positive/40 text-positive" : "border-border text-meta hover:text-foreground"
      }`}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <span className={`size-1.5 rounded-full ${on ? "bg-positive" : "bg-[var(--bar)]"}`} aria-hidden />}
      {on ? "On" : "Off"}
    </button>
  );
}
