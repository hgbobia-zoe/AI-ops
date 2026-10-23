"use client";

// Website Studio blade (Phase 1) — a plain prompt box + the submitter's recent jobs, with an in-app PREVIEW
// step. The marketer types a change ("make the homepage headline say Fall Sale") and submits. The office
// runner edits the website repo on a branch, renders it on the LOCAL DevKinsta site, screenshots it, and
// posts the shots back. The job then shows a PREVIEW (desktop/mobile screenshots + a summary + the changed
// files) with "Approve → open PR" and "Discard" buttons. A non-technical team judges the RENDERED result,
// never code. Approving opens a PR for a human to review+merge; nothing goes live from here.
//
// Out of scope for Phase 1 (clear, not fake): no in-app interactive/live preview tunnel, no code-diff view,
// no multi-turn follow-up on a job, no auto-deploy. Screenshots are the Phase-1 preview; a shareable live
// staging URL is Phase 2.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Globe, Send, Loader2, CheckCircle2, XCircle, Clock, ExternalLink, Info,
  Monitor, Smartphone, Check, Trash2, Eye, FileCode2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WebsiteJob, WebsiteJobStatus } from "@/lib/website/jobs";

const STATUS_META: Record<WebsiteJobStatus, { label: string; icon: React.ElementType; cls: string }> = {
  pending: { label: "Queued", icon: Clock, cls: "text-meta" },
  running: { label: "Working", icon: Loader2, cls: "text-attention" },
  preview: { label: "Ready to review", icon: Eye, cls: "text-[var(--gold)]" },
  approved: { label: "Opening PR", icon: Loader2, cls: "text-attention" },
  done: { label: "PR ready", icon: CheckCircle2, cls: "text-positive" },
  discarded: { label: "Discarded", icon: XCircle, cls: "text-meta" },
  failed: { label: "Failed", icon: XCircle, cls: "text-critical" },
};

type Viewport = "desktop" | "mobile";

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Group a job's screenshot artifacts by page, keyed by viewport, from the "<page>-<viewport>" label. */
function groupArtifacts(job: WebsiteJob): { page: string; byViewport: Partial<Record<Viewport, string>> }[] {
  const pages = new Map<string, Partial<Record<Viewport, string>>>();
  for (const a of job.artifacts) {
    const m = /^(.*)-(desktop|mobile)$/.exec(a.label);
    const page = m ? m[1] : a.label;
    const vp = (m ? m[2] : "desktop") as Viewport;
    const entry = pages.get(page) ?? {};
    entry[vp] = a.label;
    pages.set(page, entry);
  }
  return [...pages.entries()].map(([page, byViewport]) => ({ page, byViewport }));
}

function PreviewGallery({ job }: { job: WebsiteJob }): React.JSX.Element {
  const groups = groupArtifacts(job);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  if (groups.length === 0) {
    return <p className="mt-2 text-[12.5px] text-meta">Screenshots are still uploading…</p>;
  }
  return (
    <div className="mt-3">
      <div className="mb-2 inline-flex overflow-hidden rounded border border-border text-[12px]">
        <button
          onClick={() => setViewport("desktop")}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 transition-colors ${viewport === "desktop" ? "bg-foreground/[0.08] text-foreground" : "text-meta hover:text-foreground"}`}
        >
          <Monitor className="size-3.5" /> Desktop
        </button>
        <button
          onClick={() => setViewport("mobile")}
          className={`inline-flex items-center gap-1.5 border-l border-border px-2.5 py-1 transition-colors ${viewport === "mobile" ? "bg-foreground/[0.08] text-foreground" : "text-meta hover:text-foreground"}`}
        >
          <Smartphone className="size-3.5" /> Mobile
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {groups.map(({ page, byViewport }) => {
          const label = byViewport[viewport] ?? byViewport.desktop ?? byViewport.mobile;
          return (
            <figure key={page} className="rounded border border-border">
              <figcaption className="border-b border-[var(--row-rule)] px-3 py-1.5 text-[11.5px] text-meta">{page}</figcaption>
              {label ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/website/jobs/${job.id}/artifact?label=${encodeURIComponent(label)}`}
                  alt={`${page} (${viewport}) preview`}
                  className={`mx-auto block w-full ${viewport === "mobile" ? "max-w-[390px]" : ""}`}
                />
              ) : (
                <p className="px-3 py-2 text-[12px] text-meta">No {viewport} screenshot for this page.</p>
              )}
            </figure>
          );
        })}
      </div>
    </div>
  );
}

