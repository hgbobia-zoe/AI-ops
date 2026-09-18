"use client";

// Pursue workspace — work one radar opportunity into a review-ready bid. The system pre-stages
// everything (a tailored capability statement, a response letter, a submission checklist, readiness
// gaps) from the Zoe capability profile + the opportunity's facts; a HUMAN reviews, edits, and submits.
// Nothing is auto-submitted. "Submit" here only records that a person submitted the bid externally.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Copy, Check, Sparkles, Loader2, Save, Send, AlertTriangle, FileText } from "lucide-react";
import {
  PURSUIT_STATUS_LABEL,
  PURSUIT_STATUS_ORDER,
  emptyPursuitState,
  itemDone,
  type BidPackage,
  type PursuitState,
  type PursuitStatus,
} from "@/lib/pursuit/bidPackageShape";

const BTN = "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50";
const AREA = "w-full rounded border border-border bg-background p-3 text-[13px] leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
        {title}
        {note && <span className="ml-2 text-[11px] normal-case tracking-normal text-meta">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={BTN}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
    >
      {done ? <Check className="size-3.5 text-positive" /> : <Copy className="size-3.5" />} {done ? "Copied" : "Copy"}
    </button>
  );
}

export function PursueWorkspace({ opportunityId }: { opportunityId: string }): React.JSX.Element {
  const [pkg, setPkg] = useState<BidPackage | null>(null);
  const [state, setState] = useState<PursuitState>(emptyPursuitState);
  const [statement, setStatement] = useState("");
  const [response, setResponse] = useState("");
  const [narrativeSource, setNarrativeSource] = useState<"template" | "ai">("template");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refining, setRefining] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/pursuit/opportunity/${opportunityId}`)
      .then((r) => r.json())
      .then((j: { package?: BidPackage; state?: PursuitState; error?: string }) => {
        if (!j.package) {
          setError(j.error === "forbidden" ? "You don't have access to bid pursuit." : "Could not load this opportunity.");
          return;
        }
        setPkg(j.package);
        const st = j.state ?? emptyPursuitState();
        setState(st);
        setStatement(st.statementOverride ?? j.package.capabilityStatement);
        setResponse(st.responseOverride ?? j.package.responseLetter);
      })
      .catch(() => setError("Could not load this opportunity."))
      .finally(() => setLoading(false));
  }, [opportunityId]);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSavedTick(false);
  }, []);

  const toggleItem = (itemId: string, next: boolean) => {
    setState((prev) => ({ ...prev, checklistDone: { ...prev.checklistDone, [itemId]: next } }));
    markDirty();
  };

  async function refine() {
    setRefining(true);
    setError(null);
    try {
      const r = await fetch(`/api/pursuit/opportunity/${opportunityId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "refine" }),
      });
      const j = (await r.json()) as { refined?: { capabilityStatement: string; responseLetter: string; narrativeSource: "template" | "ai" }; error?: string };
      if (!r.ok || !j.refined) {
        setError("Could not refine. The draft is unchanged.");
        return;
      }
      setStatement(j.refined.capabilityStatement);
      setResponse(j.refined.responseLetter);
      setNarrativeSource(j.refined.narrativeSource);
      markDirty();
    } catch {
      setError("Could not refine. The draft is unchanged.");
    } finally {
      setRefining(false);
    }
  }

  async function save(status?: PursuitStatus) {
    if (!pkg) return;
    setSaving(true);
    setError(null);
    // Only persist an override when the text differs from the freshly generated draft (so future
    // profile edits keep flowing through until a human intentionally edits).
    const statementOverride = statement.trim() === pkg.capabilityStatement.trim() ? null : statement;
    const responseOverride = response.trim() === pkg.responseLetter.trim() ? null : response;
    const payload = {
      status: status ?? state.status,
      statementOverride,
      responseOverride,
      checklistDone: state.checklistDone,
      portalUrl: state.portalUrl,
      notes: state.notes,
    };
    try {
      const r = await fetch(`/api/pursuit/opportunity/${opportunityId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "save", state: payload }),
      });
      const j = (await r.json()) as { ok?: boolean; state?: PursuitState; error?: string };
      if (!r.ok || !j.state) {
        setError("Could not save. Try again.");
        return;
      }
      setState(j.state);
      setDirty(false);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2000);
    } catch {
      setError("Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function markSubmitted() {
    const ok = window.confirm("Record this bid as submitted? Zoe does not submit for you — do this only after you have submitted the bid yourself through the agency's portal.");
    if (ok) void save("SUBMITTED");
  }

  if (loading) {
    return (
      <main className="max-w-[1000px] p-6">
        <div className="flex items-center gap-2 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" /> Loading bid workspace…</div>
      </main>
    );
  }
  if (error && !pkg) {
    return <main className="max-w-[1000px] p-6 text-[13px] text-meta">{error}</main>;
  }
  if (!pkg) return <main className="max-w-[1000px] p-6" />;

  const blockers = pkg.checklist.filter((i) => i.kind === "blocker" && !itemDone(i, state));

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <Link href="/radar" className="hover:text-foreground">Opportunity Radar</Link> /{" "}
        <Link href={`/radar/${opportunityId}`} className="hover:text-foreground">{pkg.opportunityName}</Link> / Pursue
      </div>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="mb-1 flex items-center gap-2 text-[22px] font-medium tracking-tight"><FileText className="size-5 text-meta" /> Pursue this bid</h1>
          <p className="text-[13px] text-meta">
            {pkg.opportunityName} · {pkg.jurisdictionLabel}
            {pkg.buyer ? ` · ${pkg.buyer}` : ""}
            {pkg.deadline ? ` · due ${pkg.deadline}` : " · no deadline on file"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <label className="flex items-center gap-2 text-[12px] text-meta">
            Status
            <select
              value={state.status}
              onChange={(e) => { setState((prev) => ({ ...prev, status: e.target.value as PursuitStatus })); markDirty(); }}
              className="rounded border border-border bg-background px-2 py-1 text-[12.5px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {PURSUIT_STATUS_ORDER.map((s) => <option key={s} value={s}>{PURSUIT_STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          {pkg.sourceUrl && (
            <a href={pkg.sourceUrl} target="_blank" rel="noopener noreferrer" className={BTN}>Open solicitation <ExternalLink className="size-3.5" /></a>
          )}
        </div>
      </header>

      {state.submittedAt && (
        <div className="mb-6 rounded border border-positive/40 bg-positive/[0.06] px-3 py-2 text-[12.5px] text-positive">
          Recorded as submitted{state.submittedBy ? ` by ${state.submittedBy}` : ""} on {new Date(state.submittedAt).toLocaleDateString()}.
        </div>
      )}

      {/* Readiness gaps */}
      {pkg.gaps.length > 0 && (
        <Section title="Before you bid" note="honest gaps — the package still generates, but fix these for a stronger bid">
          <ul className="space-y-1.5 rounded border border-attention/30 bg-attention/[0.04] p-3 text-[12.5px]">
            {pkg.gaps.map((g, i) => (
              <li key={i} className="flex items-start gap-2 text-tertiary-text">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-attention" /> {g}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Narrative */}
      <Section
        title="Capability statement"
        note={narrativeSource === "ai" ? "AI-refined from your facts — review before use" : "assembled from your Capability Profile — facts only"}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <CopyButton text={statement} />
          {pkg.aiAvailable && (
            <button type="button" className={BTN} onClick={refine} disabled={refining}>
              {refining ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {refining ? "Refining…" : "Refine with AI"}
            </button>
          )}
          <span className="text-[11.5px] text-meta">Profile {Math.round(pkg.profileCompleteness * 100)}% complete</span>
        </div>
        <textarea
          value={statement}
          onChange={(e) => { setStatement(e.target.value); markDirty(); }}
          rows={18}
          className={AREA + " font-mono"}
          spellCheck
        />
      </Section>

      <Section title="Response letter" note="a short statement of interest to the buyer — edit and send yourself">
        <div className="mb-2 flex items-center gap-2"><CopyButton text={response} /></div>
        <textarea
          value={response}
          onChange={(e) => { setResponse(e.target.value); markDirty(); }}
          rows={12}
          className={AREA}
          spellCheck
        />
      </Section>

      {/* Checklist */}
      <Section title="Submission checklist" note="a person completes and submits every bid — Zoe never auto-submits">
        {blockers.length > 0 && (
          <p className="mb-2 text-[12px] text-attention">{blockers.length} blocker{blockers.length === 1 ? "" : "s"} outstanding before this bid is submittable.</p>
        )}
        <ul className="rounded border border-border">
          {pkg.checklist.map((item) => {
            const done = itemDone(item, state);
            return (
              <li key={item.id} className="flex items-start gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 text-[13px] first:border-t-0">
                <input
                  type="checkbox"
                  checked={done}
                  onChange={(e) => toggleItem(item.id, e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-foreground"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={done ? "text-meta line-through" : "text-foreground"}>{item.label}</span>
                    {item.kind === "blocker" && !done && <span className="rounded border border-critical/40 px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.05em] text-critical">Blocker</span>}
                  </div>
                  {item.detail && <div className="mt-0.5 break-words text-[11.5px] text-meta">{item.detail}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* Submission notes */}
      <Section title="Submission details">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-[12px] text-meta">Where you&apos;ll submit (portal / email)</span>
            <input
              value={state.portalUrl}
              onChange={(e) => { setState((prev) => ({ ...prev, portalUrl: e.target.value })); markDirty(); }}
              placeholder={pkg.sourceUrl ?? "portal URL or email"}
              className="w-full rounded border border-border bg-background px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-[12px] text-meta">Notes</span>
            <textarea
              value={state.notes}
              onChange={(e) => { setState((prev) => ({ ...prev, notes: e.target.value })); markDirty(); }}
              rows={3}
              className={AREA}
            />
          </label>
        </div>
      </Section>

      {/* Save bar */}
      <div className="sticky bottom-0 -mx-6 flex flex-wrap items-center gap-3 border-t border-border bg-background/90 px-6 py-3 backdrop-blur">
        <button onClick={() => save()} disabled={saving} className={BTN + " border-foreground text-foreground"}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={markSubmitted} disabled={saving} className={BTN}>
          <Send className="size-3.5" /> Mark submitted
        </button>
        {dirty && !savedTick && <span className="text-[12px] text-meta">Unsaved changes</span>}
        {savedTick && <span className="text-[12px] text-positive">Saved</span>}
        {error && <span className="text-[12px] text-critical">{error}</span>}
      </div>
    </main>
  );
}
