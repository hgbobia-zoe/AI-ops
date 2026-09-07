"use client";

// On-demand outreach drafter for a lead. Click → asks the server for a suggested next message + call
// strategy (LLM-refined against the real Goodshuffle comms history, template fallback). Copy buttons;
// nothing is sent from here — the rep reviews and sends it themselves.

import { useState } from "react";
import { Sparkles, MessageSquare, Phone, Clock, AlertTriangle, Copy, Check } from "lucide-react";

interface Draft {
  sms: string;
  callStrategy: string;
  cadence: string;
  source: "template" | "ai";
  caution: string | null;
}
interface OutreachResult {
  draft: Draft;
  comms: { attempts: number; lastContact: string | null; channels: string[]; noResponse: boolean };
  llmModel?: string;
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className="flex items-center gap-1 border border-white/15 px-2 py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />} {done ? "Copied" : "Copy"}
    </button>
  );
}

export function OutreachPanel({ id }: { id: string }): React.JSX.Element {
  const [result, setResult] = useState<OutreachResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/salesos/outreach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (!res.ok) throw new Error(String(res.status));
      setResult((await res.json()) as OutreachResult);
    } catch {
      setError("Couldn't draft outreach. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="surface mb-4 border border-white/10 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <Sparkles className="size-3.5" /> Suggested outreach
        </div>
        <button onClick={draft} disabled={loading} className="btn-hero px-3 py-1 text-xs disabled:opacity-60">
          {loading ? "Drafting…" : result ? "Redraft" : "Draft message"}
        </button>
      </div>

      {!result && !error && (
        <p className="text-sm text-muted-foreground">Draft a message and call plan for this lead, informed by the prior contact logged in Goodshuffle. You review and send it.</p>
      )}
      {error && <p className="text-sm text-rose-300">{error}</p>}

      {result && (
        <div className="space-y-3">
          {result.draft.caution && (
            <div className="flex items-start gap-2 border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-100">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {result.draft.caution}
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium"><MessageSquare className="size-3.5" /> Text message</span>
              <CopyButton text={result.draft.sms} />
            </div>
            <p className="border border-white/10 bg-white/[0.03] p-2.5 text-sm">{result.draft.sms}</p>
          </div>

          {result.draft.callStrategy && (
            <div>
              <span className="flex items-center gap-1.5 text-xs font-medium"><Phone className="size-3.5" /> Call strategy</span>
              <p className="mt-1 text-sm text-muted-foreground">{result.draft.callStrategy}</p>
            </div>
          )}

          {result.draft.cadence && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3.5" /> When: {result.draft.cadence}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            {result.draft.source === "ai" ? `AI-drafted${result.llmModel ? ` · ${result.llmModel}` : ""}` : "Template"} · reviewed & sent by you.
            {result.comms.attempts > 0 && ` Based on ${result.comms.attempts} logged contact${result.comms.attempts === 1 ? "" : "s"}${result.comms.lastContact ? `, last ${result.comms.lastContact}` : ""}.`}
          </p>
        </div>
      )}
    </section>
  );
}
