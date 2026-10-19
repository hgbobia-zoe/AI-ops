"use client";

// SEO page-draft detail — the preview + quality report + review gate, shown inside the shared SidePanelOverlay.
// Fetches the full draft (/api/seo/draft/[id]), renders the structured preview (sourced facts vs [NEEDS REVIEW]
// markers kept visually distinct), the deterministic quality findings, and the human review actions (submit /
// approve / reject / reopen). NOTHING here publishes a page — the furthest an approval goes is "cleared to
// publish", a separate authorized step outside this engine.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Check, Ban, Send, RotateCcw, Loader2, AlertTriangle, AlertCircle, Info, FileText } from "lucide-react";
import type { PageDraft, SeoQualityReport, SeoQualityFinding } from "@/lib/seo/types";

interface Detail {
  draft: PageDraft;
  quality: SeoQualityReport;
  opportunity: { keyword: string; stage: string } | null;
  error?: string;
}

const STATE_TONE: Record<string, string> = {
  DRAFT: "text-meta",
  IN_REVIEW: "text-attention",
  APPROVED: "text-[color:var(--positive,#16a34a)]",
  REJECTED: "text-critical",
};

const REVIEW_SPLIT = /(\[NEEDS REVIEW:[^\]]*\])/g;

function renderParagraph(p: string, i: number): React.JSX.Element {
  // Keep [NEEDS REVIEW: …] markers visually distinct from sourced copy.
  const parts = p.split(REVIEW_SPLIT);
  return (
    <p key={i} className="text-[12.5px] leading-relaxed text-secondary-text">
      {parts.map((part, j) =>
        part.startsWith("[NEEDS REVIEW:") ? (
          <mark key={j} className="rounded bg-attention/15 px-1 text-[12px] text-attention">{part}</mark>
        ) : (
          <span key={j}>{part}</span>
        ),
      )}
    </p>
  );
}

