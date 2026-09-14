// The coaching board for one call — the right pane of the master-detail, in the same Quo-style shape
// as Sales OS: the customer's conversation (texts + calls) as the hero, with the call's analysis tabbed
// underneath — Signals (computed metrics/sliders/momentum), Overview, Questions, Coaching, Objections,
// Actions, Transcript. Metrics are COMPUTED from the transcript; the recap is INFERENCE, labelled.

import { notFound } from "next/navigation";
import { PhoneIncoming, PhoneOutgoing, Clock, Gauge as GaugeIcon, MessageCircleQuestion, Mic, CheckSquare, AlertTriangle, GraduationCap } from "lucide-react";
import { getCallEventById, getCoachingAnalysis, resolveCallerName, getBookingByPhoneDigits, getCommsForLead, getCustomerCallThread } from "@/lib/db/repo";
import { computeCallMetrics, speedGauge, balanceGauge, sentimentGauge, momentumScore, type Gauge, type GaugeTone } from "@/lib/coach/metrics";
import { ourPhoneDigits, fmtPhone, last10 } from "@/lib/comms/identity";
import { getOpenphoneContactMap } from "@/lib/comms/openphone";
import { llmConfigured } from "@/lib/llm";
import { AutoAnalyze } from "./AutoAnalyze";
import { CoachingTabs } from "./[id]/CoachingTabs";
import { ConversationFeed } from "@/components/ConversationFeed";
import { buildConversationFeed } from "@/lib/coach/feed";
import type { CoachableCall } from "@/lib/db/repo";

