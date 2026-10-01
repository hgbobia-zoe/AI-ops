"use client";

// SEO opportunity detail — the card body shown inside the shared SidePanelOverlay. Fetches the full
// opportunity (evidence + recommendation + priority breakdown + decision history), and offers the
// opportunity-approval gate (Approve / Defer / Reject → stage + history) plus a guarded stage move. FACTS
// ONLY: absent metrics render as "Unknown", never 0.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, ExternalLink, Check, Clock, Ban, Loader2 } from "lucide-react";
import { STAGE_META } from "@/lib/seo/stages";
import type { SeoOpportunity, SeoStage } from "@/lib/seo/types";

interface Detail {
  opportunity: SeoOpportunity;
  history: { from: string | null; to: string; actor: string | null; note: string | null; ts: string }[];
  nextStages: SeoStage[];
}

const ACTION_TONE: Record<string, string> = {
  CREATE: "text-[color:var(--positive,#16a34a)]",
  IMPROVE: "text-attention",
  CONSOLIDATE: "text-foreground",
  SKIP: "text-meta",
};

function priorityTone(n: number | null): string {
  if (n == null) return "text-meta";
  if (n >= 70) return "text-critical";
  if (n >= 40) return "text-attention";
  return "text-meta";
}

function metricRow(label: string, v: number | undefined, suffix = ""): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1 text-[12.5px]">
      <span className="text-meta">{label}</span>
      <span className={v == null ? "text-meta" : "tabular-nums text-foreground"}>{v == null ? "Unknown" : `${v.toLocaleString("en-US")}${suffix}`}</span>
    </div>
  );
}

