"use client";

// One improvement run, in full. Shows scope, budget use, the AI's plan, artifacts (branch/commit/PR),
// deployment + health, and the complete lifecycle timeline. Owner/admin get contextual controls that post
// to the controller (which still enforces every rule — the UI can't make an illegal move happen).

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, GitPullRequest, GitBranch, AlertTriangle, ShieldCheck, Activity } from "lucide-react";
import type { ImprovementRun, RunEvent, RunState } from "@/lib/ai/improvement/types";
import { STATE_META, TONE_CLASS } from "@/lib/ai/improvement/display";

function Bar({ used, max }: { used: number; max: number }): React.JSX.Element {
  const p = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const over = used > max;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-[var(--row-hover)]" aria-hidden>
        <span className={`block h-full ${over ? "bg-critical" : "bg-[var(--gold)]"}`} style={{ width: `${p}%` }} />
      </span>
      <span className={`tabular-nums text-[11px] ${over ? "text-critical" : "text-meta"}`}>{used}/{max}</span>
    </span>
  );
}

export function ImprovementRunDetail({ run, events, canManage }: { run: ImprovementRun; events: RunEvent[]; canManage: boolean }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = STATE_META[run.state];

  const post = useCallback(
    async (label: string, body: Record<string, unknown>) => {
      setBusy(label);
      setError(null);
      try {
        const res = await fetch(`/api/ai/improvement/${run.id}/report`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) router.refresh();
        else {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setError(j.error ? `Refused: ${j.error}` : "The controller refused that action.");
        }
      } catch {
        setError("Could not reach the server.");
      } finally {
        setBusy(null);
      }
    },
    [router, run.id],
  );

  const actions: { label: string; body: Record<string, unknown> }[] = [];
  if (canManage) {
    if (run.state === "human_review_required") {
      actions.push({ label: "Resume: investigate", body: { op: "advance", to: "investigating" as RunState } });
      actions.push({ label: "Resume: code", body: { op: "advance", to: "coding" as RunState } });
      actions.push({ label: "Mark rolled back", body: { op: "advance", to: "rolled_back" as RunState } });
    }
    if (["merged", "deploying", "deployed"].includes(run.state)) {
      actions.push({ label: "Verify deployment now", body: { op: "verify" } });
    }
    if (run.state === "ready_to_merge") {
      actions.push({ label: "Record merge", body: { op: "merge" } });
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <section className="surface border p-4">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TONE_CLASS[m.tone]}`}>{m.label}</span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-meta">{run.blade}</span>
          <span className="ml-auto font-mono text-[11px] text-meta">{run.id}</span>
        </div>
        <h1 className="mt-2 text-[18px] font-semibold tracking-tight">{run.scope.summary || "(no summary)"}</h1>
        {run.scope.problem && <p className="mt-1 text-[12.5px] text-secondary-text">{run.scope.problem}</p>}
        {run.error && (
          <p className="mt-2 flex items-start gap-1.5 border border-critical/40 bg-critical/[0.04] px-2.5 py-1.5 text-[12px] text-critical">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {run.error}
          </p>
        )}
        {actions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {actions.map((a) => (
              <button
                key={a.label}
                onClick={() => post(a.label, a.body)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50"
              >
                {busy === a.label ? <Loader2 className="size-3.5 animate-spin" /> : null} {a.label}
              </button>
            ))}
          </div>
        )}
        {error && <p className="mt-2 flex items-center gap-1 text-[12px] text-critical"><AlertTriangle className="size-3.5" /> {error}</p>}
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Scope + budget */}
        <section className="surface border p-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><ShieldCheck className="size-4 text-meta" /> Scope & budget</h2>
          <div className="space-y-1.5 text-[12px]">
            <div className="text-meta">Allowed paths</div>
            <ul className="space-y-0.5 font-mono text-[11.5px] text-secondary-text">{run.scope.allowedPaths.map((p) => <li key={p}>{p}</li>)}</ul>
            {run.scope.forbiddenPaths.length > 0 && (
              <>
                <div className="mt-2 text-meta">Forbidden paths</div>
                <ul className="space-y-0.5 font-mono text-[11.5px] text-critical">{run.scope.forbiddenPaths.map((p) => <li key={p}>{p}</li>)}</ul>
              </>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
            <span className="flex items-center justify-between gap-2">files <Bar used={run.metrics.files} max={run.budget.maxFiles} /></span>
            <span className="flex items-center justify-between gap-2">lines <Bar used={run.metrics.lines} max={run.budget.maxLines} /></span>
            <span className="flex items-center justify-between gap-2">dirs <Bar used={run.metrics.dirs} max={run.budget.maxDirs} /></span>
            <span className="flex items-center justify-between gap-2">retries <Bar used={run.metrics.retries} max={run.budget.maxRetries} /></span>
          </div>
        </section>

        {/* Artifacts + deploy/health */}
        <section className="surface border p-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><GitBranch className="size-4 text-meta" /> Change & deploy</h2>
          <dl className="space-y-1.5 text-[12px]">
            <Row k="Branch" v={run.branch ? <span className="font-mono text-[11.5px]">{run.branch}</span> : "—"} />
            <Row k="Commit" v={run.commit ? <span className="font-mono text-[11.5px]">{run.commit.slice(0, 10)}</span> : "—"} />
            <Row k="PR" v={run.prUrl ? <a href={run.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-positive hover:underline"><GitPullRequest className="size-3" /> #{run.prNumber ?? "?"}</a> : "—"} />
            <Row k="Deploy" v={run.deploy ? `${run.deploy.provider ?? "?"} · ${run.deploy.status ?? "?"}` : "—"} />
            <Row k="Health" v={run.health ? <span className={run.health.healthy ? "text-positive" : "text-critical"}>{run.health.healthy ? "healthy" : "unhealthy"} · {run.health.detail}</span> : "—"} />
          </dl>
          {run.plan && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-meta">Plan</div>
              <p className="whitespace-pre-wrap border-l-2 border-border pl-2 text-[12px] text-secondary-text">{run.plan}</p>
            </div>
          )}
        </section>
      </div>

      {/* Lifecycle timeline */}
      <section className="surface border p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><Activity className="size-4 text-meta" /> Lifecycle</h2>
        <ol className="space-y-2">
          {events.map((e) => {
            const em = STATE_META[e.to];
            return (
              <li key={e.id} className="flex items-start gap-2.5 text-[12px]">
                <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TONE_CLASS[em.tone]}`}>{em.label}</span>
                <div className="min-w-0 flex-1">
                  {e.note && <span className="text-secondary-text">{e.note}</span>}
                  <div className="text-[10.5px] text-meta">
                    {e.from ? `${e.from} → ${e.to}` : e.to} · {e.actor} · {new Date(e.ts).toLocaleString()}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-meta">{k}</dt>
      <dd className="min-w-0 truncate text-right text-foreground">{v}</dd>
    </div>
  );
}