function FindingRow({ f }: { f: SeoQualityFinding }): React.JSX.Element {
  const Icon = f.severity === "error" ? AlertCircle : f.severity === "warn" ? AlertTriangle : Info;
  const tone = f.severity === "error" ? "text-critical" : f.severity === "warn" ? "text-attention" : "text-meta";
  return (
    <div className="flex items-start gap-2 border-t border-[var(--row-rule)] px-3 py-1.5 text-[12px] first:border-t-0">
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${tone}`} />
      <div className="min-w-0">
        <span className="text-foreground">{f.message}</span>
        <span className="ml-1 text-meta">· {f.category}</span>
      </div>
    </div>
  );
}

export function SeoDraftPanel({ draftId, onClose }: { draftId: string; onClose: () => void }): React.JSX.Element {
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/seo/draft/${draftId}`);
      if (!r.ok) throw new Error("not found");
      setD((await r.json()) as Detail);
    } catch {
      setErr("Could not load this draft.");
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(op: string): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/seo/draft/${draftId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, note: note || null }) });
      const data = (await r.json()) as Detail;
      if (!r.ok) {
        setErr(data.error ?? "Action failed.");
        return;
      }
      setD(data);
      setNote("");
      router.refresh();
    } catch {
      setErr("Action failed — network error.");
    } finally {
      setBusy(false);
    }
  }

  const draft = d?.draft;
  const q = d?.quality;

  return (
    <div className="flex h-full flex-col bg-panel">
      <header className="flex items-start gap-3 border-b border-[var(--row-rule)] p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-meta"><FileText className="size-3.5" /> Page draft</div>
          <h2 className="truncate text-[17px] font-medium text-foreground">{draft?.h1 ?? "…"}</h2>
          {draft && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-meta">
              <span className={`rounded border border-border px-1.5 py-0.5 ${STATE_TONE[draft.reviewState] ?? ""}`}>{draft.reviewState.replace("_", " ")}</span>
              <span className="font-mono text-[11px]">{draft.slug}</span>
              <span>· {draft.action}</span>
            </div>
          )}
        </div>
        <button onClick={onClose} className="shrink-0 rounded p-1 text-meta transition-colors hover:text-foreground" aria-label="Close"><X className="size-4" /></button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading && <div className="flex items-center gap-2 text-[13px] text-meta"><Loader2 className="size-4 animate-spin" /> Loading…</div>}
        {err && <div className="mb-3 rounded border border-critical/30 bg-critical/10 p-2 text-[12.5px] text-critical">{err}</div>}

        {draft && q && (
          <div className="space-y-5">
            {/* Quality summary */}
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Quality checks</h3>
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className={`rounded border px-2 py-0.5 ${q.passedStructural ? "border-[color:var(--positive,#16a34a)]/40 text-[color:var(--positive,#16a34a)]" : "border-critical/40 text-critical"}`}>
                  {q.passedStructural ? "Structural checks passed" : `${q.errors} error(s)`}
                </span>
                {q.warnings > 0 && <span className="rounded border border-attention/40 px-2 py-0.5 text-attention">{q.warnings} warning(s)</span>}
                <span className="rounded border border-border px-2 py-0.5 text-meta">{q.unsupportedClaims} to verify</span>
              </div>
              <p className="mt-2 text-[11px] text-meta">Automated checks are a reviewer aid, not an auto-publish gate. A human approves every draft; publishing is a separate authorized step.</p>
              {q.findings.length > 0 && (
                <div className="mt-2 rounded border border-border">{q.findings.map((f) => <FindingRow key={f.id + (f.field ?? "")} f={f} />)}</div>
              )}
            </section>

            {/* Preview */}
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Preview</h3>
              <div className="space-y-3 rounded border border-border p-3">
                <div>
                  <div className="text-[10.5px] uppercase tracking-[0.06em] text-meta">Title ({draft.title.length})</div>
                  <div className="text-[13px] text-foreground">{draft.title}</div>
                </div>
                <div>
                  <div className="text-[10.5px] uppercase tracking-[0.06em] text-meta">Meta description ({draft.metaDescription.length})</div>
                  <div className="text-[12.5px] text-secondary-text">{draft.metaDescription}</div>
                </div>
                <div className="border-t border-[var(--row-rule)] pt-2">
                  <h1 className="text-[16px] font-medium text-foreground">{draft.h1}</h1>
                  {draft.body.map((b, i) => (
                    <div key={i} className="mt-3">
                      <div className="flex items-center gap-2">
                        <h2 className="text-[13.5px] font-medium text-foreground">{b.heading}</h2>
                        {b.sourced ? (
                          <span className="rounded bg-[color:var(--positive,#16a34a)]/10 px-1.5 py-0.5 text-[10px] text-[color:var(--positive,#16a34a)]">sourced</span>
                        ) : (
                          <span className="rounded bg-attention/10 px-1.5 py-0.5 text-[10px] text-attention">needs review</span>
                        )}
                      </div>
                      <div className="mt-1 space-y-1">{b.paragraphs.map((p, j) => renderParagraph(p, j))}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Internal links */}
            {draft.internalLinks.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Internal links</h3>
                <div className="flex flex-wrap gap-1.5">
                  {draft.internalLinks.map((l) => (
                    <span key={l.path} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-secondary-text">{l.anchor} <span className="font-mono text-meta">{l.path}</span></span>
                  ))}
                </div>
              </section>
            )}

            {/* Sources / research provenance */}
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Research &amp; sources</h3>
              <div className="rounded border border-border p-3 text-[12px] text-secondary-text">
                <p className="text-meta">{draft.sources.researchNote}</p>
                {draft.templatePath && <p className="mt-1">Template: <span className="font-mono text-meta">{draft.templatePath}</span></p>}
                {draft.sources.competitorRefs.length > 0 && <p className="mt-1">Competitors: {draft.sources.competitorRefs.slice(0, 5).join(", ")}</p>}
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-meta">JSON-LD schema</summary>
                  <pre className="mt-1 overflow-auto rounded bg-[var(--row-hover)] p-2 text-[10.5px] text-secondary-text">{JSON.stringify(draft.schema, null, 2)}</pre>
                </details>
              </div>
            </section>

            {/* Review gate */}
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Review</h3>
              {(draft.reviewState === "IN_REVIEW" || draft.reviewState === "DRAFT") && (
                <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note (recorded in the decision history)…" className="mb-2 w-full rounded border border-border bg-transparent p-2 text-[12.5px] text-foreground" rows={2} />
              )}
              <div className="flex flex-wrap gap-2">
                {draft.reviewState === "DRAFT" && (
                  <button disabled={busy} onClick={() => void act("submit")} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50"><Send className="size-3.5" /> Submit for review</button>
                )}
                {draft.reviewState === "IN_REVIEW" && (
                  <>
                    <button disabled={busy} onClick={() => void act("approve")} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50"><Check className="size-3.5" /> Approve</button>
                    <button disabled={busy} onClick={() => void act("reject")} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50"><Ban className="size-3.5" /> Request changes</button>
                  </>
                )}
                {draft.reviewState === "DRAFT" && (
                  <button disabled={busy} onClick={() => void act("reject")} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50"><Ban className="size-3.5" /> Reject</button>
                )}
                {draft.reviewState === "REJECTED" && (
                  <button disabled={busy} onClick={() => void act("reopen")} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50"><RotateCcw className="size-3.5" /> Reopen to revise</button>
                )}
                {draft.reviewState === "APPROVED" && (
                  <div className="rounded border border-[color:var(--positive,#16a34a)]/40 bg-[color:var(--positive,#16a34a)]/5 px-3 py-2 text-[12px] text-[color:var(--positive,#16a34a)]">
                    Approved and cleared to publish. Publishing is a separate authorized step and is not performed here.
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
