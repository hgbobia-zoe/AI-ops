"use client";

// Operational-cycle editor for /admin. The operational cycle (anchor weekday + length in days) is how Zoe
// actually runs events across a calendar-week boundary (e.g. load Thu, events over the weekend, returns
// Mon-Tue) and is dimension B of Financial Intelligence. It was env/default-only; this is a plain UI over
// the existing saveOpsCycleConfig. Honest default is shown (Thu / 6). Mirrors the other /admin blocks:
// fetch GET on mount, POST on Save, owner/admin enforced server-side.

import { useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";

interface OpsCycle {
  anchorDow: number;
  lengthDays: number;
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function OpsCycleSettings(): React.JSX.Element {
  const [cfg, setCfg] = useState<OpsCycle | null>(null);
  const [def, setDef] = useState<OpsCycle | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/finance/ops-cycle")
      .then((r) => r.json())
      .then((d: { config: OpsCycle; default: OpsCycle }) => {
        setCfg(d.config);
        setDef(d.default);
      })
      .catch(() => setError("Could not load the operational cycle."));
  }, []);

  async function save(): Promise<void> {
    if (!cfg) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/finance/ops-cycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (!r.ok) {
        setError(r.status === 403 ? "You do not have permission to change this." : `Save failed (${r.status}).`);
        return;
      }
      const d = (await r.json()) as { config: OpsCycle };
      setCfg(d.config); // the clamped, stored truth
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch {
      setError("Save failed — network error.");
    } finally {
      setBusy(false);
    }
  }

  const end =
    cfg != null ? DOW[(cfg.anchorDow + Math.max(1, cfg.lengthDays) - 1) % 7] : null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The operational cycle is how a run of work is grouped on the Financial Intelligence blade — it can cross a
        calendar-week boundary (for example load on Thursday, events over the weekend, returns on Monday and Tuesday).
        Pick the day the cycle starts and how many days it runs.
        {def != null && (
          <>
            {" "}
            Default is <span className="font-medium text-foreground">{DOW[def.anchorDow]}</span> for{" "}
            <span className="font-medium text-foreground">{def.lengthDays} days</span>.
          </>
        )}
      </p>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-2.5 text-sm text-red-300">{error}</div>
      )}

      {cfg == null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Cycle starts on</label>
              <select
                value={cfg.anchorDow}
                onChange={(e) => setCfg({ ...cfg, anchorDow: Number(e.target.value) })}
                className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {DOW.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Length (days)</label>
              <input
                type="number"
                min={1}
                max={14}
                value={cfg.lengthDays}
                onChange={(e) => setCfg({ ...cfg, lengthDays: Number(e.target.value.replace(/\D/g, "")) || 1 })}
                className="w-full rounded-xl border border-white/10 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>

          {end != null && (
            <p className="text-xs text-muted-foreground">
              This cycle runs <span className="font-medium text-foreground">{DOW[cfg.anchorDow]}</span> through{" "}
              <span className="font-medium text-foreground">{end}</span> ({Math.max(1, Math.min(14, cfg.lengthDays))} days).
            </p>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="btn-hero inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : justSaved ? <Check className="size-4" /> : null}
            {justSaved ? "Saved" : "Save cycle"}
          </button>
        </>
      )}
    </div>
  );
}
