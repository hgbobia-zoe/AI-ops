"use client";

// Improvement CANDIDATES (owner/admin). Surfaces what the self-audit detected — the app's own recurring
// failures and failed jobs — and lets a human open a SCOPED run with one click. Opening ships nothing (it
// files a human-supervised work item; the autonomy switches still gate merge/deploy). A candidate whose fix
// would touch the agent's own controls has no scope and cannot be opened here — it needs manual scoping.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Radar, RefreshCw, Plus, Check } from "lucide-react";
import type { CandidateView, SignalSeverity } from "@/lib/ai/improvement/signals";

const SEV_CLASS: Record<SignalSeverity, string> = {
  high: "text-critical border-critical/40",
  medium: "text-warning border-warning/40",
  low: "text-meta border-border",
};

export function ImprovementCandidates(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/ai/improvement/candidates");
      const j = await r.json();
      if (r.ok && Array.isArray(j.candidates)) setCandidates(j.candidates);
      else setError("Could not load candidates.");
    } catch { setError("Could not reach the server."); } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open && candidates === null) void load(); }, [open, candidates, load]);

  const openRun = useCallback(async (c: CandidateView) => {
    setOpeningKey(c.changeKey); setError(null);
    try {
      const res = await fetch("/api/ai/improvement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: c.changeKey,
          scope: { blade: c.blade, summary: c.summary, problem: c.problem, allowedPaths: c.allowedPaths, forbiddenPaths: [] },
        }),
      });
      if (res.ok) await load();
      else setError("Open failed — it may already be tracked.");
    } catch { setError("Could not reach the server."); } finally { setOpeningKey(null); }
  }, [load]);

  const count = candidates?.length ?? 0;

  return (
    <section className="surface border">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">
        <Radar className="size-4 text-meta" /> Improvement candidates
        {candidates !== null && <span className="rounded-full border border-border px-1.5 text-[11px] text-meta">{count}</span>}
        <span className="ml-auto text-[11px] text-meta">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-border p-3">
          <div className="flex items-center gap-2">
            <p className="text-[11.5px] text-meta">What the app noticed about itself. Opening a run files work for the responder; nothing ships.</p>
            <button onClick={() => void load()} disabled={loading} className="ml-auto inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-meta transition-colors hover:text-foreground">
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Rescan
            </button>
          </div>

          {error && <p className="text-[12px] text-critical">{error}</p>}
          {candidates === null ? (
            <p className="text-[12px] text-meta">{loading ? "Scanning…" : ""}</p>
          ) : count === 0 ? (
            <p className="text-[12px] text-meta">No candidates — nothing is failing. 🎉</p>
          ) : (
            <ul className="space-y-1.5">
              {candidates.map((c) => (
                <li key={c.changeKey} className="flex items-start gap-2.5 rounded border border-border px-2.5 py-2">
                  <span className={`mt-0.5 shrink-0 rounded border px-1.5 text-[10px] uppercase ${SEV_CLASS[c.severity]}`}>{c.severity}</span>
                  <span className="min-w-0 flex-1 text-[12px]">
                    <span className="block font-medium text-foreground">{c.summary}</span>
                    <span className="block text-[11px] text-meta">
                      {c.source === "audit_failure" ? "audit" : "job"} · {c.blade}
                      {c.allowedPaths.length > 0 && <> · scope: {c.allowedPaths.join(", ")}</>}
                      {c.allowedPaths.length === 0 && <> · needs manual scoping (fix would touch protected paths)</>}
                    </span>
                  </span>
                  <span className="mt-0.5 shrink-0">
                    {c.tracked ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-positive"><Check className="size-3.5" /> {c.tracked}</span>
                    ) : c.canOpen ? (
                      <button
                        onClick={() => void openRun(c)}
                        disabled={openingKey === c.changeKey}
                        className="inline-flex items-center gap-1 rounded border border-foreground px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground hover:text-background disabled:opacity-50"
                      >
                        {openingKey === c.changeKey ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Open run
                      </button>
                    ) : (
                      <span className="text-[11px] text-meta">needs scoping</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