function JobCard({ job, onDecide }: { job: WebsiteJob; onDecide: (id: string, decision: "approve" | "discard") => Promise<void> }): React.JSX.Element {
  const meta = STATUS_META[job.status] ?? STATUS_META.pending;
  const Icon = meta.icon;
  const [busy, setBusy] = useState<null | "approve" | "discard">(null);
  const spinning = job.status === "running" || job.status === "approved";

  const decide = async (decision: "approve" | "discard") => {
    setBusy(decision);
    try {
      await onDecide(job.id, decision);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-foreground">{job.prompt}</p>
        <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] ${meta.cls}`}>
          <Icon className={`size-3.5 ${spinning ? "animate-spin" : ""}`} /> {meta.label}
        </span>
      </div>

      {job.summary && (job.status === "preview" || job.status === "done" || job.status === "approved") && (
        <p className="mt-2 border-t border-[var(--row-rule)] pt-2 text-[12.5px] text-tertiary-text">{job.summary}</p>
      )}
      {job.status === "failed" && job.error && (
        <p className="mt-2 border-t border-[var(--row-rule)] pt-2 text-[12.5px] text-critical">{job.error}</p>
      )}

      {/* PREVIEW: rendered screenshots + changed files + decision */}
      {job.status === "preview" && (
        <>
          <PreviewGallery job={job} />
          {job.changedFiles.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-meta">
                <FileCode2 className="size-3.5" /> Files changed
              </div>
              <ul className="flex flex-col gap-0.5">
                {job.changedFiles.map((f) => (
                  <li key={f} className="truncate font-mono text-[11.5px] text-tertiary-text" title={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 border-t border-[var(--row-rule)] pt-3">
            <Button onClick={() => void decide("approve")} disabled={busy !== null}>
              {busy === "approve" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Approve → open PR
            </Button>
            <Button variant="outline" onClick={() => void decide("discard")} disabled={busy !== null}>
              {busy === "discard" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              Discard
            </Button>
            <span className="text-[11px] text-meta">Approving opens a pull request for a teammate to review and merge. It still does not go live.</span>
          </div>
        </>
      )}

      <div className="mt-2 flex items-center gap-3 text-[11px] text-meta">
        <span className="tabular-nums">{timeAgo(job.createdAt)}</span>
        {job.status === "done" && job.prUrl && (
          <a href={job.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground transition-colors hover:text-[var(--gold)]">
            Review the PR <ExternalLink className="size-3" />
          </a>
        )}
        {job.decidedBy && (job.status === "approved" || job.status === "done" || job.status === "discarded") && (
          <span>{job.status === "discarded" ? "Discarded" : "Approved"} by {job.decidedBy}</span>
        )}
      </div>
    </div>
  );
}

export function WebsiteStudio({ initialJobs }: { initialJobs: WebsiteJob[] }): React.JSX.Element {
  const [jobs, setJobs] = useState<WebsiteJob[]>(initialJobs);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/website/jobs", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { jobs?: WebsiteJob[] };
      if (liveRef.current && Array.isArray(data.jobs)) setJobs(data.jobs);
    } catch {
      /* transient — the next poll retries */
    }
  }, []);

  // Poll for status changes so queued → working → ready-to-review → PR-ready shows up without a reload.
  useEffect(() => {
    liveRef.current = true;
    const t = setInterval(refresh, 5000);
    return () => {
      liveRef.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  const submit = useCallback(async () => {
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/website/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const data = (await res.json().catch(() => ({}))) as { job?: WebsiteJob; error?: string };
      if (!res.ok || !data.job) {
        setError(data.error || "Could not submit. Please try again.");
        return;
      }
      setPrompt("");
      setJobs((prev) => [data.job as WebsiteJob, ...prev]);
    } catch {
      setError("Could not submit. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }, [prompt, submitting]);

  const decide = useCallback(async (id: string, decision: "approve" | "discard") => {
    try {
      const res = await fetch(`/api/website/jobs/${id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = (await res.json().catch(() => ({}))) as { job?: WebsiteJob };
      if (res.ok && data.job) {
        setJobs((prev) => prev.map((j) => (j.id === id ? (data.job as WebsiteJob) : j)));
      }
    } catch {
      /* a failed decision leaves the job in preview — the user can retry */
    }
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <main className="max-w-[820px] p-6">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Globe className="size-5 text-meta" /> Website Studio
        </h1>
        <p className="mt-1 text-[13px] text-meta">
          Describe a change to the company website in plain English. We make the change on a private copy, show you screenshots to review, and — once you approve — open a pull request. Nothing goes live until a teammate reviews and merges it.
        </p>
      </header>

      {/* Prompt box */}
      <section className="mb-6">
        <label htmlFor="ws-prompt" className="mb-1.5 block text-[12px] font-medium uppercase tracking-[0.08em] text-tertiary-text">
          What should change?
        </label>
        <textarea
          id="ws-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          rows={4}
          placeholder="Describe the website change… e.g. On the homepage, change the main headline to “Fall tent sale — book by October 31” and make the button gold."
          className="w-full resize-y rounded border border-border bg-transparent px-3 py-2.5 text-[13.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/40"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-meta">Be specific about the page and the exact wording. Press {modifierHint()}+Enter to submit.</span>
          <Button onClick={() => void submit()} disabled={!prompt.trim() || submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            {submitting ? "Submitting…" : "Submit request"}
          </Button>
        </div>
        {error && <p className="mt-2 text-[12.5px] text-critical">{error}</p>}
      </section>

      {/* Worklist */}
      <section>
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Your recent requests</h2>
        {jobs.length === 0 ? (
          <div className="flex items-start gap-2 rounded border border-border bg-[var(--row-hover)] px-3 py-2.5 text-[12.5px] text-tertiary-text">
            <Info className="mt-0.5 size-3.5 shrink-0 text-meta" />
            <span>No requests yet. Describe a change above and submit it — it will appear here and move from Queued to Working to Ready to review.</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onDecide={decide} />
            ))}
          </div>
        )}
        <p className="mt-4 text-[11.5px] text-meta">
          A teammate runs the change on the office computer and prepares the preview. If a request stays Queued for a while, that computer may be offline — check with your admin.
        </p>
      </section>
    </main>
  );
}

// Small nicety: show ⌘ on Mac, Ctrl elsewhere. Guarded for SSR (navigator is undefined on the server).
function modifierHint(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}
