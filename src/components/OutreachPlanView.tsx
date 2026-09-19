"use client";

// Guided Outreach Plan — a walk-me-through-it coach for one radar recommendation. Strategy up top, then
// numbered steps with copy-paste scripts and plain-language coaching, an objection cheat sheet, and a
// progress tracker so a person who is not a natural at sales can just follow it. Facts only.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Copy, Check, Loader2, Sparkles, Compass, MessageSquareWarning, Search, Mail, Phone, Voicemail, Smartphone, Contact, ChevronDown } from "lucide-react";
import {
  PLAN_CHANNEL_LABEL, PLAN_STATUS_LABEL, PLAN_STATUS_ORDER, emptyPlanState,
  type OutreachPlan, type PlanState, type PlanStatus, type PlanChannel, type PlanStep,
} from "@/lib/opportunity/outreachPlanShape";

const BTN = "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50";
const CHANNEL_ICON: Record<PlanChannel, typeof Mail> = { research: Search, email: Mail, call: Phone, voicemail: Voicemail, text: Smartphone, linkedin: Contact };

function Copyable({ text }: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className="max-h-none overflow-x-auto whitespace-pre-wrap rounded border border-border bg-[var(--row-hover)]/40 p-3 pr-16 font-mono text-[12.5px] leading-relaxed text-foreground">{text}</pre>
      <button
        type="button"
        onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* blocked */ } }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"
      >
        {done ? <Check className="size-3 text-positive" /> : <Copy className="size-3" />} {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function OutreachPlanView({ opportunityId }: { opportunityId: string }): React.JSX.Element {
  const [plan, setPlan] = useState<OutreachPlan | null>(null);
  const [scripts, setScripts] = useState<Record<string, string | null>>({});
  const [aiScripts, setAiScripts] = useState(false);
  const [state, setState] = useState<PlanState>(emptyPlanState);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [refining, setRefining] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/radar/outreach-plan/${opportunityId}`)
      .then((r) => r.json())
      .then((j: { plan?: OutreachPlan; state?: PlanState; error?: string }) => {
        if (!j.plan) { setError("Could not load the plan for this opportunity."); return; }
        setPlan(j.plan);
        setScripts(Object.fromEntries(j.plan.steps.map((s) => [s.id, s.script])));
        const st = j.state ?? emptyPlanState();
        setState(st);
        setNotes(st.notes);
      })
      .catch(() => setError("Could not load the plan for this opportunity."))
      .finally(() => setLoading(false));
  }, [opportunityId]);

  const persist = useCallback(async (patch: { status?: PlanStatus; done?: Record<string, boolean>; notes?: string }) => {
    await fetch(`/api/radar/outreach-plan/${opportunityId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "save", state: patch }),
    });
  }, [opportunityId]);

  const toggleStep = (stepId: string, next: boolean) => {
    const done = { ...state.done, [stepId]: next };
    setState((prev) => ({ ...prev, done }));
    void persist({ done });
  };
  const setStatus = (status: PlanStatus) => {
    setState((prev) => ({ ...prev, status }));
    void persist({ status });
  };
  async function saveNotes() {
    setSavingNotes(true);
    try { await persist({ notes }); setState((prev) => ({ ...prev, notes })); } finally { setSavingNotes(false); }
  }

  async function refine() {
    setRefining(true);
    setError(null);
    try {
      const r = await fetch(`/api/radar/outreach-plan/${opportunityId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "refine" }) });
      const j = (await r.json()) as { refined?: { steps: { id: string; script: string }[]; source: string } };
      if (j.refined) {
        setScripts((prev) => { const next = { ...prev }; for (const s of j.refined!.steps) next[s.id] = s.script; return next; });
        setAiScripts(j.refined.source === "ai");
      }
    } catch { setError("Could not refine the scripts. They are unchanged."); } finally { setRefining(false); }
  }

  if (loading) return <main className="max-w-[860px] p-6"><div className="flex items-center gap-2 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" /> Building your plan…</div></main>;
  if (error && !plan) return <main className="max-w-[860px] p-6 text-[13px] text-meta">{error}</main>;
  if (!plan) return <main className="max-w-[860px] p-6" />;

  const total = plan.steps.length;
  const doneCount = plan.steps.filter((s) => state.done[s.id]).length;

  return (
    <main className="max-w-[860px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <Link href="/radar" className="hover:text-foreground">Opportunity Radar</Link> /{" "}
        <Link href={`/radar/${opportunityId}`} className="hover:text-foreground">{plan.opportunityName}</Link> / Outreach plan
      </div>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="mb-1 flex items-center gap-2 text-[22px] font-medium tracking-tight"><Compass className="size-5 text-meta" /> Outreach plan</h1>
          <p className="text-[13px] text-meta">A step-by-step guide to reach <span className="text-foreground">{plan.targetName}</span> and earn a quote. Follow it in order.</p>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-meta">Where you&apos;re at
          <select value={state.status} onChange={(e) => setStatus(e.target.value as PlanStatus)} className="rounded border border-border bg-background px-2 py-1 text-[12.5px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {PLAN_STATUS_ORDER.map((s) => <option key={s} value={s}>{PLAN_STATUS_LABEL[s]}</option>)}
          </select>
        </label>
      </header>

      {/* Strategy */}
      <section className="mb-6 rounded border border-border p-4">
        <div className="mb-2 text-[13px] font-medium text-foreground">{plan.strategyHeadline}</div>
        <div className="grid gap-2 text-[12.5px] text-tertiary-text sm:grid-cols-2">
          <p><span className="text-meta">The angle: </span>{plan.angle}</p>
          <p><span className="text-meta">Why now: </span>{plan.whyNow}</p>
          <p className="sm:col-span-2"><span className="text-meta">How to reach out: </span>{plan.channelPlan}</p>
          <p className="sm:col-span-2"><span className="text-meta">Who: </span>{plan.targetName} <span className="text-meta">({plan.targetLabel})</span>{!plan.hasContact && <span className="text-attention"> — no contact on file yet, so step one is finding them.</span>}</p>
        </div>
      </section>

      {/* Progress + refine */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-[var(--bar)]"><div className="h-full rounded-full bg-positive transition-all" style={{ width: `${total ? Math.round((doneCount / total) * 100) : 0}%` }} /></div>
          <span className="text-[12px] text-meta">{doneCount}/{total} steps</span>
        </div>
        {plan.aiAvailable && (
          <button onClick={refine} disabled={refining} className={BTN}>{refining ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {aiScripts ? "Scripts refined" : "Warm up the scripts"}</button>
        )}
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {plan.steps.map((step) => <StepCard key={step.id} step={step} script={scripts[step.id] ?? step.script} done={!!state.done[step.id]} onToggle={(v) => toggleStep(step.id, v)} />)}
      </div>

      {/* Objections */}
      <section className="mt-8">
        <h2 className="mb-2 flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text"><MessageSquareWarning className="size-4" /> If they push back</h2>
        <p className="mb-3 text-[12.5px] text-meta">The five things you&apos;ll hear most, and exactly what to say. Read these once before you reach out.</p>
        <div className="space-y-2">
          {plan.objections.map((o) => (
            <details key={o.id} className="rounded border border-border">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[13px] text-foreground">
                <span>&ldquo;{o.trigger}&rdquo;</span>
                <ChevronDown className="size-4 shrink-0 text-meta transition-transform [details[open]_&]:rotate-180" />
              </summary>
              <div className="border-t border-[var(--row-rule)] px-3 py-2.5 text-[12.5px]">
                <p className="text-foreground"><span className="text-meta">You say: </span>{o.response}</p>
                <p className="mt-1 text-[11.5px] text-meta">Why it works: {o.why}</p>
              </div>
            </details>
          ))}
        </div>
      </section>

      {/* Notes */}
      <section className="mt-8">
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Your notes</h2>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="What happened, who you talked to, next step…" className="w-full rounded border border-border bg-background p-3 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
        <div className="mt-2 flex items-center gap-3">
          <button onClick={saveNotes} disabled={savingNotes} className={BTN + " border-foreground text-foreground"}>{savingNotes ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save notes</button>
          {error && <span className="text-[12px] text-critical">{error}</span>}
        </div>
      </section>
    </main>
  );
}

function StepCard({ step, script, done, onToggle }: { step: PlanStep; script: string | null; done: boolean; onToggle: (v: boolean) => void }): React.JSX.Element {
  const Icon = CHANNEL_ICON[step.channel];
  return (
    <div className={`rounded border p-4 ${done ? "border-positive/30 bg-positive/[0.03]" : "border-border"}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={done} onChange={(e) => onToggle(e.target.checked)} className="mt-1 size-4 shrink-0 accent-foreground" title="Mark done" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[14px] font-medium ${done ? "text-meta line-through" : "text-foreground"}`}>{step.title}</span>
            <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-px text-[10.5px] uppercase tracking-[0.05em] text-meta"><Icon className="size-3" /> {PLAN_CHANNEL_LABEL[step.channel]}</span>
            <span className="text-[11px] text-meta">{step.when}</span>
          </div>
          <p className="mt-1 text-[12.5px] text-tertiary-text">{step.goal}</p>

          {step.actions.length > 0 && (
            <ul className="mt-2 space-y-1 text-[12.5px] text-foreground">
              {step.actions.map((a, i) => <li key={i} className="flex gap-2"><span className="text-meta">•</span> {a}</li>)}
            </ul>
          )}

          {script && <div className="mt-3"><Copyable text={script} /></div>}

          {step.coaching.length > 0 && (
            <div className="mt-3 rounded border border-attention/25 bg-attention/[0.04] px-3 py-2">
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-attention">Coaching</div>
              <ul className="space-y-1 text-[12px] text-tertiary-text">
                {step.coaching.map((c, i) => <li key={i} className="flex gap-2"><span className="text-attention">›</span> {c}</li>)}
              </ul>
            </div>
          )}

          <p className="mt-2 text-[11.5px] text-meta"><span className="text-positive">Done when:</span> {step.successSignal}</p>
        </div>
      </div>
    </div>
  );
}
