"use client";

// Gusto Console — the in-app "remote browser" push. For a payroll person with NO browser extension: click
// Push and watch the office-machine Gusto browser do the DRAFT write, live. The button builds the payload
// server-side (owner/admin, same builder as the extension), records a job, and the office runner (tools/
// gusto-runner) executes it and streams a live screenshot + per-worker results back here. DRAFT-ONLY — it
// never submits payroll. HONEST: status comes only from the runner's reports (the job), never assumed.
//
// Shown only when the runner is configured (GUSTO_RUNNER_TOKEN set); otherwise a short "not set up" note, so
// nothing here implies a capability the deployment doesn't have.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Monitor, Upload, Loader2, LogIn, CheckCircle2, XCircle, Ban, Clock } from "lucide-react";
import type { GustoPushJob, GustoPushJobStatus } from "@/lib/payroll/gustoRunnerJobs";

const ACTIVE: GustoPushJobStatus[] = ["queued", "claimed", "signin_required", "pushing"];
const isActive = (s: GustoPushJobStatus | undefined): boolean => !!s && ACTIVE.includes(s);

const STATUS_META: Record<GustoPushJobStatus, { label: string; icon: React.ElementType; cls: string; spin?: boolean }> = {
  queued: { label: "Queued", icon: Clock, cls: "text-meta" },
  claimed: { label: "Starting", icon: Loader2, cls: "text-attention", spin: true },
  signin_required: { label: "Sign in to Gusto", icon: LogIn, cls: "text-attention" },
  pushing: { label: "Writing hours", icon: Loader2, cls: "text-attention", spin: true },
  done: { label: "Finished", icon: CheckCircle2, cls: "text-positive" },
  failed: { label: "Failed", icon: XCircle, cls: "text-critical" },
  canceled: { label: "Canceled", icon: Ban, cls: "text-meta" },
};

function relTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return null;
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function GustoConsole({
  which,
  runnerConfigured,
  disabled,
  initialJob,
}: {
  which: "current" | "previous";
  runnerConfigured: boolean;
  disabled: boolean;
  initialJob: GustoPushJob | null;
}): React.JSX.Element {
  const [job, setJob] = useState<GustoPushJob | null>(initialJob);
  const [busy, setBusy] = useState(false);
  const liveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/payroll/gusto/console", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { job?: GustoPushJob | null };
      if (liveRef.current) setJob(data.job ?? null);
    } catch {
      /* transient — next poll retries */
    }
  }, []);

  // Poll while a job is active so the pane stays live (status, phase, screenshot, results) without a reload.
  useEffect(() => {
    liveRef.current = true;
    if (!isActive(job?.status)) return () => { liveRef.current = false; };
    const t = setInterval(refresh, 2000);
    return () => {
      liveRef.current = false;
      clearInterval(t);
    };
  }, [job?.status, refresh]);

  const start = useCallback(async () => {
    if (busy) return;
    const ok = window.confirm(
      `Push reconciled hours into the current Gusto DRAFT via the office browser (${which === "previous" ? "last" : "this"} week's period).\n\n` +
        "It does NOT submit, run, or approve payroll — it only fills the draft. You'll see the browser live here. Continue?",
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/payroll/gusto/console", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ which }),
      });
      const data = (await res.json().catch(() => null)) as ({ job?: GustoPushJob; error?: string; mappedCount?: number }) | null;
      if (!res.ok || !data?.job) {
        toast.error(data?.error ?? "Couldn't start the push.");
        return;
      }
      setJob(data.job);
      toast.success(`Push started for ${data.mappedCount ?? 0} worker(s) — watch it below.`);
    } catch {
      toast.error("Couldn't start the push.");
    } finally {
      setBusy(false);
    }
  }, [busy, which]);

  const cancel = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const res = await fetch("/api/payroll/gusto/console/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: job.id }),
      });
      const data = (await res.json().catch(() => null)) as { job?: GustoPushJob } | null;
      if (res.ok && data?.job) setJob(data.job);
    } catch {
      /* leave as-is; poll will catch up */
    } finally {
      setBusy(false);
    }
  }, [job]);

  if (!runnerConfigured) {
    return (
      <div className="rounded border border-rule bg-[var(--panel)] px-3 py-2.5 text-[11.5px] text-meta">
        <span className="font-medium text-secondary-text">Remote browser (no extension)</span> — not set up yet. An admin
        sets <code className="rounded bg-[var(--row)] px-1">GUSTO_RUNNER_TOKEN</code> and runs the office
        <code className="rounded bg-[var(--row)] px-1">gusto-runner</code>; then anyone here can push hours from the app and
        watch it, with nothing to install.
      </div>
    );
  }

  const active = isActive(job?.status);
  const meta = job ? STATUS_META[job.status] : null;
  const Icon = meta?.icon;
  const pushed = job?.workers.filter((w) => w.outcome === "pushed").length ?? 0;
  const skipped = job?.workers.filter((w) => w.outcome === "skipped").length ?? 0;
  const failed = job?.workers.filter((w) => w.outcome === "failed").length ?? 0;

  return (
    <div className="rounded border border-rule bg-[var(--panel)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-meta">
          <Monitor className="size-3.5" /> Remote browser · no extension
        </div>
        <div className="flex items-center gap-2">
          {active ? (
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] text-secondary-text transition-colors hover:text-foreground disabled:opacity-60"
            >
              <Ban className="size-3.5" /> Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              disabled={busy || disabled}
              title="Push reconciled hours into the current Gusto DRAFT via the office browser (never submits payroll)"
              className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              {job ? "Push again" : "Push from the app"}
            </button>
          )}
        </div>
      </div>

      {disabled && (
        <p className="mt-2 text-[11px] text-attention">Push is disabled (GUSTO_PUSH_DISABLED).</p>
      )}

      {job && meta && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${meta.cls}`}>
              {Icon && <Icon className={`size-3.5 ${meta.spin ? "animate-spin" : ""}`} />} {meta.label}
            </span>
            {job.phase && active && <span className="text-[11.5px] text-meta">{job.phase}…</span>}
            {job.periodLabel && <span className="text-[11px] text-meta">{job.periodLabel}</span>}
          </div>

          {job.status === "signin_required" && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-attention">
              <LogIn className="size-3.5" /> The office Gusto session is signed out — sign in on the office machine window shown below, then it continues automatically.
            </p>
          )}

          {/* Live remote-browser frame. Cache-busted by updatedAt so each new frame shows. */}
          {active && job.screenshot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/payroll/gusto/console/screenshot?id=${encodeURIComponent(job.id)}&t=${encodeURIComponent(job.updatedAt)}`}
              alt="Gusto remote browser (live)"
              className="mt-2 w-full rounded border border-rule"
            />
          )}
          {active && !job.screenshot && (
            <p className="mt-2 text-[11.5px] text-meta">Connecting to the office browser…</p>
          )}

          {/* Outcome summary once terminal. */}
          {!active && (
            <div className="mt-2 text-[12px]">
              {job.status === "done" && job.aborted ? (
                <p className="text-attention">
                  Nothing written — {abortLabel(job.aborted)}.
                </p>
              ) : job.status === "done" ? (
                <p className="text-secondary-text">
                  <span className="text-positive">{pushed} pushed</span>
                  {skipped > 0 && <span className="text-meta"> · {skipped} skipped</span>}
                  {failed > 0 && <span className="text-critical"> · {failed} failed</span>}
                </p>
              ) : job.status === "failed" ? (
                <p className="text-critical">{job.error ?? "The push failed."}</p>
              ) : job.status === "canceled" ? (
                <p className="text-meta">Canceled{job.canceledBy ? ` by ${job.canceledBy}` : ""}.</p>
              ) : null}
              {job.finishedAt && <span className="text-[11px] text-meta">{relTime(job.finishedAt)}</span>}
            </div>
          )}

          {/* Per-worker detail when we have it (terminal or partway). */}
          {job.workers.length > 0 && (
            <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto border-t border-rule pt-2">
              {job.workers.map((w) => (
                <li key={w.gustoMemberId} className="flex items-center justify-between gap-2 text-[11.5px]">
                  <span className="min-w-0 truncate text-secondary-text">{w.name ?? w.gustoMemberId}</span>
                  <span className={w.outcome === "pushed" ? "text-positive" : w.outcome === "failed" ? "text-critical" : "text-meta"}>
                    {w.outcome === "pushed" ? "pushed" : w.outcome === "failed" ? `failed${w.reason ? ` · ${w.reason}` : ""}` : `skipped${w.reason ? ` · ${w.reason}` : ""}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function abortLabel(aborted: string): string {
  switch (aborted) {
    case "not_logged_in": return "the office Gusto session wasn't signed in";
    case "not_a_draft": return "the open Gusto run isn't a draft";
    case "could_not_reach_inputs": return "couldn't reach the draft inputs step";
    case "no_graphql_headers": return "couldn't capture Gusto's request headers";
    default: return aborted.replace(/_/g, " ");
  }
}
