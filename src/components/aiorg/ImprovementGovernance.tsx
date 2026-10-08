"use client";

// Human governance for the self-improvement controller (owner/admin only). Sets the change budget (gate 4)
// and the autonomy switches (gate 7). All autonomy is OFF by default and only a human turns it on here — the
// agent can never enable its own autonomy or widen its own budget. Collapsed by default to stay out of the
// way; the controls themselves make the current posture obvious.

import { useCallback, useEffect, useState } from "react";
import { Loader2, SlidersHorizontal, ShieldCheck, Check } from "lucide-react";
import type { ChangeBudget } from "@/lib/ai/improvement/types";

interface Autonomy { autoMerge: boolean; autoDeploy: boolean; autoRollback: boolean }

const BUDGET_FIELDS: { key: keyof ChangeBudget; label: string }[] = [
  { key: "maxFiles", label: "Max files" },
  { key: "maxLines", label: "Max lines" },
  { key: "maxDirs", label: "Max directories" },
  { key: "maxCommands", label: "Max commands" },
  { key: "maxRetries", label: "Max self-repair retries" },
  { key: "maxWallClockMin", label: "Max minutes" },
];

const AUTONOMY_FIELDS: { key: keyof Autonomy; label: string; help: string }[] = [
  { key: "autoMerge", label: "Auto-merge", help: "Merge a PR automatically when all required checks are green (CI + code-owner review)." },
  { key: "autoDeploy", label: "Auto-deploy", help: "A merge deploys automatically (CI already runs the deploy on merge — this governs the controller)." },
  { key: "autoRollback", label: "Auto-rollback", help: "Roll back automatically when a post-deploy health check fails. Off = stop and ask you." },
];

export function ImprovementGovernance(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState<ChangeBudget | null>(null);
  const [autonomy, setAutonomy] = useState<Autonomy | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || budget) return;
    void fetch("/api/ai/improvement/config")
      .then((r) => r.json())
      .then((j) => { if (j.budget) setBudget(j.budget); if (j.autonomy) setAutonomy(j.autonomy); })
      .catch(() => setError("Could not load settings."));
  }, [open, budget]);

  const save = useCallback(async (next: { budget?: ChangeBudget; autonomy?: Autonomy }) => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const res = await fetch("/api/ai/improvement/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      if (res.ok) { const j = await res.json(); setBudget(j.budget); setAutonomy(j.autonomy); setSaved(true); setTimeout(() => setSaved(false), 1500); }
      else setError("Save failed.");
    } catch { setError("Could not reach the server."); } finally { setBusy(false); }
  }, []);

  return (
    <section className="surface border">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
        <SlidersHorizontal className="size-4 text-meta" /> Governance (budget & autonomy)
        <span className="ml-auto text-[11px] text-meta">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-3">
          {!budget || !autonomy ? (
            <p className="text-[12px] text-meta">{error ?? "Loading…"}</p>
          ) : (
            <>
              <div>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-meta"><ShieldCheck className="size-3.5" /> Autonomy — all off by default</h3>
                <div className="space-y-1.5">
                  {AUTONOMY_FIELDS.map((f) => (
                    <label key={f.key} className="flex cursor-pointer items-start gap-2.5 rounded border border-border px-2.5 py-1.5">
                      <input
                        type="checkbox"
                        checked={autonomy[f.key]}
                        disabled={busy}
                        onChange={(e) => save({ autonomy: { ...autonomy, [f.key]: e.target.checked } })}
                        className="mt-0.5 size-4 accent-[var(--gold)]"
                      />
                      <span className="min-w-0 text-[12px]">
                        <span className="font-medium text-foreground">{f.label}</span>
                        <span className="block text-[11px] text-meta">{f.help}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-meta">Change budget (per run)</h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {BUDGET_FIELDS.map((f) => (
                    <label key={f.key} className="text-[11px] text-meta">
                      {f.label}
                      <input
                        type="number"
                        min={1}
                        defaultValue={budget[f.key]}
                        disabled={busy}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v > 0 && v !== budget[f.key]) save({ budget: { ...budget, [f.key]: v } });
                        }}
                        className="mt-0.5 w-full rounded border border-border bg-[var(--panel)] px-2 py-1 text-[12.5px] text-foreground focus:border-foreground/30 focus:outline-none"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 text-[11.5px]">
                {busy && <span className="inline-flex items-center gap-1 text-meta"><Loader2 className="size-3.5 animate-spin" /> saving…</span>}
                {saved && <span className="inline-flex items-center gap-1 text-positive"><Check className="size-3.5" /> saved</span>}
                {error && <span className="text-critical">{error}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
