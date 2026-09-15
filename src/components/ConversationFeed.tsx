"use client";

// The Coaching conversation, Quo-style: the contact's calls + texts on one chronological timeline, with
// each call's AI summary + next steps shown INLINE under the call (like Quo's "Call summary" card) —
// that's where the coaching items live. The selected call is highlighted; every call links into its
// full analysis. Scrolls to newest on open.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PhoneIncoming, PhoneOutgoing, ArrowRight, Sparkles, Mail, GraduationCap, ChevronDown } from "lucide-react";
import { CallCoaching, CallSignalsStrip } from "@/components/CallCoaching";
import type { TextItem, CallItem, EmailItem, TimelineItem } from "@/lib/coach/feedTypes";

export type { TextItem, CallItem, EmailItem, TimelineItem } from "@/lib/coach/feedTypes";

const SENTIMENT_TONE: Record<string, string> = { positive: "text-emerald-300", negative: "text-rose-300", neutral: "text-muted-foreground" };

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "";
  const t = Math.round(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function ConversationFeed({ items, party, activeId }: { items: TimelineItem[]; party: string; activeId?: string }): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, []);

  return (
    <section className="surface mb-4 overflow-hidden border border-white/5">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Conversation with {party}
      </div>
      <div className="max-h-[34rem] space-y-3 overflow-y-auto px-4 py-4">
        {items.map((it) =>
          it.kind === "call" ? <CallCard key={it.id} c={it} active={it.id === activeId} /> : it.kind === "email" ? <EmailRow key={it.id} e={it} /> : <TextBubble key={it.id} t={it} />,
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}

function EmailRow({ e }: { e: EmailItem }): React.JSX.Element {
  return (
    <div className="flex justify-center">
      <div className="flex max-w-[90%] items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-muted-foreground">
        <Mail className="size-3.5 shrink-0" />
        <span className="text-foreground/80">{e.subject}</span>
        <span>· {e.via}</span>
        <span>· {fmtWhen(e.at)}</span>
      </div>
    </div>
  );
}

function TextBubble({ t }: { t: TextItem }): React.JSX.Element {
  const inbound = t.direction === "inbound";
  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[78%] rounded-2xl border px-3 py-2 text-sm ${inbound ? "rounded-tl-sm border-white/10 bg-white/[0.05]" : "rounded-tr-sm border-sky-500/30 bg-sky-500/[0.12]"}`}>
        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{inbound ? "Customer" : t.actor || "Zoe"} · {fmtWhen(t.at)}</div>
        <div className="whitespace-pre-wrap leading-relaxed">{t.body}</div>
      </div>
    </div>
  );
}

function CallCard({ c, active }: { c: CallItem; active: boolean }): React.JSX.Element {
  const inbound = c.direction === "inbound";
  const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
  const dur = fmtDuration(c.durationSec);
  const [coachOpen, setCoachOpen] = useState(false);
  return (
    <div className={`rounded-xl border p-3 ${active ? "border-white/25 bg-white/[0.06] ring-1 ring-white/15" : "border-violet-500/20 bg-violet-500/[0.05]"}`}>
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-violet-500/15"><Icon className="size-3.5 text-violet-300" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{inbound ? "Inbound call" : "Outbound call"}{dur ? ` · ${dur}` : ""}</div>
          <div className="text-[11px] text-muted-foreground">{fmtWhen(c.at)}</div>
        </div>
        {c.sentiment && <span className={`shrink-0 text-[11px] font-medium capitalize ${SENTIMENT_TONE[c.sentiment] ?? "text-muted-foreground"}`}>{c.sentiment}</span>}
      </div>

      {c.summary.length > 0 ? (
        <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-2.5">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-violet-200"><Sparkles className="size-3" /> Call summary</div>
          <ul className="list-disc space-y-0.5 pl-4 text-sm">{c.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
          {c.nextStep && (
            <p className="mt-2 flex items-start gap-1.5 text-sm"><ArrowRight className="mt-0.5 size-3.5 shrink-0 text-emerald-300" /> <span><span className="text-muted-foreground">Next step:</span> {c.nextStep}</span></p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">{c.analyzed ? "No summary for this call." : "Not analyzed yet — a recap will appear here once it's coached."}</p>
      )}

      {/* Coaching sits ON the call it's about, collapsed by default. Signals (from the transcript) are
          ready immediately; the deeper recap notes appear underneath once the call has been analyzed. */}
      {(c.signals || c.coaching) && (
        <div className="mt-2">
          <button onClick={() => setCoachOpen((o) => !o)} className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-200/80 transition-colors hover:text-amber-200">
            <GraduationCap className="size-3.5" /> {coachOpen ? "Hide coaching" : "Coaching"} <ChevronDown className={`size-3 transition-transform ${coachOpen ? "rotate-180" : ""}`} />
          </button>
          {coachOpen && (
            <div className="mt-2 space-y-2.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5">
              {c.signals && <CallSignalsStrip s={c.signals} />}
              {c.coaching ? (
                <CallCoaching data={c.coaching} />
              ) : (
                <p className="text-[11px] text-muted-foreground">Full recap is still being generated. The signals above are ready now.</p>
              )}
            </div>
          )}
        </div>
      )}

      {!active && (
        <Link href={`/coaching/${c.id}`} className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          Open this call <ArrowRight className="size-3" />
        </Link>
      )}
    </div>
  );
}