const SENTIMENT_TONE: Record<string, string> = {
  positive: "text-emerald-300",
  negative: "text-rose-300",
  neutral: "text-muted-foreground",
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "—";
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function initials(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

export async function CoachingBoard({ id }: { id: string }): Promise<React.JSX.Element> {
  const call = getCallEventById(id);
  if (!call) notFound();

  const recap = getCoachingAnalysis(id);
  const ourDigits = ourPhoneDigits();
  const metrics = call.transcript ? computeCallMetrics(call.transcript, call.durationSec, ourDigits) : null;
  const Dir = call.direction === "outgoing" ? PhoneOutgoing : PhoneIncoming;
  const tooShort = !!call.transcript && (metrics?.words ?? 0) < 20;

  const customerSpeaker = metrics?.speakers.find((s) => s.label === "Customer") ?? null;
  const fromDigits = last10(call.fromPhone);
  const toDigits = last10(call.toPhone);
  const externalFromCall =
    fromDigits && !ourDigits.has(fromDigits) ? call.fromPhone : toDigits && !ourDigits.has(toDigits) ? call.toPhone : null;
  const customerPhone = externalFromCall || (customerSpeaker && /\d{10}/.test(customerSpeaker.raw) ? customerSpeaker.raw : null);
  const custDigits = last10(customerPhone);
  const contactMap = await getOpenphoneContactMap();
  const custBooking = custDigits ? getBookingByPhoneDigits(custDigits) : null;
  const nameByPhone = custBooking?.clientName?.trim() || null;
  const party =
    (call.contactName?.trim() || resolveCallerName(call) || nameByPhone || (custDigits ? contactMap.get(custDigits) : null) || fmtPhone(customerPhone)) ??
    "Unknown caller";

  // The customer's texts (from a matched lead) merged with their calls into one Quo-style feed, where
  // each call carries its AI summary + next step inline.
  const comms = custBooking ? getCommsForLead(custBooking.bookingId, 60) : [];
  let feedCalls = custDigits ? getCustomerCallThread(custDigits, { ourDigits, contactMap, limit: 12 }) : [];
  // Always include the call being viewed, even for an unknown caller with no matched thread.
  if (!feedCalls.some((c) => c.id === id)) {
    const self: CoachableCall = {
      id, direction: call.direction, fromPhone: call.fromPhone, toPhone: call.toPhone, contactName: call.contactName,
      customerPhone, caller: party, durationSec: call.durationSec, sentiment: call.sentiment, occurredAt: call.occurredAt, ts: call.ts, analyzed: !!recap,
    };
    feedCalls = [self, ...feedCalls];
  }
  const feedItems = buildConversationFeed(feedCalls, comms);

  const topSpeaker = metrics?.speakers[0];
  const rep = metrics?.speakers.find((s) => s.label === "Rep") ?? null;
  const repShare = rep ? rep.share : null;
  const speed = speedGauge(metrics?.wordsPerMin ?? null);
  const talk = balanceGauge(repShare);
  const tone = sentimentGauge(call.sentiment);
  const hasSignals = Boolean(speed || talk || tone);
  const momentum = hasSignals ? momentumScore({ sentiment: call.sentiment, repShare, questions: metrics?.questions ?? null, hasNextStep: !!recap?.nextStep }) : null;

  // Signals panel (computed metrics + sliders + momentum) — tabbed under the conversation.
  const hasTiles = !!metrics || call.durationSec != null || !!recap;
  const signalsNode = hasTiles ? (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3 @md:grid-cols-3 @2xl:grid-cols-4">
        <Tile icon={Clock} label="Duration" value={fmtDuration(call.durationSec)} />
        {metrics?.wordsPerMin != null && <Tile icon={GaugeIcon} label="Talking speed" value={`${metrics.wordsPerMin}`} unit="words/min" />}
        {metrics && metrics.questions > 0 && <Tile icon={MessageCircleQuestion} label="Questions" value={`${metrics.questions}`} />}
        {topSpeaker && <Tile icon={Mic} label="Talk balance" value={`${Math.round(topSpeaker.share * 100)}%`} unit={topSpeaker.label} />}
        {recap && <Tile icon={CheckSquare} label="Action items" value={`${recap.actionItems.length}`} tone="text-sky-300" />}
        {recap && <Tile icon={AlertTriangle} label="Objections" value={`${recap.objections.length || recap.customerConcerns.length}`} tone="text-amber-300" />}
        {recap && <Tile icon={GraduationCap} label="Coaching notes" value={`${recap.coachingNotes.length}`} tone="text-violet-300" />}
      </section>
      {(hasSignals || momentum) && (
        <section className="border-t border-white/5 pt-4">
          <div className="grid gap-5 @2xl:grid-cols-[1fr_auto] @2xl:items-center">
            <div className="space-y-3">
              {speed && <Slider label="Talking speed" gauge={speed} variant="center" />}
              {talk && <Slider label="Talking time" gauge={talk} variant="center" />}
              {tone && <Slider label="Customer tone" gauge={tone} variant="polar" />}
            </div>
            {momentum && <MomentumCard m={momentum} />}
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            Momentum is a composite of customer tone, talk balance, discovery questions, and whether a next step was secured. Tone is read from the transcript, not audio.
          </p>
        </section>
      )}
    </div>
  ) : null;

  return (
    <div className="@container p-5 pb-16 md:p-6 xl:p-8">
      {/* Header — caller + score chips */}
      <header className="surface mb-4 flex flex-col gap-4 border border-white/5 p-4 @3xl:flex-row @3xl:items-center @3xl:justify-between">
        <div className="flex items-center gap-3">
          <span className="btn-hero flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
            {/[A-Za-z]/.test(party) ? initials(party) : <Dir className="size-5" />}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight">{party}</h1>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Dir className="size-3.5" /> {call.direction ?? "call"} · {fmtWhen(call.occurredAt ?? call.ts)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {call.sentiment && <ScoreChip label="Sentiment" value={call.sentiment} tone={SENTIMENT_TONE[call.sentiment]} />}
          {topSpeaker && <ScoreChip label="Talk" value={`${topSpeaker.label} ${Math.round(topSpeaker.share * 100)}%`} />}
          {metrics?.wordsPerMin != null && <ScoreChip label="Pace" value={`${metrics.wordsPerMin} wpm`} />}
          {!recap && call.transcript && llmConfigured() && (
            tooShort
              ? <span className="text-xs text-muted-foreground">Too short to coach.</span>
              : call.coachingAttemptedAt
                ? <span className="text-xs text-muted-foreground">Couldn&apos;t generate a recap for this call.</span>
                : <AutoAnalyze callId={id} />
          )}
        </div>
      </header>

      {!llmConfigured() && (
        <div className="surface mb-4 border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          The coaching model isn&apos;t configured — set <code>ANTHROPIC_API_KEY</code> to generate a recap.
        </div>
      )}

      {/* Conversation — calls (with inline AI summaries) + texts, chronological (Quo-style hero) */}
      <ConversationFeed items={feedItems} party={party} activeId={id} />

      {/* Analysis, tabbed — Signals folds in the computed metrics/sliders/momentum */}
      <CoachingTabs
        signals={signalsNode}
        quoSummary={call.summary}
        executive={recap?.executive ?? ""}
        keyPoints={recap?.keyPoints ?? []}
        questions={metrics?.questionList ?? []}
        coachingNotes={recap?.coachingNotes ?? []}
        customerConcerns={recap?.customerConcerns ?? []}
        objections={recap?.objections ?? []}
        actionItems={recap?.actionItems ?? []}
        nextStep={recap?.nextStep ?? ""}
        followUpEmail={recap?.followUpEmail ?? ""}
        transcript={call.transcript}
        analyzed={!!recap}
      />

      <p className="mt-5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        Metrics are computed from the transcript; the recap is an AI reading of it (INFERENCE), not a system of record.
        Review before acting — the follow-up email is a draft and never sends on its own.
      </p>
    </div>
  );
}

function ScoreChip({ label, value, tone = "text-foreground" }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold capitalize ${tone}`}>{value}</span>
    </div>
  );
}

function Tile({ icon: Icon, label, value, unit, tone = "text-foreground" }: { icon: typeof Clock; label: string; value: string; unit?: string; tone?: string }): React.JSX.Element {
  return (
    <div className="surface border border-white/5 p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><Icon className="size-3.5" /> {label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={`text-2xl font-bold capitalize tabular-nums ${tone}`}>{value}</span>
        {unit && <span className="text-[11px] text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

const TONE_TEXT: Record<GaugeTone, string> = { good: "text-emerald-300", warn: "text-amber-300", bad: "text-rose-300", neutral: "text-muted-foreground" };
const TONE_DOT: Record<GaugeTone, string> = { good: "bg-emerald-400", warn: "bg-amber-400", bad: "bg-rose-400", neutral: "bg-white/40" };

function Slider({ label, gauge, variant }: { label: string; gauge: Gauge; variant: "center" | "polar" }): React.JSX.Element {
  const track =
    variant === "polar"
      ? "bg-gradient-to-r from-rose-500/40 via-amber-500/30 to-emerald-500/50"
      : "bg-gradient-to-r from-rose-500/40 via-emerald-500/50 to-rose-500/40";
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground md:w-28">{label}</span>
      <div className={`relative h-1.5 flex-1 rounded-full ${track}`}>
        <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/40 bg-white shadow" style={{ left: `${gauge.pct}%` }} />
      </div>
      <span className={`w-20 shrink-0 text-right text-[10px] font-semibold uppercase tracking-wide md:w-28 ${TONE_TEXT[gauge.tone]}`}>{gauge.label}</span>
    </div>
  );
}

function MomentumCard({ m }: { m: { score: number; label: string; tone: GaugeTone } }): React.JSX.Element {
  const dots = 8;
  const filled = Math.round((m.score / 100) * dots);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 md:w-56">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Call momentum</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className={`text-3xl font-bold tabular-nums ${TONE_TEXT[m.tone]}`}>{m.score}%</span>
        <span className={`text-sm font-semibold ${TONE_TEXT[m.tone]}`}>{m.label}</span>
      </div>
      <div className="mt-2 flex gap-1">
        {Array.from({ length: dots }).map((_, i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full ${i < filled ? TONE_DOT[m.tone] : "bg-white/10"}`} />
        ))}
      </div>
    </div>
  );
}
