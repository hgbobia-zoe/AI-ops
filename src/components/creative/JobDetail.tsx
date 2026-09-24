"use client";

// Job detail cockpit. Shows the lifecycle position, the stored Image Brief (WHY), every generation with its
// QA report, and the human-review controls. All mutations POST to /api/creative/*; each response returns the
// fresh {job, generations, events} which we apply, so the view always reflects the real server state.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Sparkles, RefreshCw, Loader2, Check, X, AlertTriangle, ThumbsUp, ThumbsDown,
  RotateCcw, Save, Wand2, ExternalLink, ImageIcon, Workflow,
} from "lucide-react";
import { StatusPill } from "./StatusPill";
import {
  LIFECYCLE_STEPS,
  ASSET_TYPE_LABEL,
  SOURCE_MODE_LABEL,
  ASPECT_RATIO_LABEL,
  GENERATION_STATUS_LABEL,
  QA_DIMENSIONS,
  type CreativeJob,
  type Generation,
  type CreativeEvent,
  type ImageBrief,
  type QaReport,
} from "@/lib/creative/types";

const fmt = (iso: string): string => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function BriefRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-2 border-t border-[var(--row-rule)] py-1.5 text-[12.5px] first:border-t-0">
      <span className="text-[11px] uppercase tracking-[0.05em] text-meta">{label}</span>
      <span className="text-tertiary-text">{value}</span>
    </div>
  );
}

