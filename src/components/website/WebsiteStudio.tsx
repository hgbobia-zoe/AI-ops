"use client";

// Website Studio (browse-and-edit) — an always-on embedded browser the marketing team uses to REVIEW the
// company website, plus a page-aware prompt box. They browse to a page (Production live site, or the
// Local/Staging DevKinsta render via the environment toggle), and WHATEVER PAGE they're looking at becomes
// the edit context: the prompt submits with the current address-bar URL + environment attached, so they
// just type "change this" and the page they're on rides along. The office runner then edits the website
// repo on a branch, renders it locally, screenshots it, and posts the shots back; the job shows a PREVIEW
// (desktop/mobile screenshots + a summary + the changed files) with "Approve → open PR" and "Discard". A
// non-technical team judges the RENDERED result, never code. Approving opens a PR for a human to review +
// merge; nothing goes live from here.
//
// The Studio OWNS the address bar — the app always knows the current URL even on cross-origin pages where it
// can't read the iframe. Many sites refuse framing (X-Frame-Options / CSP frame-ancestors): when that's
// detected we fall back to showing the URL + "Open in new tab" while STILL capturing the URL as the edit
// context. We never pretend a page embedded if it didn't.
//
// Still out of scope (clear, not fake): no in-app LIVE per-job preview tunnel (the runner's screenshots are
// the rendered-change proof), no code-diff view, no multi-turn follow-up on a job, no auto-deploy. In-page
// link clicks inside the embedded frame are not tracked (cross-origin) — type/paste the URL in the address
// bar to set the edit context.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Globe, Send, Loader2, CheckCircle2, XCircle, Clock, ExternalLink, Info,
  Monitor, Smartphone, Check, Trash2, Eye, FileCode2, ArrowLeft, ArrowRight, RotateCw, ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WebsiteJob, WebsiteJobStatus } from "@/lib/website/jobs";
import type { WebsiteEnvUrls, WebsiteEnvironment } from "@/lib/website/config";

const STATUS_META: Record<WebsiteJobStatus, { label: string; icon: React.ElementType; cls: string }> = {
  pending: { label: "Queued", icon: Clock, cls: "text-meta" },
  running: { label: "Working", icon: Loader2, cls: "text-attention" },
  preview: { label: "Ready to review", icon: Eye, cls: "text-[var(--gold)]" },
  approved: { label: "Opening PR", icon: Loader2, cls: "text-attention" },
  done: { label: "PR ready", icon: CheckCircle2, cls: "text-positive" },
  discarded: { label: "Discarded", icon: XCircle, cls: "text-meta" },
  failed: { label: "Failed", icon: XCircle, cls: "text-critical" },
};

const ENV_LABEL: Record<WebsiteEnvironment, string> = { production: "Production", local: "Local / Staging" };

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

/** Resolve the user's address-bar text to a full URL. A full http(s) URL is used as-is; anything else is
 *  treated as a site-root-relative path joined to the environment origin. Returns null if it can't be made
 *  into a valid URL. */
function resolveUrl(input: string, origin: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return origin || null;
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).toString();
    if (!origin) return null;
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    return new URL(path, origin).toString();
  } catch {
    return null;
  }
}

/** A short human label for a URL: its path + query, relative to the origin when possible (e.g. "/about"),
 *  falling back to the full URL. */
