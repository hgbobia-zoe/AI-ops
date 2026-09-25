"use client";

// Provider Benchmarking — the experiment cockpit. Image-first: the comparison prioritizes the photography.
// Blinding: providers read as TEST A / TEST B (name, model, and cost hidden) until the reviewer chooses to
// REVEAL. Human evaluation and the automated QA are shown in SEPARATE panels and never combined into one
// score. It never labels a winner — the neutral scorecard shows the underlying metrics side by side.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Play, Loader2, Check, X, AlertTriangle, Eye, EyeOff, Download, Lock, ImageIcon,
  CheckCircle2, Archive, FlaskConical, RotateCcw,
} from "lucide-react";
import {
  EXPERIMENT_STATUS_LABEL, EXPERIMENT_STATUS_PILL, EXPERIMENT_PHASE_LABEL,
  RUN_STATUS_LABEL, EVAL_CRITERIA, EVAL_DECISIONS, FAILURE_CATEGORIES, PREFERENCE_OPTIONS,
  type ExperimentDetail as Detail, type ExperimentRun, type ExperimentTestCase,
  type ProviderMetrics, type Verdict, type EvalDecision, type FailureCategory, type HumanEval,
} from "@/lib/creative/experimentTypes";
import { QA_DIMENSIONS, ASPECT_RATIO_LABEL, type CreativeImage } from "@/lib/creative/types";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";

