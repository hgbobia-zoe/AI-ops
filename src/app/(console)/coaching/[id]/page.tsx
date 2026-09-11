// Coaching detail — a Spiky-style post-call board: the caller, computed conversation metrics, and a
// tabbed analysis (Overview / Coaching / Objections / Actions / Transcript). The recap is generated
// on demand via a server action and cached; owner/admin only. Metrics are COMPUTED from the
// transcript (RULES CALCULATE); the recap is INFERENCE, labelled as such, and never invents facts.

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ArrowLeft, PhoneIncoming, PhoneOutgoing, Clock, Gauge, MessageCircleQuestion, Mic, CheckSquare, AlertTriangle, GraduationCap } from "lucide-react";
import { getCallEventById, getCoachingAnalysis, saveCoachingAnalysis, resolveCallerName } from "@/lib/db/repo";
import { generateRecap } from "@/lib/coach/recap";
import { computeCallMetrics } from "@/lib/coach/metrics";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeCoaching } from "@/lib/auth/roles";
import { llmConfigured } from "@/lib/llm";
import { AnalyzeButton } from "./AnalyzeButton";
import { CoachingTabs } from "./CoachingTabs";

export const dynamic = "force-dynamic";

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

export default async function CoachingDetail({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  if (!canSeeCoaching(await viewerRole())) redirect("/dashboard");
  const { id } = await params;
  const call = getCallEventById(id);
  if (!call) notFound();

  const recap = getCoachingAnalysis(id);
  const party = resolveCallerName(call) || (call.direction === "outgoing" ? call.toPhone : call.fromPhone) || "Unknown caller";
  const metrics = call.transcript ? computeCallMetrics(call.transcript, call.durationSec) : null;
  const Dir = call.direction === "outgoing" ? PhoneOutgoing : PhoneIncoming;

  async function analyze(): Promise<void> {
    "use server";
    const c = getCallEventById(id);
    if (!c || !c.transcript) return;
    const r = await generateRecap({ transcript: c.transcript, direction: c.direction, contactName: resolveCallerName(c), durationSec: c.durationSec, quoSummary: c.summary });
    if (r) saveCoachingAnalysis(id, r);
    revalidatePath(`/coaching/${id}`);
  }

  const topSpeaker = metrics?.speakers[0];

  return (
    <main className="mx-auto max-w-5xl p-5 pb-16 md:p-8">
      <Link href="/coaching" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> All calls
      </Link>

      {/* Header — caller + score chips (Spiky's "Attention / Emotion / Interaction") */}
      <header className="surface mb-4 flex flex-col gap-4 border border-white/5 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <span className="btn-hero flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold">{initials(party)}</span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight">{party}</h1>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Dir className="size-3.5" /> {call.direction ?? "call"} · {fmtWhen(call.occurredAt ?? call.ts)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {call.sentiment && <ScoreChip label="Sentiment" value={call.sentiment} tone={SENTIMENT_TONE[call.sentiment]} />}
          {topSpeaker && <ScoreChip label="Talk" value={`${topSpeaker.label} ${Math.round(topSpeaker.share * 100)}%`} />}
          {metrics?.wordsPerMin != null && <ScoreChip label="Pace" value={`${metrics.wordsPerMin} wpm`} />}
          {call.transcript && llmConfigured() && (
            <form action={analyze}>
              <AnalyzeButton label={recap ? "Re-analyze" : "Analyze call"} />
            </form>
          )}
        </div>
      </header>

      {!llmConfigured() && (
        <div className="surface mb-4 border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          The coaching model isn&apos;t configured — set <code>ANTHROPIC_API_KEY</code> to generate a recap.
        </div>
      )}

      {/* Metric tiles — every value COMPUTED from the transcript/recap, never invented */}
      <section className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Tile icon={Clock} label="Duration" value={fmtDuration(call.durationSec)} />
        {metrics?.wordsPerMin != null && <Tile icon={Gauge} label="Talking speed" value={`${metrics.wordsPerMin}`} unit="words/min" />}
        {metrics && metrics.questions > 0 && <Tile icon={MessageCircleQuestion} label="Questions" value={`${metrics.questions}`} />}
        {topSpeaker && <Tile icon={Mic} label="Talk balance" value={`${Math.round(topSpeaker.share * 100)}%`} unit={topSpeaker.label} />}
        {recap && <Tile icon={CheckSquare} label="Action items" value={`${recap.actionItems.length}`} tone="text-sky-300" />}
        {recap && <Tile icon={AlertTriangle} label="Objections" value={`${recap.customerConcerns.length}`} tone="text-amber-300" />}
        {recap && <Tile icon={GraduationCap} label="Coaching notes" value={`${recap.coachingNotes.length}`} tone="text-violet-300" />}
      </section>

      {/* Talk-balance bar when the transcript is speaker-labelled */}
      {metrics && metrics.speakers.length >= 2 && (
        <section className="surface mb-4 border border-white/5 p-4">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Talk balance</h2>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-white/5">
            <div className="bg-sky-400/70" style={{ width: `${Math.round(metrics.speakers[0].share * 100)}%` }} />
            <div className="bg-violet-400/60" style={{ width: `${Math.round(metrics.speakers[1].share * 100)}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
            <span>{metrics.speakers[0].label} · {Math.round(metrics.speakers[0].share * 100)}%</span>
            <span>{metrics.speakers[1].label} · {Math.round(metrics.speakers[1].share * 100)}%</span>
          </div>
        </section>
      )}

      {/* Tabbed analysis */}
      <CoachingTabs
        quoSummary={call.summary}
        executive={recap?.executive ?? ""}
        keyPoints={recap?.keyPoints ?? []}
        coachingNotes={recap?.coachingNotes ?? []}
        customerConcerns={recap?.customerConcerns ?? []}
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
    </main>
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
