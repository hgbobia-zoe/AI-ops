"use client";

// AI Org v2 — one approval request rendered as the six-field card (WHAT / WHY / DATA USED / EXPECTED
// OUTCOME / RISK / WHAT HAPPENS IF APPROVED) with APPROVE / REJECT / EDIT / REQUEST MORE INFO. EDIT lets
// a human change the message body + subject before approving. Nothing executes until Approve is
// confirmed; the server respects the send gates and forbids money/pricing/schedule/hiring execution.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X, Pencil, HelpCircle, Send } from "lucide-react";

export interface ApprovalCardData {
  id: string;
  agentId: string;
  owner: string;
  title: string;
  actionType: string;
  status: string;
  financial: boolean;
  card: { what: string; why: string; dataUsed: string; expectedOutcome: string; risk: string; whatIfApproved: string };
  payload: { transactionId?: string; leadId?: string; body?: string; subject?: string };
  createdAt: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
  outboxOpId?: string | null;
}

type UiState = { mode: "idle" | "editing" | "confirming" | "info" | "working" | "done" | "error"; message?: string };

const ACTION_LABEL: Record<string, string> = {
  send_email: "Send email",
  send_sms: "Send SMS",
  append_note: "Append note",
  create_gs_task: "Create task",
  modify_quote: "Modify quote",
  change_pricing: "Change pricing",
  schedule_change: "Schedule change",
  hiring: "Hiring",
  firing: "Firing",
  instawork_gig: "Instawork gig",
};

const FORBIDDEN = new Set(["modify_quote", "change_pricing", "schedule_change", "hiring", "firing", "instawork_gig"]);

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[132px_1fr] gap-3 py-1.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-meta">{label}</div>
      <div className="text-[13px] text-foreground">{children}</div>
    </div>
  );
}

