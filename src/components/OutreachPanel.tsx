"use client";

// On-demand outreach drafter for a lead. Click → suggested next message + call strategy (LLM-refined
// against the real Goodshuffle comms history, template fallback). The rep can EDIT the text and Send it
// via Quo (OpenPhone) — a per-message human approval + confirm; the send master-switch is server-side.

import { useState, useEffect } from "react";
import { Sparkles, MessageSquare, Phone, Clock, AlertTriangle, Copy, Check, Send, X } from "lucide-react";

interface QuoRep {
  id: string;
  initials: string;
  name: string;
}

interface Draft {
  sms: string;
  callStrategy: string;
  cadence: string;
  source: "template" | "ai";
  caution: string | null;
}
interface OutreachResult {
  draft: Draft;
  clientName: string;
  clientPhone: string;
  canText: boolean;
  comms: { attempts: number; lastContact: string | null; channels: string[]; noResponse: boolean };
  llmModel?: string;
}
type SendState = { status: "idle" | "confirming" | "sending" | "sent" | "error"; message?: string };

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

export function OutreachPanel({ id, viewer }: { id: string; viewer?: { name: string; quoUserId: string | null; initials: string | null } }): React.JSX.Element {
  const [result, setResult] = useState<OutreachResult | null>(null);
  const [smsText, setSmsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [send, setSend] = useState<SendState>({ status: "idle" });
  const [reps, setReps] = useState<QuoRep[]>([]);
  // "Send as" defaults to the logged-in user (their linked Quo number) now that per-person login is on;
  // they can override to another rep. Empty = the shared SalesOS number (only if they're not linked).
  const [sendAs, setSendAs] = useState(viewer?.quoUserId ?? "");
  const viewerLinked = Boolean(viewer?.quoUserId);

  // Load the Quo users once, for the "Send as" picker.
  useEffect(() => {
    let live = true;
    fetch("/api/salesos/quo-users")
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((j: { users?: QuoRep[] }) => {
        if (live) setReps((j.users ?? []).filter((u) => u.initials));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const draft = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setSend({ status: "idle" });
    try {
      const res = await fetch("/api/salesos/outreach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as OutreachResult;
      setResult(data);
      setSmsText(data.draft.sms);
    } catch {
      setError("Couldn't draft outreach. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const doSend = async (): Promise<void> => {
    setSend({ status: "sending" });
    try {
      const edited = !!result && smsText.trim() !== result.draft.sms.trim();
      const res = await fetch("/api/salesos/send-sms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, body: smsText, userId: sendAs || undefined, edited }) });
      const j = (await res.json()) as { ok?: boolean; disabled?: boolean; duplicate?: boolean; message?: string; error?: string };
      if (j.ok) setSend({ status: "sent", message: j.duplicate ? j.message : "Sent via Quo" });
      else setSend({ status: "error", message: j.error ?? "Send failed" });
    } catch {
      setSend({ status: "error", message: "Send failed" });
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
        <p className="text-sm text-muted-foreground">Draft a message and call plan for this lead, informed by the prior contact logged in Goodshuffle. You review, edit, and send.</p>
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
              <span className="flex items-center gap-1.5 text-xs font-medium"><MessageSquare className="size-3.5" /> Text message <span className="font-normal text-muted-foreground">· edit before sending{result.canText ? "" : " · no phone on file"}</span></span>
              <CopyButton text={smsText} />
            </div>
            <textarea
              value={smsText}
              onChange={(e) => { setSmsText(e.target.value); if (send.status !== "idle") setSend({ status: "idle" }); }}
              rows={4}
              className="w-full resize-y border border-white/10 bg-white/[0.03] p-2.5 text-sm outline-none focus:border-white/30"
            />
            <div className="mt-0.5 text-right text-[10px] text-muted-foreground tabular-nums">{smsText.length} chars</div>

            {/* Send via Quo — per-message human approval with an explicit confirm + preview */}
            {result.canText && (() => {
              const selectedRep = reps.find((r) => r.id === sendAs);
              const senderLabel = selectedRep ? `${selectedRep.initials} — ${selectedRep.name}` : viewer?.name ? `${viewer.name} · shared SalesOS number` : "the shared SalesOS number";
              return (
                <div className="mt-1 space-y-2">
                  {send.status === "idle" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        Send as
                        <select value={sendAs} onChange={(e) => setSendAs(e.target.value)} className="border border-white/15 bg-transparent px-1.5 py-1 text-xs outline-none focus:border-white/30">
                          <option value="">{viewerLinked ? "Shared SalesOS number" : "SalesOS (shared)"}</option>
                          {reps.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.id === viewer?.quoUserId ? `You · ${r.initials} — ${r.name}` : `${r.initials} — ${r.name}`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button onClick={() => setSend({ status: "confirming" })} className="flex items-center gap-1.5 border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-500/20">
                        <Send className="size-3.5" /> Send via Quo
                      </button>
                      {!viewerLinked && !sendAs && reps.length > 0 && (
                        <span className="text-[10px] text-amber-300/80">Link your Quo in Team to send as you.</span>
                      )}
                    </div>
                  )}

                  {/* Explicit confirmation — shows the FINAL text, recipient, and sender before anything goes out. */}
                  {send.status === "confirming" && (
                    <div className="border border-emerald-500/40 bg-emerald-500/[0.06] p-2.5">
                      <div className="text-[11px] text-muted-foreground">
                        Send to <span className="text-foreground">{result.clientName || "this lead"}</span> at <span className="tabular-nums text-foreground">{result.clientPhone}</span>, as <span className="text-foreground">{senderLabel}</span>:
                      </div>
                      <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-emerald-500/40 bg-black/20 p-2 text-sm">{smsText}</div>
                      <div className="mt-1 text-right text-[10px] text-muted-foreground tabular-nums">{smsText.length} chars</div>
                      <div className="mt-2 flex items-center gap-2">
                        <button onClick={doSend} disabled={!smsText.trim()} className="flex items-center gap-1 border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-100 disabled:opacity-50"><Check className="size-3" /> Confirm &amp; send</button>
                        <button onClick={() => setSend({ status: "idle" })} className="flex items-center gap-1 border border-white/15 px-3 py-1.5 text-xs text-muted-foreground"><X className="size-3" /> Cancel</button>
                        <span className="text-[10px] text-muted-foreground">Nothing sends until you confirm.</span>
                      </div>
                    </div>
                  )}

                  {send.status === "sending" && <span className="text-xs text-muted-foreground">Sending…</span>}
                  {send.status === "sent" && <span className="flex items-center gap-1 text-xs text-emerald-300"><Check className="size-3.5" /> {send.message}</span>}
                  {send.status === "error" && (
                    <span className="flex items-center gap-2 text-xs text-rose-300">
                      {send.message} <button onClick={() => setSend({ status: "confirming" })} className="underline">retry</button>
                    </span>
                  )}
                </div>
              );
            })()}
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
            {result.draft.source === "ai" ? `AI-drafted${result.llmModel ? ` · ${result.llmModel}` : ""}` : "Template"} · you review, edit &amp; send.
            {result.comms.attempts > 0 && ` Based on ${result.comms.attempts} logged contact${result.comms.attempts === 1 ? "" : "s"}${result.comms.lastContact ? `, last ${result.comms.lastContact}` : ""}.`}
          </p>
        </div>
      )}
    </section>
  );
}
