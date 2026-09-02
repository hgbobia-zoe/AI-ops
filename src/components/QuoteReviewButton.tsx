"use client";

// On-demand quote review: runs the free deterministic crew rules + (if a model is set)
// an LLM risk pass via /api/quote-review. On-demand so we don't spend tokens on every
// page render — only when someone asks.

import { useState } from "react";
import { Sparkles, Loader2, AlertTriangle, Users } from "lucide-react";

interface LineItem {
  name: string;
  quantity?: number;
}
interface Review {
  crew: number;
  crewReasons: string[];
  hasTent: boolean;
  llm: { risks: string[]; notes: string } | null;
  llmError?: string;
  llmModel?: string;
}

export function QuoteReviewButton({ items, eventName }: { items: LineItem[]; eventName?: string }) {
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/quote-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, eventName }),
      });
      if (!r.ok) {
        setError(`Review failed (${r.status})`);
        return;
      }
      setReview((await r.json()) as Review);
    } catch {
      setError("Review failed — network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={loading}
        className="inline-flex items-center gap-1.5 border border-white/15 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        {review ? "Re-review" : "Review quote"}
      </button>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {review && (
        <div className="space-y-2 border border-white/10 bg-white/[0.02] p-3 text-sm">
          <div className="flex items-center gap-1.5 font-medium">
            <Users className="size-3.5 text-muted-foreground" />
            Crew: {review.crew}
            {review.crewReasons.length > 0 && (
              <span className="text-xs text-muted-foreground">({review.crewReasons.join("; ")})</span>
            )}
          </div>

          {review.llm ? (
            <>
              {review.llm.risks.length > 0 ? (
                <ul className="space-y-1">
                  {review.llm.risks.map((risk, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-amber-200">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span>{risk}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-xs text-emerald-300">No risks flagged by the model.</div>
              )}
              {review.llm.notes && <div className="text-xs text-muted-foreground">{review.llm.notes}</div>}
            </>
          ) : (
            <div className="text-xs text-muted-foreground">
              {review.llmError ? `Model unavailable (${review.llmError}) — showed rules only.` : "No model configured — rules only."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