function pathLabel(url: string): string {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}`;
    return p === "/" || p === "" ? "/ (home)" : p;
  } catch {
    return url || "—";
  }
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

      {/* The page + environment this request targeted (the edit context captured from the browser). */}
      {job.contextUrl && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-meta">
          <Globe className="size-3" />
          <span className="truncate" title={job.contextUrl}>
            {pathLabel(job.contextUrl)} on {ENV_LABEL[job.environment]}
          </span>
        </p>
      )}

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

/** The always-on embedded browser: environment toggle + address bar + back/forward/reload + an iframe, with a
 *  graceful fallback for pages that refuse to be framed. The Studio owns `currentUrl` (the edit context) and
 *  reports it + the environment up to the prompt box via onContextChange. */
function BrowserPane({
  envUrls,
  environment,
  setEnvironment,
  currentUrl,
  setCurrentUrl,
}: {
  envUrls: WebsiteEnvUrls;
  environment: WebsiteEnvironment;
  setEnvironment: (e: WebsiteEnvironment) => void;
  currentUrl: string;
  setCurrentUrl: (u: string) => void;
}): React.JSX.Element {
  const origin = environment === "local" ? envUrls.local : envUrls.production;
  const [address, setAddress] = useState(currentUrl);
  // Simple back/forward history the Studio maintains (the iframe's own history is cross-origin + unreadable).
  const [history, setHistory] = useState<string[]>([currentUrl]);
  const [histIndex, setHistIndex] = useState(0);
  // Framing-detection heuristic: "unknown" while loading, "ok" once the iframe fires onload in time,
  // "blocked" if it times out / errors (X-Frame-Options / CSP frame-ancestors). Never pretend it embedded.
  const [framed, setFramed] = useState<"unknown" | "ok" | "blocked">("unknown");
  const [reloadNonce, setReloadNonce] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // (Re)start the framing-detection heuristic: unknown now, and "blocked" if no load arrives within the
  // window. Called only from event handlers (never synchronously in an effect body) + a mount-only starter
  // below. The "blocked" flip happens in the timer callback; onFrameLoad flips to "ok" and cancels it.
  const startDetection = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setFramed("unknown");
    timerRef.current = setTimeout(() => setFramed("blocked"), 4000);
  }, []);

  // Mount-only: kick off detection for the initial page and clean the timer up on unmount.
  useEffect(() => {
    timerRef.current = setTimeout(() => setFramed("blocked"), 4000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onFrameLoad = () => {
    // A frame-blocked page typically never reaches a real load (the browser refuses it), so a load within the
    // window is our best positive signal. Best-effort heuristic, not a guarantee.
    if (timerRef.current) clearTimeout(timerRef.current);
    setFramed("ok");
  };

  // Navigate to a brand-new URL (truncates any forward history, like a browser).
  const navigateTo = useCallback((url: string) => {
    setCurrentUrl(url);
    setAddress(url);
    startDetection();
    setHistory((h) => {
      const base = h.slice(0, histIndex + 1);
      if (base[base.length - 1] === url) return base; // same URL — don't stack a dupe
      const next = [...base, url];
      setHistIndex(next.length - 1);
      return next;
    });
  }, [histIndex, setCurrentUrl, startDetection]);

  const submitAddress = () => {
    const url = resolveUrl(address, origin);
    if (url) navigateTo(url);
  };

  const reload = () => {
    setReloadNonce((n) => n + 1);
    startDetection();
  };

  const goBack = () => {
    if (histIndex <= 0) return;
    const i = histIndex - 1;
    setHistIndex(i);
    setCurrentUrl(history[i]);
    setAddress(history[i]);
    startDetection();
  };
  const goForward = () => {
    if (histIndex >= history.length - 1) return;
    const i = histIndex + 1;
    setHistIndex(i);
    setCurrentUrl(history[i]);
    setAddress(history[i]);
    startDetection();
  };

  // Switching environment keeps the current PATH but swaps the origin, then navigates fresh.
  const switchEnv = (next: WebsiteEnvironment) => {
    if (next === environment) return;
    const nextOrigin = next === "local" ? envUrls.local : envUrls.production;
    let path = "/";
    try {
      const u = new URL(currentUrl);
      path = `${u.pathname}${u.search}`;
    } catch {
      /* keep root */
    }
    setEnvironment(next);
    const url = resolveUrl(path, nextOrigin);
    if (url) navigateTo(url);
  };

  return (
    <div className="overflow-hidden rounded border border-border">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-[var(--row-hover)] px-2.5 py-2">
        {/* Environment toggle */}
        <div className="inline-flex overflow-hidden rounded border border-border text-[11.5px]">
          {(["production", "local"] as WebsiteEnvironment[]).map((e, i) => (
            <button
              key={e}
              onClick={() => switchEnv(e)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 transition-colors ${i > 0 ? "border-l border-border" : ""} ${environment === e ? "bg-foreground/[0.1] text-foreground" : "text-meta hover:text-foreground"}`}
              title={e === "production" ? envUrls.production : envUrls.local}
            >
              {ENV_LABEL[e]}
            </button>
          ))}
        </div>

        {/* Back / forward / reload */}
        <div className="inline-flex items-center gap-0.5">
          <button onClick={goBack} disabled={histIndex <= 0} className="rounded p-1 text-meta transition-colors enabled:hover:bg-foreground/[0.06] enabled:hover:text-foreground disabled:opacity-40" title="Back" aria-label="Back">
            <ArrowLeft className="size-4" />
          </button>
          <button onClick={goForward} disabled={histIndex >= history.length - 1} className="rounded p-1 text-meta transition-colors enabled:hover:bg-foreground/[0.06] enabled:hover:text-foreground disabled:opacity-40" title="Forward" aria-label="Forward">
            <ArrowRight className="size-4" />
          </button>
          <button onClick={reload} className="rounded p-1 text-meta transition-colors hover:bg-foreground/[0.06] hover:text-foreground" title="Reload" aria-label="Reload">
            <RotateCw className="size-3.5" />
          </button>
        </div>

        {/* Address bar — the Studio owns this; it's the edit context */}
        <div className="flex min-w-[200px] flex-1 items-center gap-1.5 rounded border border-border bg-background px-2 py-1">
          <Globe className="size-3.5 shrink-0 text-meta" />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); submitAddress(); }
            }}
            spellCheck={false}
            placeholder={`${origin}/…`}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-meta"
            aria-label="Address bar"
          />
          <a href={currentUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-meta transition-colors hover:text-foreground" title="Open in a new tab" aria-label="Open in a new tab">
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      </div>

      {/* Viewport */}
      <div className="relative bg-background" style={{ height: 460 }}>
        <iframe
          key={`${currentUrl}#${reloadNonce}`}
          src={currentUrl}
          onLoad={onFrameLoad}
          onError={() => setFramed("blocked")}
          title="Website preview"
          className="h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
        {framed === "blocked" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--row-hover)] px-6 text-center">
            <ShieldAlert className="size-6 text-[var(--gold)]" />
            <p className="max-w-[460px] text-[13px] text-foreground">
              This page won’t display inside the app — the site blocks embedding (a common security setting).
              Your request still targets this exact page; open it in a new tab to review it.
            </p>
            <p className="max-w-[460px] break-all font-mono text-[11.5px] text-meta">{currentUrl}</p>
            <Button variant="outline" onClick={() => window.open(currentUrl, "_blank", "noopener,noreferrer")}>
              <ExternalLink className="size-3.5" /> Open in new tab
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function WebsiteStudio({ initialJobs, envUrls }: { initialJobs: WebsiteJob[]; envUrls: WebsiteEnvUrls }): React.JSX.Element {
  const [jobs, setJobs] = useState<WebsiteJob[]>(initialJobs);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<WebsiteEnvironment>("production");
  const [currentUrl, setCurrentUrl] = useState<string>(envUrls.production);
  const liveRef = useRef(true);

  const targetLabel = useMemo(() => pathLabel(currentUrl), [currentUrl]);

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
        body: JSON.stringify({ prompt: text, contextUrl: currentUrl, environment }),
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
  }, [prompt, submitting, currentUrl, environment]);

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
    <main className="max-w-[920px] p-6">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Globe className="size-5 text-meta" /> Website Studio
        </h1>
        <p className="mt-1 text-[13px] text-meta">
          Browse the company website below, land on the page you want to change, and describe the change in plain English. We make it on a private copy, show you screenshots to review, and — once you approve — open a pull request. Nothing goes live until a teammate reviews and merges it.
        </p>
      </header>

      {/* Embedded browser — the review + targeting surface */}
      <section className="mb-5">
        <BrowserPane
          envUrls={envUrls}
          environment={environment}
          setEnvironment={setEnvironment}
          currentUrl={currentUrl}
          setCurrentUrl={setCurrentUrl}
        />
      </section>

      {/* Page-aware prompt box */}
      <section className="mb-6">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor="ws-prompt" className="block text-[12px] font-medium uppercase tracking-[0.08em] text-tertiary-text">
            What should change?
          </label>
          <span className="inline-flex items-center gap-1.5 rounded border border-border bg-[var(--row-hover)] px-2 py-0.5 text-[11.5px] text-tertiary-text">
            <Eye className="size-3" /> Editing: <span className="font-medium text-foreground">{targetLabel}</span> on {ENV_LABEL[environment]}
          </span>
        </div>
        <textarea
          id="ws-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          rows={4}
          placeholder="Describe the change to the page you're viewing… e.g. Change the main headline to “Fall tent sale — book by October 31” and make the button gold."
          className="w-full resize-y rounded border border-border bg-transparent px-3 py-2.5 text-[13.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/40"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-meta">Your request targets the page shown above. Press {modifierHint()}+Enter to submit.</span>
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
            <span>No requests yet. Browse to a page above, describe a change, and submit it — it will appear here and move from Queued to Working to Ready to review.</span>
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
