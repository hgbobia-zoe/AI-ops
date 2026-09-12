// Call-coaching insight for a lead — folds the Coaching blade's real signals into the Sales OS flow so
// a rep sees where the deal actually stands from the calls, not just the inferred state. Given the
// customer's phone, it pulls their coachable calls, reads the latest call's computed metrics + recap
// (INFERENCE, labelled), and links each call into the full Coaching board. Renders nothing when the
// customer has no calls with transcripts — no empty noise.

import Link from "next/link";
import { Headphones, PhoneIncoming, PhoneOutgoing, ArrowRight, MessageSquareReply, GraduationCap, ChevronRight } from "lucide-react";
import { getCustomerCallThread, getCallEventById, getCoachingAnalysis } from "@/lib/db/repo";
import { computeCallMetrics, sentimentGauge, momentumScore, type GaugeTone } from "@/lib/coach/metrics";
import { ourPhoneDigits, last10 } from "@/lib/comms/identity";
import { getOpenphoneContactMap } from "@/lib/comms/openphone";

const TONE_TEXT: Record<GaugeTone, string> = { good: "text-emerald-300", warn: "text-amber-300", bad: "text-rose-300", neutral: "text-muted-foreground" };
const SENTIMENT_TONE: Record<string, string> = { positive: "text-emerald-300", negative: "text-rose-300", neutral: "text-muted-foreground" };

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "—";
  const t = Math.round(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export async function LeadCoachingInsight({ phone }: { phone: string | null }): Promise<React.JSX.Element | null> {
  const digits = last10(phone);
  if (!digits) return null;

  const ourDigits = ourPhoneDigits();
  const contactMap = await getOpenphoneContactMap();
  const thread = getCustomerCallThread(digits, { ourDigits, contactMap, limit: 6 });
  if (thread.length === 0) return null; // this customer has no coached calls — say nothing

  // Latest call → computed metrics (FACT) + recap (INFERENCE) for the headline signals.
  const latest = thread[0];
  const call = getCallEventById(latest.id);
  const metrics = call?.transcript ? computeCallMetrics(call.transcript, call.durationSec, ourDigits) : null;
  const recap = getCoachingAnalysis(latest.id);
  const rep = metrics?.speakers.find((s) => s.label === "Rep") ?? null;
  const tone = sentimentGauge(call?.sentiment ?? null);
  const momentum =
    metrics || call?.sentiment
      ? momentumScore({ sentiment: call?.sentiment ?? null, repShare: rep?.share ?? null, questions: metrics?.questions ?? null, hasNextStep: !!recap?.nextStep })
      : null;

  const topObjection = recap?.objections[0]?.objection || recap?.customerConcerns[0] || null;
  const topNote = recap?.coachingNotes[0] || null;

  return (
    <section className="surface mb-4 border border-violet-500/20 bg-violet-500/[0.03] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-violet-200">
          <Headphones className="size-3.5" /> Call coaching · {thread.length} {thread.length === 1 ? "call" : "calls"}
        </div>
        <Link href={`/coaching/${latest.id}`} className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          Open in Coaching <ArrowRight className="size-3" />
        </Link>
      </div>

      {/* Headline signals from the most recent call */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {call?.sentiment && (
          <Chip label="Sentiment" value={call.sentiment} tone={SENTIMENT_TONE[call.sentiment]} />
        )}
        {momentum && <Chip label="Momentum" value={`${momentum.score}% ${momentum.label}`} tone={TONE_TEXT[momentum.tone]} />}
        {metrics?.wordsPerMin != null && <Chip label="Pace" value={`${metrics.wordsPerMin} wpm`} />}
        {tone == null && !call?.sentiment && <span className="text-xs text-muted-foreground">Latest call not analyzed yet.</span>}
      </div>

      {/* What the last call surfaced (INFERENCE) */}
      {(recap?.nextStep || topObjection || topNote) && (
        <div className="mb-3 space-y-1.5 text-sm">
          {recap?.nextStep && (
            <p className="flex items-start gap-2"><ArrowRight className="mt-0.5 size-4 shrink-0 text-emerald-300" /> <span><span className="text-muted-foreground">Next step from call:</span> {recap.nextStep}</span></p>
          )}
          {topObjection && (
            <p className="flex items-start gap-2"><MessageSquareReply className="mt-0.5 size-4 shrink-0 text-amber-300" /> <span><span className="text-muted-foreground">Objection raised:</span> {topObjection}</span></p>
          )}
          {topNote && (
            <p className="flex items-start gap-2"><GraduationCap className="mt-0.5 size-4 shrink-0 text-violet-300" /> <span><span className="text-muted-foreground">Coaching:</span> {topNote}</span></p>
          )}
        </div>
      )}

      {/* The customer's calls — each into the full coaching board */}
      <ol className="space-y-1">
        {thread.map((c) => (
          <li key={c.id}>
            <Link href={`/coaching/${c.id}`} className="flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-sm transition-colors hover:border-white/10 hover:bg-white/[0.04]">
              {c.direction === "outgoing" ? <PhoneOutgoing className="size-3.5 shrink-0 text-muted-foreground" /> : <PhoneIncoming className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="text-muted-foreground">{fmtWhen(c.occurredAt ?? c.ts)}</span>
              <span className="text-muted-foreground">· {fmtDuration(c.durationSec)}</span>
              {c.sentiment && <span className={`capitalize ${SENTIMENT_TONE[c.sentiment] ?? "text-muted-foreground"}`}>· {c.sentiment}</span>}
              {c.analyzed && <span className="ml-auto text-[10px] font-medium text-emerald-300">Recap</span>}
              <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground ${c.analyzed ? "" : "ml-auto"}`} />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Chip({ label, value, tone = "text-foreground" }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold capitalize ${tone}`}>{value}</span>
    </div>
  );
}