export function SeoOpportunityPanel({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/seo/opportunity/${id}`);
      if (!r.ok) throw new Error("not found");
      setD((await r.json()) as Detail);
    } catch {
      setErr("Could not load this opportunity.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(bodyObj: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/seo/opportunity/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyObj) });
      const data = (await r.json()) as Detail & { error?: string };
      if (!r.ok) {
        setErr(data.error === "invalid transition" || data.error?.startsWith("invalid") ? data.error : data.error ?? "Action failed.");
        return;
      }
      setD(data);
      router.refresh();
    } catch {
      setErr("Action failed — network error.");
    } finally {
      setBusy(false);
    }
  }

  const o = d?.opportunity;

  return (
    <div className="flex h-full flex-col bg-panel">
      <header className="flex items-start gap-3 border-b border-[var(--row-rule)] p-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.08em] text-meta">SEO opportunity</div>
          <h2 className="truncate text-[17px] font-medium text-foreground">{o?.keyword ?? "…"}</h2>
          {o && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-meta">
              <span className="rounded border border-border px-1.5 py-0.5">{STAGE_META[o.stage]?.label ?? o.stage}</span>
              <span>{o.intent}</span>
              {o.category && <span>· {o.category}</span>}
              {o.location && <span>· {o.location}</span>}
            </div>
          )}
        </div>
        <button onClick={onClose} className="shrink-0 rounded p-1 text-meta transition-colors hover:text-foreground" aria-label="Close">
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading && (
          <div className="flex items-center gap-2 text-[13px] text-meta">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
        {err && <div className="mb-3 rounded border border-critical/30 bg-critical/10 p-2 text-[12.5px] text-critical">{err}</div>}

        {o && (
          <div className="space-y-5">
            {/* Recommendation */}
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Recommendation</h3>
              {o.recommendedAction ? (
                <div className="rounded border border-border p-3">
                  <div className="flex items-center gap-2">
                    <span className={`text-[14px] font-medium ${ACTION_TONE[o.recommendedAction] ?? "text-foreground"}`}>{o.recommendedAction}</span>
                    {o.matchedUrl && (
                      <a href={o.matchedUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] text-meta hover:text-foreground">
                        {o.matchedUrl.replace(/^https?:\/\/[^/]+/, "") || o.matchedUrl} <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  {o.explanation && <p className="mt-2 text-[12.5px] leading-relaxed text-tertiary-text">{o.explanation}</p>}
                </div>
              ) : (
                <p className="text-[12.5px] text-meta">Not analyzed yet.</p>
              )}
            </section>

            {/* Priority breakdown */}
            <section>
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Priority</h3>
                <span className={`text-[18px] font-medium tabular-nums ${priorityTone(o.priority)}`}>{o.priority ?? "—"}</span>
              </div>
              {o.priorityBreakdown ? (
                <div className="space-y-1.5">
                  {o.priorityBreakdown.components.map((c) => (
                    <div key={c.key} className="text-[12px]">
                      <div className="flex items-center justify-between">
                        <span className="text-secondary-text">{c.label}{c.unknown && <span className="ml-1 text-meta">(unknown)</span>}</span>
                        <span className="tabular-nums text-meta">{c.score}</span>
                      </div>
                      <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-[var(--row-rule)]">
                        <div className="h-full bg-[var(--bar,#888)]" style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} />
                      </div>
                      <p className="mt-0.5 text-[11px] text-meta">{c.evidence}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[12.5px] text-meta">No priority computed yet.</p>
              )}
            </section>

            {/* Evidence (facts only) */}
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Evidence</h3>
              <div className="rounded border border-border p-3">
                <div className="text-[11px] uppercase tracking-[0.06em] text-meta">Ubersuggest metrics {o.metricsSource === "none" && "(none pulled)"}</div>
                <div className="mt-1 divide-y divide-[var(--row-rule)]">
                  {metricRow("Volume / mo", o.metrics?.volume)}
                  {metricRow("Difficulty", o.metrics?.difficulty)}
                  {metricRow("Paid difficulty", o.metrics?.paidDifficulty)}
                  {metricRow("CPC", o.metrics?.cpc, " USD")}
                </div>
                {o.relatedKeywords.length > 0 && (
                  <div className="mt-2 border-t border-[var(--row-rule)] pt-2">
                    <div className="text-[11px] uppercase tracking-[0.06em] text-meta">Related keywords</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {o.relatedKeywords.slice(0, 12).map((k) => (
                        <span key={k} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-secondary-text">{k}</span>
                      ))}
                    </div>
                  </div>
                )}
                {o.competitorRefs.length > 0 && (
                  <div className="mt-2 border-t border-[var(--row-rule)] pt-2">
                    <div className="text-[11px] uppercase tracking-[0.06em] text-meta">Competitors ranking</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {o.competitorRefs.slice(0, 10).map((c) => (
                        <span key={c} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-secondary-text">{c}</span>
                      ))}
                    </div>
                  </div>
                )}
                <p className="mt-2 text-[11px] text-meta">{o.researchAt ? `Pulled ${o.researchAt.slice(0, 16).replace("T", " ")}` : "No Ubersuggest data pulled yet — metrics are Unknown, not zero."}</p>
              </div>
            </section>

            {/* Decision gate #1 */}
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Decision (approval gate 1 of 3)</h3>
              <div className="flex flex-wrap gap-2">
                <button disabled={busy} onClick={() => void act({ op: "decision", decision: "approve" })} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50">
                  <Check className="size-3.5" /> Approve
                </button>
                <button disabled={busy} onClick={() => void act({ op: "decision", decision: "defer" })} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50">
                  <Clock className="size-3.5" /> Defer
                </button>
                <button disabled={busy} onClick={() => void act({ op: "decision", decision: "reject" })} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50">
                  <Ban className="size-3.5" /> Reject
                </button>
              </div>
              {d.nextStages.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-meta">Move to:</span>
                  {d.nextStages.map((st) => (
                    <button key={st} disabled={busy} onClick={() => void act({ op: "stage", stage: st })} className="rounded border border-border px-2 py-0.5 text-[11px] text-secondary-text transition-colors hover:bg-[var(--row-hover)] disabled:opacity-50">
                      {STAGE_META[st]?.label ?? st}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Decision history */}
            <section>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Decision history</h3>
              <div className="rounded border border-border">
                {d.history.length === 0 ? (
                  <p className="p-3 text-[12px] text-meta">No history yet.</p>
                ) : (
                  d.history.map((h, i) => (
                    <div key={i} className="flex items-center gap-2 border-t border-[var(--row-rule)] px-3 py-1.5 text-[12px] first:border-t-0">
                      <span className="text-foreground">{h.from ? `${h.from} → ` : ""}{h.to}</span>
                      {h.actor && <span className="text-meta">· {h.actor}</span>}
                      <span className="ml-auto shrink-0 tabular-nums text-[11px] text-meta">{h.ts.slice(0, 16).replace("T", " ")}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