const fmtPct = (v: number | null): string => (v == null ? "—" : `${v}%`);
const fmtNum = (v: number | null): string => (v == null ? "—" : String(v));
const fmtCost = (v: number | null): string => (v == null ? "unknown" : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const fmtMs = (v: number | null): string => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

export function ExperimentDetail({
  initialDetail,
  sourcePreview,
}: {
  initialDetail: Detail;
  sourcePreview: Record<string, Pick<CreativeImage, "id" | "path" | "name">>;
}): React.JSX.Element {
  const [detail, setDetail] = useState<Detail>(initialDetail);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);

  const exp = detail.experiment;
  const isDraft = exp.status === "draft";
  const providers = useMemo(() => [...exp.providers].sort((a, b) => a.sortOrder - b.sortOrder), [exp.providers]);
  const enabledProviders = providers.filter((p) => p.enabled);
  const blinded = exp.blinding && !reveal;

  const pending = detail.runs.some((r) => r.status === "pending" || r.status === "generating");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/creative/experiments/${exp.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Detail;
      if (data.experiment) setDetail(data);
    } catch {
      /* transient */
    }
  }, [exp.id]);

  // Poll while any generation is in flight so async callbacks appear without a reload.
  useEffect(() => {
    if (exp.status !== "running" || !pending) return;
    const iv = setInterval(refresh, 4000);
    return () => clearInterval(iv);
  }, [exp.status, pending, refresh]);

  async function act(url: string, body: unknown, key: string, method = "POST"): Promise<Detail | null> {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = (await res.json()) as Detail & { ok?: boolean; error?: string };
      if (!res.ok || data.error) {
        setError(data.error || "Action failed");
        return null;
      }
      if (data.experiment) setDetail(data);
      return data;
    } catch {
      setError("Action failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const start = (): Promise<Detail | null> => act(`/api/creative/experiments/${exp.id}/start`, {}, "start");
  // PATCH returns only { experiment } (not a full Detail), so patch-then-refresh to keep the matrix intact.
  async function patch(action: "complete" | "archive"): Promise<void> {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/creative/experiments/${exp.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      if (!res.ok) { setError("Action failed"); return; }
      await refresh();
    } catch {
      setError("Action failed");
    } finally {
      setBusy(null);
    }
  }
  const complete = (): Promise<void> => patch("complete");
  const archive = (): Promise<void> => patch("archive");

  const openCase = detail.cases.find((c) => c.id === openCaseId) ?? null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FlaskConical className="size-5 text-meta" />
            <h1 className="text-[21px] font-medium tracking-tight text-foreground">{exp.name}</h1>
            <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${EXPERIMENT_STATUS_PILL[exp.status]}`}>{EXPERIMENT_STATUS_LABEL[exp.status]}</span>
          </div>
          <p className="mt-1 text-[12px] text-meta">
            {EXPERIMENT_PHASE_LABEL[exp.phase]} · {isDraft ? exp.frozen.sourceImageIds.length : detail.cases.length} source{(isDraft ? exp.frozen.sourceImageIds.length : detail.cases.length) === 1 ? "" : "s"} · {enabledProviders.length} provider{enabledProviders.length === 1 ? "" : "s"} · {detail.runs.length} generation{detail.runs.length === 1 ? "" : "s"}
          </p>
          {exp.description && <p className="mt-1 max-w-2xl text-[12px] text-tertiary-text">{exp.description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {exp.blinding && !isDraft && (
            <button onClick={() => setReveal((v) => !v)} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[12px] text-foreground transition-colors hover:bg-[var(--row-hover)]" title="Reveal or hide the provider mapping">
              {reveal ? <EyeOff className="size-3.5 text-tertiary-text" /> : <Eye className="size-3.5 text-tertiary-text" />} {reveal ? "Hide providers" : "Reveal providers"}
            </button>
          )}
          {!isDraft && (
            <>
              <a href={`/api/creative/experiments/${exp.id}/export?format=csv`} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[12px] text-foreground transition-colors hover:bg-[var(--row-hover)]"><Download className="size-3.5 text-tertiary-text" /> CSV</a>
              <a href={`/api/creative/experiments/${exp.id}/export?format=json`} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[12px] text-foreground transition-colors hover:bg-[var(--row-hover)]"><Download className="size-3.5 text-tertiary-text" /> JSON</a>
            </>
          )}
          {exp.status === "running" && (
            <button onClick={complete} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[12px] font-medium text-emerald-200 transition-colors hover:bg-emerald-500/15 disabled:opacity-60">{busy === "complete" ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Mark complete</button>
          )}
          {(exp.status === "running" || exp.status === "completed") && (
            <button onClick={archive} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[12px] text-meta transition-colors hover:bg-[var(--row-hover)]">{busy === "archive" ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />} Archive</button>
          )}
        </div>
      </header>

      {error && <div className="flex items-center gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-200"><AlertTriangle className="size-4" /> {error}</div>}

      {/* Frozen inputs — the controlled invariant */}
      <FrozenInputsCard detail={detail} />

      {isDraft ? (
        <DraftView detail={detail} sourcePreview={sourcePreview} onStart={start} starting={busy === "start"} />
      ) : (
        <>
          {pending && (
            <div className="flex items-center gap-2 rounded border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[12.5px] text-sky-200">
              <Loader2 className="size-3.5 shrink-0 animate-spin" /> Generations in flight — the execution plane (n8n) fills these in via callbacks. This view refreshes automatically. Where no callback has arrived yet, cells show a pending state (nothing is fabricated).
            </div>
          )}
          <Scorecard metrics={detail.metrics} blinded={blinded} />
          <Matrix detail={detail} providers={enabledProviders} blinded={blinded} onOpen={setOpenCaseId} />
        </>
      )}

      {openCase && (
        <ComparisonDrawer
          detail={detail}
          testCase={openCase}
          blinded={blinded}
          onClose={() => setOpenCaseId(null)}
          onChanged={setDetail}
        />
      )}
    </div>
  );
}

// ── Frozen inputs ─────────────────────────────────────────────────────────────────────────────────────
function FrozenInputsCard({ detail }: { detail: Detail }): React.JSX.Element {
  const f = detail.experiment.frozen;
  const started = detail.experiment.status !== "draft";
  return (
    <section className="rounded border border-border">
      <div className="flex items-center justify-between border-b border-[var(--row-rule)] bg-panel px-3 py-2">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Controlled input {started ? "(frozen)" : "(freezes on start)"}</h2>
        {started && <span className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-meta"><Lock className="size-3" /> Locked</span>}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 p-3 text-[12px] sm:grid-cols-4">
        <Kv label="Aspect ratio" value={ASPECT_RATIO_LABEL[f.aspectRatio]} />
        <Kv label="Visual DNA version" value={f.visualDnaVersion ?? "—"} />
        <Kv label="Prompt version" value={f.promptVersion ?? "—"} />
        <Kv label="Objective" value={f.objective ?? "—"} />
        <Kv label="Target audience" value={f.targetAudience ?? "—"} />
      </div>
      <div className="grid grid-cols-1 gap-3 border-t border-[var(--row-rule)] p-3 sm:grid-cols-2">
        <TagList label="Preserve (source is truth)" items={f.preserve} tone="emerald" />
        <TagList label="Transform (may change)" items={f.transform} tone="sky" />
      </div>
      <p className="border-t border-[var(--row-rule)] px-3 py-2 text-[11px] text-meta">Every provider receives this identical input. Only provider/model changes — no per-provider prompt optimization.</p>
    </section>
  );
}

function Kv({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.05em] text-meta">{label}</div>
      <div className="truncate text-tertiary-text" title={value}>{value}</div>
    </div>
  );
}
function TagList({ label, items, tone }: { label: string; items: string[]; tone: "emerald" | "sky" }): React.JSX.Element {
  const cls = tone === "emerald" ? "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-200" : "border-sky-500/30 bg-sky-500/[0.07] text-sky-200";
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-[0.05em] text-meta">{label}</div>
      <div className="flex flex-wrap gap-1">
        {items.length ? items.map((x) => <span key={x} className={`rounded border px-1.5 py-0.5 text-[11px] ${cls}`}>{x}</span>) : <span className="text-[11px] text-meta">—</span>}
      </div>
    </div>
  );
}

// ── Draft view ────────────────────────────────────────────────────────────────────────────────────────
function DraftView({ detail, sourcePreview, onStart, starting }: { detail: Detail; sourcePreview: Record<string, Pick<CreativeImage, "id" | "path" | "name">>; onStart: () => void; starting: boolean }): React.JSX.Element {
  const exp = detail.experiment;
  const enabled = exp.providers.filter((p) => p.enabled);
  return (
    <section className="rounded border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--row-rule)] bg-panel px-3 py-2">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Test set — {exp.frozen.sourceImageIds.length} × {enabled.length} = {exp.frozen.sourceImageIds.length * enabled.length} generations</h2>
        <button onClick={onStart} disabled={starting || exp.frozen.sourceImageIds.length === 0 || enabled.length === 0} className="inline-flex items-center gap-1.5 rounded border border-foreground/30 bg-foreground/10 px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/15 disabled:opacity-60">
          {starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} {starting ? "Starting…" : "Freeze inputs & start"}
        </button>
      </div>
      <div className="p-3">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {enabled.map((p) => <span key={p.id} className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11.5px] text-tertiary-text"><span className="flex size-4 items-center justify-center rounded border border-border text-[10px] text-meta">{p.blindLabel}</span>{p.providerName}{p.model ? <span className="text-meta">· {p.model}</span> : null}</span>)}
        </div>
        {exp.frozen.sourceImageIds.length === 0 ? (
          <p className="text-[12px] text-meta">No source images selected.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 md:grid-cols-8">
            {exp.frozen.sourceImageIds.map((sid) => {
              const img = sourcePreview[sid];
              return (
                <div key={sid} className="overflow-hidden rounded border border-border">
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img.path} alt={img.name ?? "source"} className="h-16 w-full object-cover" />
                  ) : (
                    <div className="flex h-16 items-center justify-center text-meta"><ImageIcon className="size-4" /></div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Provider scorecard (neutral — no winner) ──────────────────────────────────────────────────────────
function Scorecard({ metrics, blinded }: { metrics: ProviderMetrics[]; blinded: boolean }): React.JSX.Element {
  const cols: { label: string; get: (m: ProviderMetrics) => string; hideBlinded?: boolean }[] = [
    { label: "Generations", get: (m) => String(m.generations) },
    { label: "Successful", get: (m) => String(m.successful) },
    { label: "AI QA pass", get: (m) => String(m.aiQaPass) },
    { label: "Human approved", get: (m) => String(m.humanApproved) },
    { label: "Publishable", get: (m) => String(m.publishable) },
    { label: "Approval rate", get: (m) => fmtPct(m.humanApprovalRate) },
    { label: "Avg QA score", get: (m) => fmtNum(m.avgQaScore) },
    { label: "Product accuracy", get: (m) => fmtNum(m.avgProductAccuracy) },
    { label: "Brand alignment", get: (m) => fmtNum(m.avgBrandAlignment) },
    { label: "Avg gen time", get: (m) => fmtMs(m.avgGenerationTimeMs) },
    { label: "Avg cost", get: (m) => (m.costKnown ? fmtCost(m.avgCost) : "unknown"), hideBlinded: true },
    { label: "Cost / approval", get: (m) => (m.costKnown ? fmtCost(m.costPerApproved) : "unknown"), hideBlinded: true },
  ];
  return (
    <section className="rounded border border-border">
      <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Provider scorecard — data only, no winner</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[12px]">
          <thead>
            <tr className="border-b border-[var(--row-rule)] text-left text-[10.5px] uppercase tracking-[0.05em] text-meta">
              <th className="px-3 py-2 font-medium">Metric</th>
              {metrics.map((m) => (
                <th key={m.providerRefId} className="px-3 py-2 text-right font-medium">
                  {blinded ? `Test ${m.blindLabel}` : m.providerName}
                  {!blinded && m.model ? <div className="font-normal normal-case text-meta">{m.model}</div> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cols.map((c) => (
              <tr key={c.label} className="border-b border-[var(--row-rule)] last:border-b-0">
                <td className="px-3 py-1.5 text-meta">{c.label}</td>
                {metrics.map((m) => (
                  <td key={m.providerRefId} className="px-3 py-1.5 text-right tabular-nums text-tertiary-text">{c.hideBlinded && blinded ? "—" : c.get(m)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[var(--row-rule)] px-3 py-2 text-[11px] text-meta">Publishable = automated QA PASS <span className="text-tertiary-text">and</span> human-approved. Human evaluation and AI QA are tracked separately and never combined into one score.</p>
    </section>
  );
}

// ── Test matrix (rows = source, columns = providers) ──────────────────────────────────────────────────
function Matrix({ detail, providers, blinded, onOpen }: { detail: Detail; providers: Detail["experiment"]["providers"]; blinded: boolean; onOpen: (caseId: string) => void }): React.JSX.Element {
  const runFor = (caseId: string, providerRefId: string): ExperimentRun | undefined => detail.runs.find((r) => r.caseId === caseId && r.providerRefId === providerRefId);
  return (
    <section className="rounded border border-border">
      <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Test matrix — click a row to compare</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-[var(--row-rule)] text-left text-[10.5px] uppercase tracking-[0.05em] text-meta">
              <th className="px-3 py-2 font-medium">Source</th>
              {providers.map((p) => <th key={p.id} className="px-3 py-2 text-center font-medium">{blinded ? `Test ${p.blindLabel}` : p.providerName}</th>)}
            </tr>
          </thead>
          <tbody>
            {detail.cases.map((c) => (
              <tr key={c.id} className="cursor-pointer border-b border-[var(--row-rule)] transition-colors last:border-b-0 hover:bg-[var(--row-hover)]" onClick={() => onOpen(c.id)}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {c.sourceSnapshot?.path ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.sourceSnapshot.path} alt="source" className="size-12 rounded border border-border object-cover" />
                    ) : <div className="flex size-12 items-center justify-center rounded border border-border text-meta"><ImageIcon className="size-4" /></div>}
                    <span className="text-[11.5px] text-meta">#{String(c.seq).padStart(3, "0")}</span>
                  </div>
                </td>
                {providers.map((p) => {
                  const run = runFor(c.id, p.id);
                  const gen = run?.generationId ? detail.generations[run.generationId] : undefined;
                  return (
                    <td key={p.id} className="px-3 py-2">
                      <div className="mx-auto flex w-24 flex-col items-center">
                        {gen?.resultPath ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={gen.resultPath} alt="generation" className="h-16 w-24 rounded border border-border object-cover" />
                        ) : (
                          <div className="flex h-16 w-24 items-center justify-center rounded border border-border bg-panel/50 text-meta">
                            {run?.status === "generating" || run?.status === "pending" ? <Loader2 className="size-4 animate-spin" /> : run?.status === "failed" ? <X className="size-4 text-rose-400" /> : <ImageIcon className="size-4" />}
                          </div>
                        )}
                        <span className="mt-1 text-center text-[10px] text-meta">{run ? RUN_STATUS_LABEL[run.status] : "—"}{gen?.placeholder ? " · placeholder" : ""}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Comparison drawer ─────────────────────────────────────────────────────────────────────────────────
function ComparisonDrawer({ detail, testCase, blinded, onClose, onChanged }: { detail: Detail; testCase: ExperimentTestCase; blinded: boolean; onClose: () => void; onChanged: (d: Detail) => void }): React.JSX.Element {
  const providers = [...detail.experiment.providers].filter((p) => p.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
  const runs = providers.map((p) => detail.runs.find((r) => r.caseId === testCase.id && r.providerRefId === p.id)).filter((r): r is ExperimentRun => !!r);
  const [prefBusy, setPrefBusy] = useState(false);
  const [prefNote, setPrefNote] = useState(testCase.preferenceNote ?? "");

  // Persist a preference. `value` is a concrete run id, or "both" / "neither".
  async function savePreference(value: string): Promise<void> {
    setPrefBusy(true);
    try {
      const res = await fetch(`/api/creative/experiments/${detail.experiment.id}/eval`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preference", caseId: testCase.id, choice: value, note: prefNote }),
      });
      const data = (await res.json()) as Detail;
      if (data.experiment) onChanged(data);
    } finally {
      setPrefBusy(false);
    }
  }
  function submitPreference(choice: "A" | "B" | "both" | "neither"): void {
    if (choice === "A" || choice === "B") {
      const run = runs[choice === "A" ? 0 : 1];
      if (!run) return;
      void savePreference(run.id);
    } else {
      void savePreference(choice);
    }
  }

  const currentPref = testCase.preference;
  const prefLabel = (): string => {
    if (!currentPref) return "not set";
    if (currentPref === "both") return "Both";
    if (currentPref === "neither") return "Neither";
    const r = runs.find((x) => x.id === currentPref);
    return r ? `Test ${r.blindLabel}` : "set";
  };

  return (
    <SidePanelOverlay onClose={onClose} widthClass="max-w-[60rem]">
      <div className="flex h-full flex-col bg-background">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-[13px] font-medium text-foreground">Compare — test case #{String(testCase.seq).padStart(3, "0")}</div>
            <div className="text-[11px] text-meta">{blinded ? "Blinded — evaluate the image itself" : "Providers revealed"}</div>
          </div>
          <button onClick={onClose} className="flex size-8 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"><X className="size-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {/* Source on top */}
          <div>
            <div className="mb-1 text-[10.5px] uppercase tracking-[0.06em] text-meta">Source (the truth)</div>
            {testCase.sourceSnapshot?.path ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={testCase.sourceSnapshot.path} alt="source" className="max-h-64 w-full rounded border border-border object-contain bg-panel/40" />
            ) : <div className="flex h-32 items-center justify-center rounded border border-border text-meta"><ImageIcon className="size-5" /></div>}
          </div>

          {/* Provider columns */}
          <div className={`grid gap-4 ${runs.length <= 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
            {runs.map((run) => (
              <RunPanel key={run.id} detail={detail} run={run} label={blinded ? `Test ${run.blindLabel}` : (detail.experiment.providers.find((p) => p.id === run.providerRefId)?.providerName ?? run.providerId)} revealCost={!blinded} onChanged={onChanged} />
            ))}
          </div>

          {/* Paired preference */}
          {detail.experiment.humanEval && (
            <div className="rounded border border-border p-3">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-meta">Which would you publish? <span className="normal-case text-meta">(a winner is not required — current: {prefLabel()})</span></div>
              <div className="flex flex-wrap gap-2">
                {PREFERENCE_OPTIONS.map((o) => {
                  const disabled = (o.key === "A" && runs.length < 1) || (o.key === "B" && runs.length < 2);
                  const active = (o.key === "A" && currentPref === runs[0]?.id) || (o.key === "B" && currentPref === runs[1]?.id) || currentPref === o.key;
                  return (
                    <button key={o.key} disabled={disabled || prefBusy} onClick={() => submitPreference(o.key)} className={`rounded border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40 ${active ? "border-foreground/50 bg-foreground/15 text-foreground" : "border-border text-tertiary-text hover:bg-[var(--row-hover)]"}`}>{o.label}</button>
                  );
                })}
                {prefBusy && <Loader2 className="size-4 animate-spin text-meta" />}
              </div>
              <input value={prefNote} onChange={(e) => setPrefNote(e.target.value)} onBlur={() => { if (currentPref) void savePreference(currentPref); }} placeholder="Why (optional)" className="mt-2 w-full rounded border border-border bg-card px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30" />
            </div>
          )}
        </div>
      </div>
    </SidePanelOverlay>
  );
}

// ── One provider's panel inside the comparison: image + AI QA + human eval ────────────────────────────
function RunPanel({ detail, run, label, revealCost, onChanged }: { detail: Detail; run: ExperimentRun; label: string; revealCost: boolean; onChanged: (d: Detail) => void }): React.JSX.Element {
  const gen = run.generationId ? detail.generations[run.generationId] : undefined;
  const existing = detail.evals.find((e) => e.runId === run.id) ?? null;
  const existingFailures = detail.failures.filter((f) => f.runId === run.id);

  return (
    <div className="rounded border border-border">
      <div className="flex items-center justify-between border-b border-[var(--row-rule)] bg-panel px-2.5 py-1.5">
        <span className="text-[12px] font-medium text-foreground">{label}</span>
        <span className="text-[10px] text-meta">{RUN_STATUS_LABEL[run.status]}{gen?.placeholder ? " · placeholder" : ""}</span>
      </div>
      <div className="p-2.5">
        {gen?.resultPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={gen.resultPath} alt={label} className="max-h-72 w-full rounded border border-border object-contain bg-panel/40" />
        ) : (
          <div className="flex h-40 items-center justify-center rounded border border-border bg-panel/50 text-meta">
            {run.status === "generating" || run.status === "pending" ? <span className="flex items-center gap-2 text-[12px]"><Loader2 className="size-4 animate-spin" /> awaiting result</span> : run.status === "failed" ? <span className="text-[12px] text-rose-300">generation failed</span> : <ImageIcon className="size-5" />}
          </div>
        )}
        {revealCost && gen && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-meta">
            <span>Executed: {gen.provider}{gen.model ? ` · ${gen.model}` : ""}</span>
            <span>Cost: {gen.cost.known ? fmtCost(gen.cost.total) : "unknown"}</span>
            <span>Time: {fmtMs(gen.processingMs)}</span>
          </div>
        )}

        {/* Automated QA (AI) — separate panel */}
        {detail.experiment.autoQa && <QaBlock gen={gen} />}

        {/* Human evaluation — separate panel */}
        {detail.experiment.humanEval && <EvalForm detail={detail} run={run} existing={existing} existingFailures={existingFailures.map((f) => f.category)} onChanged={onChanged} disabled={!gen?.resultPath} />}
      </div>
    </div>
  );
}