export function ApprovalCard({ data, actionable }: { data: ApprovalCardData; actionable: boolean }): React.JSX.Element {
  const router = useRouter();
  const [ui, setUi] = useState<UiState>({ mode: "idle" });
  const [body, setBody] = useState(data.payload.body ?? "");
  const [subject, setSubject] = useState(data.payload.subject ?? "");
  const [note, setNote] = useState("");

  const forbidden = FORBIDDEN.has(data.actionType);
  const hasBody = data.actionType === "send_email" || data.actionType === "send_sms" || data.actionType === "append_note";

  const post = async (decision: string, payload?: Record<string, unknown>, infoNote?: string): Promise<void> => {
    setUi({ mode: "working" });
    try {
      const res = await fetch(`/api/ai-org/approvals/${data.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, payload, note: infoNote }),
      });
      const j = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (j.ok) {
        setUi({ mode: "done", message: j.message ?? "Done." });
        router.refresh();
      } else {
        setUi({ mode: "error", message: j.error ?? "Failed." });
      }
    } catch {
      setUi({ mode: "error", message: "Request failed." });
    }
  };

  const editedPayload = (): Record<string, unknown> => ({ transactionId: data.payload.transactionId, leadId: data.payload.leadId, body, subject });

  return (
    <div className="border border-border bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--row-rule)] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium">{data.title}</span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-meta">{ACTION_LABEL[data.actionType] ?? data.actionType}</span>
          {forbidden && <span className="rounded border border-critical/40 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-critical">Execution not wired</span>}
        </div>
        <span className="text-[11px] text-meta">{data.agentId} · {data.owner}</span>
      </div>

      <div className="px-3.5 py-2">
        <Field label="What">{data.card.what}</Field>
        <Field label="Why">{data.card.why}</Field>
        <Field label="Data used"><span className="text-tertiary-text">{data.card.dataUsed}</span></Field>
        <Field label="Expected">{data.card.expectedOutcome}</Field>
        <Field label="Risk"><span className="text-attention">{data.card.risk}</span></Field>
        <Field label="If approved"><span className="text-tertiary-text">{data.card.whatIfApproved}</span></Field>

        {hasBody && (
          <div className="mt-2 border-t border-[var(--row-rule)] pt-2">
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-meta">Drafted message</div>
            {ui.mode === "editing" ? (
              <div className="space-y-1.5">
                {data.actionType === "send_email" && (
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="w-full border border-border bg-[var(--row)] p-2 text-[13px] outline-none focus:border-foreground/40" />
                )}
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className="w-full resize-y border border-border bg-[var(--row)] p-2.5 text-[13px] outline-none focus:border-foreground/40" />
                <div className="flex gap-2">
                  <button onClick={() => post("edit", editedPayload())} className="flex items-center gap-1 border border-border px-2.5 py-1 text-[12px] text-foreground hover:bg-[var(--row-hover)]"><Check className="size-3" /> Save edit</button>
                  <button onClick={() => { setBody(data.payload.body ?? ""); setSubject(data.payload.subject ?? ""); setUi({ mode: "idle" }); }} className="flex items-center gap-1 border border-border px-2.5 py-1 text-[12px] text-meta"><X className="size-3" /> Cancel</button>
                </div>
              </div>
            ) : (
              <>
                {data.actionType === "send_email" && subject && <div className="text-[12px] text-meta">Subject: <span className="text-foreground">{subject}</span></div>}
                <div className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap border-l-2 border-border bg-black/20 p-2 text-[13px]">{body || "(no draft body)"}</div>
              </>
            )}
          </div>
        )}
      </div>

      {actionable ? (
        <div className="border-t border-[var(--row-rule)] px-3.5 py-2.5">
          {ui.mode === "done" && <div className="flex items-start gap-1.5 text-[12.5px] text-positive"><Check className="mt-0.5 size-3.5 shrink-0" /> {ui.message}</div>}
          {ui.mode === "working" && <span className="text-[12.5px] text-meta">Working…</span>}
          {ui.mode === "error" && <span className="text-[12.5px] text-critical">{ui.message} <button onClick={() => setUi({ mode: "idle" })} className="underline">dismiss</button></span>}

          {ui.mode === "confirming" && (
            <div className="border border-emerald-500/40 bg-emerald-500/[0.06] p-2.5">
              <div className="text-[12px] text-meta">
                {forbidden
                  ? "This action type cannot execute in v2. Approving records the intent only (no send)."
                  : data.actionType === "send_sms"
                    ? "SMS has no async send path here. Approving records the decision; the text itself delivers from the Sales lead panel."
                    : "On approve, the action is queued to the Goodshuffle outbox and respects its send gate. Nothing goes out until the office Auto-Pull drains it."}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button onClick={() => post("approve", hasBody ? editedPayload() : undefined)} className="flex items-center gap-1 border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-100"><Check className="size-3" /> Confirm approve</button>
                <button onClick={() => setUi({ mode: "idle" })} className="flex items-center gap-1 border border-border px-3 py-1.5 text-[12px] text-meta"><X className="size-3" /> Cancel</button>
              </div>
            </div>
          )}

          {ui.mode === "info" && (
            <div className="border border-border p-2.5">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What does the employee need to clarify?" className="w-full resize-y border border-border bg-[var(--row)] p-2 text-[13px] outline-none focus:border-foreground/40" />
              <div className="mt-1.5 flex gap-2">
                <button onClick={() => post("request_info", undefined, note)} disabled={!note.trim()} className="flex items-center gap-1 border border-border px-2.5 py-1 text-[12px] text-foreground disabled:opacity-50"><Check className="size-3" /> Send back</button>
                <button onClick={() => setUi({ mode: "idle" })} className="flex items-center gap-1 border border-border px-2.5 py-1 text-[12px] text-meta"><X className="size-3" /> Cancel</button>
              </div>
            </div>
          )}

          {(ui.mode === "idle" || ui.mode === "editing") && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setUi({ mode: "confirming" })} className="flex items-center gap-1.5 border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-[12.5px] text-emerald-100 hover:bg-emerald-500/20"><Send className="size-3.5" /> Approve</button>
              <button onClick={() => post("reject")} className="flex items-center gap-1.5 border border-border px-3 py-1.5 text-[12.5px] text-meta hover:text-foreground"><X className="size-3.5" /> Reject</button>
              {hasBody && ui.mode !== "editing" && <button onClick={() => setUi({ mode: "editing" })} className="flex items-center gap-1.5 border border-border px-3 py-1.5 text-[12.5px] text-meta hover:text-foreground"><Pencil className="size-3.5" /> Edit</button>}
              <button onClick={() => setUi({ mode: "info" })} className="flex items-center gap-1.5 border border-border px-3 py-1.5 text-[12.5px] text-meta hover:text-foreground"><HelpCircle className="size-3.5" /> Request more info</button>
            </div>
          )}
        </div>
      ) : (
        <div className="border-t border-[var(--row-rule)] px-3.5 py-2 text-[12px] text-meta">
          {data.status.toUpperCase()}{data.decidedBy ? ` by ${data.decidedBy}` : ""}{data.decisionNote ? ` · ${data.decisionNote}` : ""}
        </div>
      )}
    </div>
  );
}
