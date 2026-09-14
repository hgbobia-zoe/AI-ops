"use client";

// Ask-the-sale panel: the rep queries this lead ("how should I answer this?", questions about the
// project) and gets AI help grounded in the lead's own context. Advice only — nothing sends.

import { useState } from "react";
import { Search, Loader2, Sparkles, CornerDownLeft } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";

interface QA { q: string; a: string | null; error?: string }

const SUGGESTIONS = ["How should I answer their last message?", "What's the best next step here?", "Draft a friendly follow-up text", "What objection should I expect?"];

export function LeadAsk({ id }: { id: string }): React.JSX.Element {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<QA[]>([]);

  const ask = async (question: string): Promise<void> => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setQ("");
    setHistory((h) => [...h, { q: text, a: null }]);
    try {
      const r = await fetch("/api/salesos/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, question: text }) });
      const j = (await r.json().catch(() => ({}))) as { answer?: string; error?: string };
      setHistory((h) => h.map((qa, i) => (i === h.length - 1 ? { ...qa, a: j.answer ?? null, error: j.error } : qa)));
    } catch {
      setHistory((h) => h.map((qa, i) => (i === h.length - 1 ? { ...qa, a: null, error: "Couldn't reach the AI." } : qa)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><Sparkles className="size-3.5" /> Ask about this sale</div>

      {history.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={busy} className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50">{s}</button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {history.map((qa, i) => (
          <div key={i} className="space-y-2">
            <div className="flex justify-end"><div className="max-w-[85%] rounded-2xl rounded-tr-sm border border-sky-500/30 bg-sky-500/[0.12] px-3 py-2 text-sm">{qa.q}</div></div>
            <div className="flex justify-start">
              <div className="max-w-[92%] rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.04] px-3 py-2 text-sm">
                {qa.a == null && !qa.error ? (
                  <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Thinking…</span>
                ) : qa.error ? (
                  <span className="text-amber-300">{qa.error}</span>
                ) : (
                  <>
                    <div className="whitespace-pre-wrap leading-relaxed">{qa.a}</div>
                    {qa.a && <div className="mt-2"><CopyButton text={qa.a} /></div>}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="flex items-end gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-white/15 bg-white/[0.02] px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask how to answer, or anything about this project…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        </div>
        <button type="submit" disabled={busy || !q.trim()} className="btn-hero flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <CornerDownLeft className="size-4" />} Ask
        </button>
      </form>
      <p className="text-[11px] text-muted-foreground">AI help grounded in this lead — review before acting; it never sends anything.</p>
    </div>
  );
}
