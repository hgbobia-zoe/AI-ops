"use client";

// Send a follow-up text via Quo (OpenPhone) straight from a draft — editable, with an explicit confirm
// step (per-message human approval; nothing auto-sends). The sender is ALWAYS the signed-in rep: the
// server derives attribution from the session, so there's no "send as" picker and no impersonation.
// Used by the lead side panel's Next-step brief so a rep can send without switching tabs.

import { useState } from "react";
import { MessageSquare, Send, Check, X } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";

type SendState = { status: "idle" | "confirming" | "sending" | "sent" | "error"; message?: string };

export function QuoTextSend({ id, phone, clientName, canText, initialText, label = "Text follow-up" }: {
  id: string;
  phone: string;
  clientName: string;
  canText: boolean;
  initialText: string;
  label?: string;
}): React.JSX.Element {
  const [text, setText] = useState(initialText);
  const [send, setSend] = useState<SendState>({ status: "idle" });

  const doSend = async (): Promise<void> => {
    setSend({ status: "sending" });
    try {
      const edited = text.trim() !== initialText.trim();
      const res = await fetch("/api/salesos/send-sms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, body: text, edited }) });
      const j = (await res.json()) as { ok?: boolean; duplicate?: boolean; message?: string; error?: string };
      if (j.ok) setSend({ status: "sent", message: j.duplicate ? j.message : "Sent via Quo" });
      else setSend({ status: "error", message: j.error ?? "Send failed" });
    } catch {
      setSend({ status: "error", message: "Send failed" });
    }
  };

  return (
    <div className="border-t border-[var(--row-rule)] pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-meta"><MessageSquare className="size-3.5" /> {label}</div>
        <CopyButton text={text} />
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); if (send.status !== "idle") setSend({ status: "idle" }); }}
        rows={4}
        className="w-full resize-y border border-border bg-[var(--row)] p-2.5 text-[13.5px] outline-none focus:border-foreground/40"
      />
      <div className="mt-0.5 text-right text-[10px] text-meta tabular-nums">{text.length} chars</div>

      {!canText ? (
        <p className="text-[11px] text-meta">No phone on file — can’t text this lead.</p>
      ) : (
        <div className="mt-1 space-y-2">
          {send.status === "idle" && (
            <button onClick={() => setSend({ status: "confirming" })} disabled={!text.trim()} className="flex items-center gap-1.5 border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-[13px] text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50">
              <Send className="size-3.5" /> Send via Quo
            </button>
          )}
          {send.status === "confirming" && (
            <div className="border border-emerald-500/40 bg-emerald-500/[0.06] p-2.5">
              <div className="text-[11px] text-meta">
                Send to <span className="text-foreground">{clientName || "this lead"}</span> at <span className="tabular-nums text-foreground">{phone}</span>, as <span className="text-foreground">you</span>:
              </div>
              <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-emerald-500/40 bg-black/20 p-2 text-[13px]">{text}</div>
              <div className="mt-2 flex items-center gap-2">
                <button onClick={doSend} disabled={!text.trim()} className="flex items-center gap-1 border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-100 disabled:opacity-50"><Check className="size-3" /> Confirm &amp; send</button>
                <button onClick={() => setSend({ status: "idle" })} className="flex items-center gap-1 border border-border px-3 py-1.5 text-[12px] text-meta"><X className="size-3" /> Cancel</button>
                <span className="text-[10px] text-meta">Nothing sends until you confirm.</span>
              </div>
            </div>
          )}
          {send.status === "sending" && <span className="text-[12px] text-meta">Sending…</span>}
          {send.status === "sent" && <span className="flex items-center gap-1 text-[12px] text-emerald-300"><Check className="size-3.5" /> {send.message}</span>}
          {send.status === "error" && (
            <span className="flex items-center gap-2 text-[12px] text-rose-300">{send.message} <button onClick={() => setSend({ status: "confirming" })} className="underline">retry</button></span>
          )}
        </div>
      )}
    </div>
  );
}