function QaBlock({ gen }: { gen: Detail["generations"][string] | undefined }): React.JSX.Element {
  const qa = gen?.qaReport ?? null;
  return (
    <div className="mt-2 rounded border border-[var(--row-rule)] bg-panel/40 p-2">
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="font-medium uppercase tracking-[0.05em] text-meta">Automated QA (AI)</span>
        {qa ? <span className={`font-medium ${qa.verdict === "pass" ? "text-emerald-300" : "text-amber-300"}`}>{qa.decision} · {qa.score}</span> : <span className="text-meta">pending</span>}
      </div>
      {!qa ? (
        <p className="text-[11px] text-meta">No QA yet — the automated 8-axis scorecard arrives with the generation callback.</p>
      ) : (
        <>
          {qa.dimensions && (
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10.5px] text-meta">
              {QA_DIMENSIONS.map(({ key, label }) => <div key={key} className="flex justify-between"><span>{label}</span><span className="tabular-nums text-tertiary-text">{qa.dimensions![key]}</span></div>)}
            </div>
          )}
          {qa.hardFailures && qa.hardFailures.length > 0 && <div className="mt-1 rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10.5px] text-rose-200">Hard fail: {qa.hardFailures.join("; ")}</div>}
        </>
      )}
    </div>
  );
}

