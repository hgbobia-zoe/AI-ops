"use client";

// Opportunity Radar — AI interpretation panel. Shows a plain-language summary, why it's relevant, and
// research actions. Generated on demand (deterministic floor + optional LLM refine); the method is
// labelled honestly. Cached server-side so it isn't re-billed.

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

interface Summary {
  summary: string;
  whyRelevant: string;
  researchActions: string[];
  method: "llm" | "template";
  model?: string;
}

export function OpportunityInterpret({ id, initial }: { id: string; initial: Summary | null }) {
  const [summary, setSummary] = useState<Summary | null>(initial);
  const [busy, setBusy] = useState(false);

  async function generate(force: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/opportunity/interpret", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, force }) });
      const data = (await res.json()) as { summary?: Summary };
      if (!res.ok || !data.summary) throw new Error();
      setSummary(data.summary);
    } catch {
      toast.error("Could not generate the interpretation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-border p-3 text-[13px]">
      {summary ? (
        <>
          <p className="text-secondary-text">{summary.summary}</p>
          <p className="mt-1.5 text-meta"><span className="text-tertiary-text">Why relevant:</span> {summary.whyRelevant}</p>
          {summary.researchActions.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {summary.researchActions.map((a, i) => <li key={i} className="text-tertiary-text">□ {a}</li>)}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-2 border-t border-[var(--row-rule)] pt-2 text-[11px] text-meta">
            <span>{summary.method === "llm" ? `AI-interpreted${summary.model ? ` · ${summary.model}` : ""}` : "Deterministic summary (no LLM configured)"}</span>
            <button onClick={() => generate(true)} disabled={busy} className="ml-auto text-tertiary-text hover:text-foreground disabled:opacity-50">{busy ? "…" : "Regenerate"}</button>
          </div>
        </>
      ) : (
        <button onClick={() => generate(false)} disabled={busy} className="inline-flex items-center gap-2 rounded border border-border px-2.5 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50">
          <Sparkles className="size-3.5" /> {busy ? "Generating…" : "Interpret this opportunity"}
        </button>
      )}
    </div>
  );
}
