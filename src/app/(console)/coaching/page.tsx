// Coaching blade — Custodian in Maestro, styled after Spiky's call list. Every call with a transcript
// (from OpenPhone/Quo), with a sentiment scorecard, filter tabs, and date-grouped rows into each
// call's post-call coaching board. Owner/admin only: transcripts + rep-performance recaps are
// sensitive. Recaps are INFERENCE, generated on the detail page (auto-analyzed in the background).

import Link from "next/link";
import { redirect } from "next/navigation";
import { Headphones, ChevronRight, PhoneIncoming, PhoneOutgoing, CheckCircle2, Circle, SmilePlus, Meh, Frown } from "lucide-react";
import { listCoachableCalls, countUnanalyzedCoachableCalls, type CoachableCall } from "@/lib/db/repo";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeCoaching } from "@/lib/auth/roles";
import { llmConfigured } from "@/lib/llm";
import { fmtPhone, ourPhoneDigits } from "@/lib/comms/identity";
import { BackfillDriver } from "./BackfillDriver";

export const dynamic = "force-dynamic";

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "—";
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
}
function dayLabel(iso: string | null): string {
  if (!iso) return "Earlier";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Earlier";
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const SENTIMENT_CHIP: Record<string, string> = {
  positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  negative: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  neutral: "border-white/10 bg-white/5 text-muted-foreground",
};

function counterparty(c: CoachableCall): string {
  return c.contactName || fmtPhone(c.customerPhone) || "Unknown caller";
}
function initials(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

type Filter = "all" | "positive" | "neutral" | "negative" | "pending";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "positive", label: "Positive" },
  { key: "neutral", label: "Neutral" },
  { key: "negative", label: "Negative" },
  { key: "pending", label: "Not analyzed" },
];

export default async function CoachingPage({ searchParams }: { searchParams: Promise<{ f?: string }> }): Promise<React.JSX.Element> {
  if (!canSeeCoaching(await viewerRole())) redirect("/dashboard");
  const { f } = await searchParams;
  const filter: Filter = (FILTERS.find((x) => x.key === f)?.key ?? "all") as Filter;

  const calls = listCoachableCalls(200, ourPhoneDigits());
  const unanalyzed = llmConfigured() ? countUnanalyzedCoachableCalls() : 0;

  const counts = {
    all: calls.length,
    positive: calls.filter((c) => c.sentiment === "positive").length,
    neutral: calls.filter((c) => c.sentiment === "neutral" || !c.sentiment).length,
    negative: calls.filter((c) => c.sentiment === "negative").length,
    pending: calls.filter((c) => !c.analyzed).length,
    analyzed: calls.filter((c) => c.analyzed).length,
  };

  const shown = calls.filter((c) => {
    if (filter === "all") return true;
    if (filter === "pending") return !c.analyzed;
    if (filter === "neutral") return c.sentiment === "neutral" || !c.sentiment;
    return c.sentiment === filter;
  });

  // Group the shown calls by day for a Spiky-style timeline.
  const groups: { label: string; items: CoachableCall[] }[] = [];
  for (const c of shown) {
    const label = dayLabel(c.occurredAt ?? c.ts);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(c);
    else groups.push({ label, items: [c] });
  }

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Headphones className="size-7" /> Coaching
        </h1>
        <p className="text-sm text-muted-foreground">Every call with a transcript, analyzed automatically. Open one for its coaching board.</p>
      </header>

      {/* Scorecard */}
      <section className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Calls" value={counts.all} />
        <Stat label="Analyzed" value={counts.analyzed} tone="text-emerald-300" />
        <Stat label="Positive" value={counts.positive} tone="text-emerald-300" icon={SmilePlus} />
        <Stat label="Negative" value={counts.negative} tone="text-rose-300" icon={Frown} />
      </section>

      {/* Filter tabs */}
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-white/10">
        {FILTERS.map((t) => {
          const on = filter === t.key;
          return (
            <Link
              key={t.key}
              href={t.key === "all" ? "/coaching" : `/coaching?f=${t.key}`}
              className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              <span className={`rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${on ? "bg-white/15" : "bg-white/[0.06]"}`}>{counts[t.key]}</span>
            </Link>
          );
        })}
      </nav>

      {unanalyzed > 0 && <BackfillDriver initialRemaining={unanalyzed} />}

      {!llmConfigured() && (
        <div className="surface mb-4 border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          The coaching model isn&apos;t configured yet — set <code>ANTHROPIC_API_KEY</code> so recaps can be generated.
        </div>
      )}

      {shown.length === 0 ? (
        <div className="surface border border-white/10 p-8 text-center text-sm text-muted-foreground">
          {calls.length === 0 ? "No calls with transcripts yet — they arrive from OpenPhone / Quo once a call is completed." : "No calls match this filter."}
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.label}>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h2>
              <ol className="space-y-2">
                {g.items.map((c) => (
                  <li key={c.id}>
                    <Link href={`/coaching/${c.id}`} className="surface flex items-center gap-3 border border-white/5 p-3 transition-colors hover:bg-white/[0.04]">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-xs font-semibold text-muted-foreground">
                        {/[A-Za-z]/.test(counterparty(c)) ? initials(counterparty(c)) : c.direction === "outgoing" ? <PhoneOutgoing className="size-4" /> : <PhoneIncoming className="size-4" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{counterparty(c)}</div>
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          {c.direction === "outgoing" ? <PhoneOutgoing className="size-3" /> : <PhoneIncoming className="size-3" />}
                          <span>{fmtTime(c.occurredAt ?? c.ts)}</span>
                          <span>· {fmtDuration(c.durationSec)}</span>
                        </div>
                      </div>
                      {c.sentiment && (
                        <span className={`hidden shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize sm:inline-flex ${SENTIMENT_CHIP[c.sentiment] ?? SENTIMENT_CHIP.neutral}`}>
                          <SentIcon sentiment={c.sentiment} /> {c.sentiment}
                        </span>
                      )}
                      <span className={`flex shrink-0 items-center gap-1 text-[11px] ${c.analyzed ? "text-emerald-300" : "text-muted-foreground"}`}>
                        {c.analyzed ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
                        <span className="hidden sm:inline">{c.analyzed ? "Recap ready" : "Not analyzed"}</span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function Stat({ label, value, tone = "text-foreground", icon: Icon }: { label: string; value: number; tone?: string; icon?: typeof SmilePlus }): React.JSX.Element {
  return (
    <div className="surface border border-white/5 p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">{Icon && <Icon className="size-3.5" />} {label}</div>
      <div className={`mt-0.5 text-2xl font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function SentIcon({ sentiment }: { sentiment: string }): React.JSX.Element {
  if (sentiment === "positive") return <SmilePlus className="size-3" />;
  if (sentiment === "negative") return <Frown className="size-3" />;
  return <Meh className="size-3" />;
}
