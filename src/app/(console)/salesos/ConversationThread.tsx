"use client";

// The lead's conversation, Quo-style: texts + calls on one chronological timeline (oldest → newest),
// customer on the left, Zoe on the right, calls as centered rows. Scrolls to the newest message on
// open, like a chat. Read-only here — replies are drafted from the Outreach tab (human-approved).

import { useEffect, useRef } from "react";
import { Phone, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import type { CommsEventView } from "@/lib/db/repo";

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ConversationThread({ comms, party }: { comms: CommsEventView[]; party: string }): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  // Oldest → newest for a chat reading order.
  const ordered = [...comms].reverse();

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, []);

  return (
    <section className="surface mb-4 overflow-hidden border border-white/5">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Phone className="size-3.5" /> Conversation with {party}
      </div>
      {ordered.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">No texts or calls on file for this lead yet.</p>
      ) : (
        <div className="max-h-[30rem] space-y-2 overflow-y-auto px-4 py-4">
          {ordered.map((c) => {
            if (c.channel === "call") return <CallRow key={c.id} c={c} />;
            const inbound = c.direction === "inbound";
            return (
              <div key={c.id} className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-[78%] rounded-2xl border px-3 py-2 text-sm ${inbound ? "rounded-tl-sm border-white/10 bg-white/[0.05]" : "rounded-tr-sm border-sky-500/30 bg-sky-500/[0.12]"}`}>
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {inbound ? "Customer" : c.actor || "Zoe"} · {fmtWhen(c.occurredAt ?? c.ts)}
                  </div>
                  <div className="whitespace-pre-wrap leading-relaxed">{c.body}</div>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}
    </section>
  );
}

function CallRow({ c }: { c: CommsEventView }): React.JSX.Element {
  const inbound = c.direction === "inbound";
  const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
  return (
    <div className="flex justify-center">
      <div className="flex max-w-[90%] items-start gap-2 rounded-xl border border-violet-500/25 bg-violet-500/[0.07] px-3 py-2 text-sm">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-violet-300" />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-violet-200/90">{inbound ? "Inbound call" : "Outbound call"} · {fmtWhen(c.occurredAt ?? c.ts)}</div>
          {c.body ? <div className="whitespace-pre-wrap text-muted-foreground">{c.body}</div> : null}
        </div>
      </div>
    </div>
  );
}
