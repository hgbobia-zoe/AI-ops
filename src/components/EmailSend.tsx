"use client";

// Send a reviewed follow-up email that CONTINUES the lead's Goodshuffle client email thread. Editable
// subject + body, an explicit confirm step (per-message human approval; nothing auto-sends). The server
// queues it; the office Auto-Pull session replays it into the GS thread as a reply, and Goodshuffle
// appends the signature automatically, so the body here is just the message. Used in the lead panel.

import { useState } from "react";
import { Mail, Send, Check, X } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";

type SendState = { status: "idle" | "confirming" | "sending" | "sent" | "error"; message?: string };

export function EmailSend({ id, clientName, clientEmail, canEmail, initialSubject, initialBody }: {
  id: string;
  clientName: string;
  clientEmail: string;
  canEmail: boolean;
  initialSubject: string;
  initialBody: string;
}): React.JSX.Element {
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [send, setSend] = useState<SendState>({ status: "idle" });

  const doSend = async (): Promise<void> => {
    setSend({ status: "sending" });
    try {
      const res = await fetch("/api/salesos/send-email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, content: body, subject }) });
      const j = (await res.json()) as { ok?: boolean; queued?: boolean; message?: string; error?: string };
      if (j.ok) setSend({ status: "sent", message: j.message ?? "Queued to send" });
      else setSend({ status: "error", message: j.error ?? "Send failed" });
    } catch {
      setSend({ status: "error", message: "Send failed" });
    }
  };

  return (
    <div className="border-t border-[var(--row-rule)] pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-meta"><Mail className="size-3.5" /> Email follow-up</div>
        <CopyButton text={`Subject: ${subject}\n\n${body}`} label="Copy email" />
      </div>
      <input
        value={subject}
        onChange={(e) => { setSubject(e.target.value); if (send.status !== "idle") setSend({ status: "idle" }); }}
        placeholder="Subject"
        className="mb-1.5 w-full border border-border bg-[var(--row)] p-2 text-[13px] outline-none focus:border-foreground/40"
      />
      <textarea
        value={body}
        onChange={(e) => { setBody(e.target.value); if (send.status !== "idle") setSend({ status: "idle" }); }}
        rows={7}
        className="w-full resize-y border border-border bg-[var(--row)] p-2.5 text-[13.5px] outline-none focus:border-foreground/40"
      />
      <p className="mt-1 text-[10.5px] text-meta">Continues the Goodshuffle email thread. The signature is added automatically, so no need to include it.</p>

      {!canEmail ? (
        <p className="mt-1 text-[11px] text-meta">No email on file for this lead.</p>
      ) : (
        <div className="mt-1.5 space-y-2">
          {send.status === "idle" && (
            <button onClick={() => setSend({ status: "confirming" })} disabled={!body.trim()} className="flex items-center gap-1.5 border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-[13px] text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50">
              <Send className="size-3.5" /> Send email
            </button>
          )}
          {send.status === "confirming" && (
            <div className="border border-emerald-500/40 bg-emerald-500/[0.06] p-2.5">
              <div className="text-[11px] text-meta">Send to <span className="text-foreground">{clientName || "this lead"}</span> at <span className="text-foreground">{clientEmail}</span>, as a reply in the Goodshuffle thread:</div>
              <div className="mt-1.5 text-[12px] text-meta">Subject: <span className="text-foreground">{subject}</span></div>
              <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap border-l-2 border-emerald-500/40 bg-black/20 p-2 text-[13px]">{body}</div>
              <div className="mt-2 flex items-center gap-2">
                <button onClick={doSend} disabled={!body.trim()} className="flex items-center gap-1 border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-100 disabled:opacity-50"><Check className="size-3" /> Confirm &amp; send</button>
                <button onClick={() => setSend({ status: "idle" })} className="flex items-center gap-1 border border-border px-3 py-1.5 text-[12px] text-meta"><X className="size-3" /> Cancel</button>
                <span className="text-[10px] text-meta">Nothing sends until you confirm.</span>
              </div>
            </div>
          )}
          {send.status === "sending" && <span className="text-[12px] text-meta">Queuing…</span>}
          {send.status === "sent" && <span className="flex items-start gap-1 text-[12px] text-emerald-300"><Check className="mt-0.5 size-3.5 shrink-0" /> {send.message}</span>}
          {send.status === "error" && (
            <span className="flex items-center gap-2 text-[12px] text-rose-300">{send.message} <button onClick={() => setSend({ status: "confirming" })} className="underline">retry</button></span>
          )}
        </div>
      )}
    </div>
  );
}