function EvalForm({ detail, run, existing, existingFailures, onChanged, disabled }: { detail: Detail; run: ExperimentRun; existing: HumanEval | null; existingFailures: FailureCategory[]; onChanged: (d: Detail) => void; disabled: boolean }): React.JSX.Element {
  const [pa, setPa] = useState<Verdict | null>(existing?.productAccuracy ?? null);
  const [re, setRe] = useState<Verdict | null>(existing?.realism ?? null);
  const [bf, setBf] = useState<Verdict | null>(existing?.brandFit ?? null);
  const [co, setCo] = useState<Verdict | null>(existing?.composition ?? null);
  const [us, setUs] = useState<Verdict | null>(existing?.usability ?? null);
  const [overall, setOverall] = useState<Verdict | null>(existing?.overallApproval ?? null);
  const [decision, setDecision] = useState<EvalDecision | null>(existing?.decision ?? null);
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [fails, setFails] = useState<Set<FailureCategory>>(new Set(existingFailures));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const criterionState: Record<string, [Verdict | null, (v: Verdict | null) => void]> = {
    productAccuracy: [pa, setPa], realism: [re, setRe], brandFit: [bf, setBf], composition: [co, setCo], usability: [us, setUs],
  };
  const toggleFail = (c: FailureCategory): void => setFails((prev) => { const n = new Set(prev); if (n.has(c)) n.delete(c); else n.add(c); return n; });

  async function submit(): Promise<void> {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/creative/experiments/${detail.experiment.id}/eval`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "eval", runId: run.id,
          productAccuracy: pa, realism: re, brandFit: bf, composition: co, usability: us,
          overallApproval: overall, decision, notes,
          failures: [...fails].map((c) => ({ category: c })),
        }),
      });
      const data = (await res.json()) as Detail;
      if (data.experiment) { onChanged(data); setSaved(true); }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded border border-[var(--row-rule)] bg-panel/20 p-2">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.05em] text-meta">Human evaluation</div>
      <div className="space-y-1">
        {EVAL_CRITERIA.map(({ key, label, help }) => {
          const [val, set] = criterionState[key];
          return (
            <div key={key} className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] text-tertiary-text" title={help}>{label}</span>
              <div className="flex gap-1">
                <PfBtn active={val === "pass"} tone="pass" onClick={() => set(val === "pass" ? null : "pass")} />
                <PfBtn active={val === "fail"} tone="fail" onClick={() => set(val === "fail" ? null : "fail")} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--row-rule)] pt-2">
        <span className="text-[11.5px] font-medium text-foreground">Overall approval</span>
        <div className="flex gap-1">
          <PfBtn active={overall === "pass"} tone="pass" onClick={() => setOverall(overall === "pass" ? null : "pass")} />
          <PfBtn active={overall === "fail"} tone="fail" onClick={() => setOverall(overall === "fail" ? null : "fail")} />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {EVAL_DECISIONS.map((d) => (
          <button key={d.key} onClick={() => setDecision(decision === d.key ? null : d.key)} className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors ${decision === d.key ? "border-foreground/50 bg-foreground/15 text-foreground" : "border-border text-meta hover:bg-[var(--row-hover)]"}`}>{d.label}</button>
        ))}
      </div>

      {/* Failure reasons (structured) */}
      <div className="mt-2">
        <div className="mb-1 text-[10.5px] uppercase tracking-[0.05em] text-meta">Failure reasons (if rejected)</div>
        <div className="flex flex-wrap gap-1">
          {FAILURE_CATEGORIES.map((c) => (
            <button key={c.key} onClick={() => toggleFail(c.key)} title={c.examples.join(", ")} className={`rounded border px-1.5 py-0.5 text-[10.5px] transition-colors ${fails.has(c.key) ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : "border-border text-meta hover:bg-[var(--row-hover)]"}`}>{c.label}</button>
          ))}
        </div>
      </div>

      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className="mt-2 w-full resize-y rounded border border-border bg-card px-2 py-1 text-[11.5px] text-foreground outline-none placeholder:text-meta focus:border-foreground/30" rows={2} />

      <div className="mt-2 flex items-center gap-2">
        <button onClick={submit} disabled={saving || disabled} className="inline-flex items-center gap-1.5 rounded border border-foreground/30 bg-foreground/10 px-2.5 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-foreground/15 disabled:opacity-50">{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save eval</button>
        {saved && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300"><Check className="size-3" /> saved</span>}
        {existing && !saved && <span className="inline-flex items-center gap-1 text-[11px] text-meta"><RotateCcw className="size-3" /> re-evaluating overwrites</span>}
        {disabled && <span className="text-[11px] text-meta">waiting for the image</span>}
      </div>
    </div>
  );
}

function PfBtn({ active, tone, onClick }: { active: boolean; tone: "pass" | "fail"; onClick: () => void }): React.JSX.Element {
  const on = tone === "pass" ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200" : "border-rose-500/50 bg-rose-500/15 text-rose-200";
  return (
    <button onClick={onClick} className={`flex size-6 items-center justify-center rounded border transition-colors ${active ? on : "border-border text-meta hover:bg-[var(--row-hover)]"}`} title={tone === "pass" ? "Pass" : "Fail"}>
      {tone === "pass" ? <Check className="size-3.5" /> : <X className="size-3.5" />}
    </button>
  );
}
