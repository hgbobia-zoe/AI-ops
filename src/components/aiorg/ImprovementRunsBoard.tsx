"use client";

// AI Command Center → Improvements. The operator's view of every self-improvement run: its state, the blade
// it targets, how much of its change budget it has used, and its PR. One click into a run shows the full
// lifecycle. Non-technical-friendly: plain state chips grouped by what needs attention.

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, GitPullRequest, ShieldAlert, Activity, CheckCircle2, XCircle } from "lucide-react";
import type { ImprovementRun } from "@/lib/ai/improvement/types";
import { STATE_META, TONE_CLASS, type RunGroup } from "@/lib/ai/improvement/display";

const GROUPS: { key: RunGroup | "all"; label: string; icon: typeof Activity }[] = [
  { key: "all", label: "All", icon: Activity },
  { key: "active", label: "In progress", icon: Activity },
  { key: "needs_human", label: "Needs you", icon: ShieldAlert },
  { key: "success", label: "Verified", icon: CheckCircle2 },
  { key: "failed", label: "Failed", icon: XCircle },
];

function pct(used: number, max: number): number {
  if (!max || max <= 0) return 0;
  return Math.min(100, Math.round((used / max) * 100));
}

export function ImprovementRunsBoard({ runs, counts }: { runs: ImprovementRun[]; counts: Record<string, number> }): React.JSX.Element {
  const [group, setGroup] = useState<RunGroup | "all">("all");

  const groupCounts = useMemo(() => {
    const c: Record<string, number> = { all: runs.length };
    for (const r of runs) {
      const g = STATE_META[r.state].group;
      c[g] = (c[g] ?? 0) + 1;
    }
    return c;
  }, [runs]);

  const visible = runs.filter((r) => group === "all" || STATE_META[r.state].group === group);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {GROUPS.map((g) => {
          const Icon = g.icon;
          const n = g.key === "all" ? runs.length : groupCounts[g.key] ?? 0;
          const active = group === g.key;
          return (
            <button
              key={g.key}
              onClick={() => setGroup(g.key)}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] transition-colors ${
                active ? "border border-[var(--gold)] bg-[var(--gold)]/15 text-[var(--gold)]" : "border border-border text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5" /> {g.label}
              <span className="tabular-nums text-[11px] opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <p className="border border-dashed border-border px-3 py-8 text-center text-[12.5px] text-meta">
          No improvement runs here. A run starts when an accepted feature request is taken into implementation.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((r) => {
            const m = STATE_META[r.state];
            const filesPct = pct(r.metrics.files, r.budget.maxFiles);
            const linesPct = pct(r.metrics.lines, r.budget.maxLines);
            return (
              <li key={r.id} className="surface border p-3">
                <div className="flex items-start gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TONE_CLASS[m.tone]}`}>{m.label}</span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-meta">{r.blade}</span>
                      <Link href={`/ai-command/improvements/${r.id}`} className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11.5px] text-tertiary-text transition-colors hover:text-foreground">
                        Open <ArrowRight className="size-3" />
                      </Link>
                    </div>
                    <h3 className="mt-1 truncate text-[13.5px] font-medium text-foreground">{r.scope.summary || "(no summary)"}</h3>
                    {r.error && <p className="mt-0.5 line-clamp-1 text-[11.5px] text-critical">{r.error}</p>}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-meta">
                      <span className="inline-flex items-center gap-1.5">
                        budget
                        <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-[var(--row-hover)]" aria-hidden>
                          <span className="block h-full bg-[var(--gold)]" style={{ width: `${Math.max(filesPct, linesPct)}%` }} />
                        </span>
                        <span className="tabular-nums">{r.metrics.files}/{r.budget.maxFiles} files · {r.metrics.lines}/{r.budget.maxLines} lines</span>
                      </span>
                      {r.metrics.retries > 0 && <span>retries {r.metrics.retries}/{r.budget.maxRetries}</span>}
                      {r.prUrl && (
                        <a href={r.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-positive transition-colors hover:underline">
                          <GitPullRequest className="size-3" /> PR{r.prNumber ? ` #${r.prNumber}` : ""}
                        </a>
                      )}
                      {r.health && <span className={r.health.healthy ? "text-positive" : "text-critical"}>{r.health.healthy ? "healthy" : "unhealthy"}</span>}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
