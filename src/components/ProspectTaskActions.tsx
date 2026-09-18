"use client";

// Prospecting — log the outcome of one task (call/email/linkedin). A reply/meeting pauses the sequence
// and moves the opportunity to ENGAGED for a human to convert in Goodshuffle.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

type Channel = "call" | "email" | "linkedin" | "task";
type Outcome = "connected" | "voicemail" | "no_answer" | "sent" | "bounced" | "replied" | "not_interested" | "meeting";

const OUTCOMES: Record<Channel, { key: Outcome; label: string; tone?: string }[]> = {
  call: [
    { key: "connected", label: "Connected" },
    { key: "voicemail", label: "Voicemail" },
    { key: "no_answer", label: "No answer" },
    { key: "meeting", label: "Meeting", tone: "text-positive" },
    { key: "replied", label: "Interested", tone: "text-positive" },
    { key: "not_interested", label: "Not interested", tone: "text-meta" },
  ],
  email: [
    { key: "sent", label: "Sent" },
    { key: "replied", label: "Replied", tone: "text-positive" },
    { key: "bounced", label: "Bounced", tone: "text-meta" },
    { key: "not_interested", label: "Not interested", tone: "text-meta" },
  ],
  linkedin: [
    { key: "sent", label: "Sent" },
    { key: "replied", label: "Replied", tone: "text-positive" },
  ],
  task: [{ key: "sent", label: "Done" }],
};

export function ProspectTaskActions({ taskId, channel }: { taskId: string; channel: Channel }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function post(payload: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/prospecting/task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId, ...payload }) });
      if (!res.ok) throw new Error();
      toast.success(ok);
      router.refresh();
    } catch {
      toast.error("Could not log the outcome");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {(OUTCOMES[channel] ?? OUTCOMES.task).map((o) => (
        <button key={o.key} onClick={() => post({ outcome: o.key }, `Logged: ${o.label}`)} disabled={busy} className={`rounded border border-border px-2 py-0.5 text-[11.5px] hover:bg-[var(--row-hover)] disabled:opacity-50 ${o.tone ?? "text-tertiary-text"} hover:text-foreground`}>
          {o.label}
        </button>
      ))}
      <button onClick={() => post({ action: "skip" }, "Skipped")} disabled={busy} className="rounded border border-border px-2 py-0.5 text-[11.5px] text-meta hover:text-foreground disabled:opacity-50">Skip</button>
    </div>
  );
}