function QaReportView({ report }: { report: QaReport }): React.JSX.Element {
  return (
    <div className="mt-2 rounded border border-[var(--row-rule)] bg-panel/50 p-2.5">
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className={`inline-flex items-center gap-1 font-medium ${report.verdict === "pass" ? "text-emerald-300" : "text-amber-300"}`}>
          {report.verdict === "pass" ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
          QC {report.verdict === "pass" ? "passed" : "failed"} · {report.score}
        </span>
        <span className="text-[10.5px] uppercase tracking-[0.05em] text-meta">{report.method === "n8n" ? "n8n QA + ref check" : "rules-based"}</span>
      </div>
      <p className="mb-1.5 text-[11.5px] text-meta">{report.summary}</p>
      {report.hardFailures && report.hardFailures.length > 0 && (
        <div className="mb-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
          <span className="font-medium">Hard failures:</span> {report.hardFailures.join("; ")}
        </div>
      )}
      {report.dimensions && (
        <div className="mb-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-meta sm:grid-cols-4">
          {QA_DIMENSIONS.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between gap-1">
              <span>{label}</span>
              <span className="tabular-nums text-tertiary-text">{report.dimensions![key]}</span>
            </div>
          ))}
        </div>
      )}
      <ul className="space-y-0.5">
        {report.checks.map((c, i) => (
          <li key={i} className="flex items-start gap-1.5 text-[11.5px]">
            {c.pass ? <Check className="mt-0.5 size-3 shrink-0 text-emerald-400" /> : <X className={`mt-0.5 size-3 shrink-0 ${c.critical ? "text-rose-400" : "text-amber-400"}`} />}
            <span className={c.pass ? "text-tertiary-text" : "text-foreground"}>
              <span className="font-medium">{c.label}.</span> <span className="text-meta">{c.note}</span>
            </span>
          </li>
        ))}
      </ul>
      {report.recommendedChanges && report.recommendedChanges.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-t border-[var(--row-rule)] pt-1.5 text-[11px] text-meta">
          {report.recommendedChanges.map((r, i) => (
            <li key={i}>Next: {r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function JobDetail({
  initialJob,
  initialGenerations,
  initialEvents,
  sourceImagePath,
}: {
  initialJob: CreativeJob;
  initialGenerations: Generation[];
  initialEvents: CreativeEvent[];
  sourceImagePath: string | null;
}): React.JSX.Element {
  const [job, setJob] = useState<CreativeJob>(initialJob);
  const [generations, setGenerations] = useState<Generation[]>(initialGenerations);
  const [events, setEvents] = useState<CreativeEvent[]>(initialEvents);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const brief: ImageBrief | null = job.imageBrief;

  const apply = useCallback((data: { job?: CreativeJob | null; generations?: Generation[]; events?: CreativeEvent[]; error?: string }): void => {
    if (data.job) setJob(data.job);
    if (data.generations) setGenerations(data.generations);
    if (data.events) setEvents(data.events);
    if (data.error) setError(data.error);
  }, []);

  // While a generation is in flight (async n8n handoff), poll for the callback result so it appears without
  // a manual reload. A pending generation may never get a callback — the poll just keeps showing "generating"
  // and the user can regenerate; no heavy timeout machinery.
  useEffect(() => {
    if (job.status !== "generating") return;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/creative/jobs/${job.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Parameters<typeof apply>[0];
        if (alive) apply(data);
      } catch {
        /* transient; keep polling */
      }
    };
    const iv = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [job.status, job.id, apply]);

  async function call(url: string, body: unknown, key: string): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json()) as Parameters<typeof apply>[0];
      apply(data);
      if (!res.ok && !data.error) setError("Action failed");
    } catch {
      setError("Action failed");
    } finally {
      setBusy(null);
    }
  }

  const generate = (): Promise<void> => call(`/api/creative/jobs/${job.id}/generate`, {}, "generate");
  const rerunAd = (): Promise<void> => call(`/api/creative/jobs/${job.id}/art-director`, {}, "ad");
  const approve = (generationId: string): Promise<void> => call(`/api/creative/jobs/${job.id}/review`, { action: "approve", generationId }, "approve");
  const reject = (): Promise<void> => call(`/api/creative/jobs/${job.id}/review`, { action: "reject" }, "reject");
  const revision = (): Promise<void> => call(`/api/creative/jobs/${job.id}/review`, { action: "revision" }, "revision");
  const publish = (): Promise<void> => call(`/api/creative/jobs/${job.id}/review`, { action: "publish" }, "publish");

  const activeStepIdx = LIFECYCLE_STEPS.findIndex((s) => s.statuses.includes(job.status));
  const isTerminalRejected = job.status === "rejected";
  const isGenerating = job.status === "generating";
  // Regenerate is allowed even while generating: a pending async handoff may never get its callback, so the
  // user must always be able to kick a fresh attempt.
  const canGenerate = ["draft", "queued", "needs_revision", "generating"].includes(job.status);
  const canReview = job.status === "awaiting_approval";
  const canPublish = job.status === "approved";
  const pendingGen = generations.find((g) => g.status === "generating");

  return (
    <div className="space-y-4">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[21px] font-medium tracking-tight text-foreground">{job.title}</h1>
            <StatusPill status={job.status} />
          </div>
          <p className="mt-1 text-[12px] text-meta">
            {ASSET_TYPE_LABEL[job.assetType]} · {ASPECT_RATIO_LABEL[job.aspectRatio]} · {SOURCE_MODE_LABEL[job.sourceMode]}
            {job.page || job.section ? ` · ${[job.page, job.section].filter(Boolean).join(" / ")}` : ""}
            {job.selectedModel ? ` · model: ${job.selectedModel}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={rerunAd}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-60"
            title="Recompose the Image Brief from the current job + Visual DNA"
          >
            {busy === "ad" ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5 text-tertiary-text" />}
            Re-run Art Director
          </button>
          {canGenerate && (
            <button
              onClick={generate}
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 rounded border border-foreground/30 bg-foreground/10 px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/15 disabled:opacity-60"
            >
              {busy === "generate" ? <Loader2 className="size-3.5 animate-spin" /> : job.generationCount > 0 ? <RefreshCw className="size-3.5" /> : <Sparkles className="size-3.5" />}
              {job.generationCount > 0 ? "Regenerate" : "Generate"}
            </button>
          )}
        </div>
      </header>

      {/* Lifecycle rail */}
      <div className="flex flex-wrap items-center gap-1.5 rounded border border-border bg-panel/40 px-3 py-2.5">
        {LIFECYCLE_STEPS.map((s, i) => {
          const done = activeStepIdx > i && !isTerminalRejected;
          const active = activeStepIdx === i && !isTerminalRejected;
          return (
            <div key={s.key} className="flex items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium ${
                  active ? "bg-foreground/15 text-foreground" : done ? "text-emerald-300" : "text-meta"
                }`}
              >
                {done && <Check className="size-3" />}
                {s.label}
              </span>
              {i < LIFECYCLE_STEPS.length - 1 && <span className="text-meta">›</span>}
            </div>
          );
        })}
        {isTerminalRejected && <span className="ml-2 inline-flex items-center gap-1 rounded bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-300"><X className="size-3" /> Rejected</span>}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-200">
          <AlertTriangle className="size-4" /> {error}
        </div>
      )}

      {isGenerating && (
        <div className="flex items-center gap-2 rounded border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[12.5px] text-sky-200">
          <Workflow className="size-4 shrink-0" />
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span>
            Handed to n8n — waiting for result{pendingGen?.externalRef ? ` (run ${pendingGen.externalRef})` : ""}. This view refreshes automatically when the workflow calls back.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
        {/* Left: brief + generations */}
        <div className="space-y-4">
          {/* Image Brief */}
          <section className="rounded border border-border">
            <div className="flex items-center justify-between border-b border-[var(--row-rule)] bg-panel px-3 py-2">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Image brief — why this image</h2>
              {brief && (
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${brief.briefSource === "ai_refined" ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200" : "border-white/15 bg-white/5 text-muted-foreground"}`}>
                  {brief.briefSource === "ai_refined" ? "AI-refined" : "Rules-composed"}
                </span>
              )}
            </div>
            <div className="p-3">
              {!brief ? (
                <p className="text-[12.5px] text-meta">No brief yet. Re-run the Art Director to compose one.</p>
              ) : (
                <>
                  <p className="mb-2 text-[13px] text-foreground">{brief.creativeConcept}</p>
                  <BriefRow label="Subject" value={brief.subject} />
                  <BriefRow label="Environment" value={brief.environment} />
                  <BriefRow label="Camera" value={brief.camera} />
                  <BriefRow label="Lens" value={brief.lens} />
                  <BriefRow label="Lighting" value={brief.lighting} />
                  <BriefRow label="Composition" value={brief.composition} />
                  <BriefRow label="Color grade" value={brief.colorGrade} />
                  <BriefRow label="People" value={brief.peopleDirection} />
                  {brief.preserve.length > 0 && (
                    <div className="mt-2">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.05em] text-meta">Preserve (source is truth)</div>
                      <div className="flex flex-wrap gap-1">
                        {brief.preserve.map((p) => (
                          <span key={p} className="rounded border border-emerald-500/30 bg-emerald-500/[0.07] px-1.5 py-0.5 text-[11px] text-emerald-200">{p}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {brief.transform.length > 0 && (
                    <div className="mt-2">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.05em] text-meta">Transform (AI may change)</div>
                      <div className="flex flex-wrap gap-1">
                        {brief.transform.map((t) => (
                          <span key={t} className="rounded border border-sky-500/30 bg-sky-500/[0.07] px-1.5 py-0.5 text-[11px] text-sky-200">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {brief.negativeConstraints.length > 0 && (
                    <div className="mt-2">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.05em] text-meta">Never</div>
                      <div className="flex flex-wrap gap-1">
                        {brief.negativeConstraints.map((n) => (
                          <span key={n} className="rounded border border-rose-500/25 bg-rose-500/[0.06] px-1.5 py-0.5 text-[11px] text-rose-200/90">{n}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  <button onClick={() => setShowPrompt((v) => !v)} className="mt-3 text-[11.5px] text-tertiary-text underline-offset-2 hover:underline">
                    {showPrompt ? "Hide" : "Show"} assembled prompt
                  </button>
                  {showPrompt && (
                    <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-[var(--row-rule)] bg-panel/60 p-2 text-[11px] leading-relaxed text-tertiary-text">{brief.imagePrompt}</pre>
                  )}
                </>
              )}
            </div>
          </section>

          {/* Generations */}
          <section className="rounded border border-border">
            <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">
              Generations ({generations.length})
            </h2>
            <div className="divide-y divide-[var(--row-rule)]">
              {generations.length === 0 ? (
                <p className="p-3 text-[12.5px] text-meta">No generations yet. Generate to produce the first attempt.</p>
              ) : (
                generations.map((g) => (
                  <div key={g.id} className="p-3">
                    <div className="flex items-start gap-3">
                      <div className="w-28 shrink-0">
                        {g.resultPath ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={g.resultPath} alt={`attempt ${g.attempt}`} className="w-full rounded border border-border object-cover" />
                        ) : (
                          <div className="flex h-20 w-full items-center justify-center rounded border border-border bg-panel/60 text-meta">
                            <ImageIcon className="size-5" />
                          </div>
                        )}
                        {g.placeholder && <div className="mt-1 text-center text-[9.5px] uppercase tracking-[0.04em] text-amber-300/80">Placeholder</div>}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12.5px] font-medium text-foreground">Attempt {g.attempt}</span>
                          <span className="text-[11px] text-meta">{GENERATION_STATUS_LABEL[g.status]}</span>
                        </div>
                        <div className="text-[11px] text-meta">{g.provider}{g.model ? ` · ${g.model}` : ""} · {fmt(g.createdAt)}</div>
                        {g.qaReport && <QaReportView report={g.qaReport} />}
                        {canReview && g.status === "pass" && (
                          <div className="mt-2 flex items-center gap-2">
                            <button onClick={() => approve(g.id)} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[12px] font-medium text-emerald-200 transition-colors hover:bg-emerald-500/15 disabled:opacity-60">
                              {busy === "approve" ? <Loader2 className="size-3.5 animate-spin" /> : <ThumbsUp className="size-3.5" />} Approve this
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* Right: review actions + source + audit */}
        <div className="space-y-4">
          {/* Review actions */}
          <section className="rounded border border-border">
            <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Human review</h2>
            <div className="space-y-2 p-3">
              {canReview && (
                <>
                  <p className="text-[12px] text-meta">A generation passed QC. Approve the one you want (left), or send it back.</p>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={revision} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[12px] font-medium text-amber-200 transition-colors hover:bg-amber-500/15 disabled:opacity-60">
                      {busy === "revision" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Request revision
                    </button>
                    <button onClick={reject} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[12px] font-medium text-rose-200 transition-colors hover:bg-rose-500/15 disabled:opacity-60">
                      {busy === "reject" ? <Loader2 className="size-3.5 animate-spin" /> : <ThumbsDown className="size-3.5" />} Reject
                    </button>
                  </div>
                </>
              )}
              {canPublish && (
                <>
                  <p className="text-[12px] text-emerald-200/90">Approved. Optimize and save it as the final asset.</p>
                  <button onClick={publish} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-[12.5px] font-medium text-emerald-200 transition-colors hover:bg-emerald-500/15 disabled:opacity-60">
                    {busy === "publish" ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Optimize & save asset
                  </button>
                </>
              )}
              {job.status === "published" && job.approvedAssetPath && (
                <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-2.5">
                  <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-200"><Check className="size-4" /> Asset saved</div>
                  <Link href={job.approvedAssetPath} target="_blank" className="inline-flex items-center gap-1 text-[12px] text-tertiary-text hover:text-foreground">
                    Open asset <ExternalLink className="size-3" />
                  </Link>
                </div>
              )}
              {!canReview && !canPublish && job.status !== "published" && (
                <p className="text-[12px] text-meta">
                  {job.status === "rejected" ? "This job was rejected." : "Generate an image and pass QC to unlock review."}
                </p>
              )}
            </div>
          </section>

          {/* Source of truth */}
          {sourceImagePath && (
            <section className="rounded border border-border">
              <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Source of truth</h2>
              <div className="p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={sourceImagePath} alt="source" className="w-full rounded border border-border" />
                <p className="mt-1.5 text-[11px] text-meta">The preserve constraints are taken from this real photo.</p>
              </div>
            </section>
          )}

          {/* Audit */}
          <section className="rounded border border-border">
            <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Activity</h2>
            <ol className="max-h-80 space-y-0 overflow-auto p-3">
              {events.slice().reverse().map((e) => (
                <li key={e.id} className="border-t border-[var(--row-rule)] py-1.5 text-[11.5px] first:border-t-0 first:pt-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-tertiary-text">{e.kind.replace(/_/g, " ")}</span>
                    <span className="shrink-0 text-[10.5px] text-meta">{fmt(e.ts)}</span>
                  </div>
                  {e.note && <div className="text-meta">{e.note}</div>}
                  <div className="text-[10.5px] text-meta">{e.actor ?? "system"}</div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
