// Coaching blade — Custodian in Maestro. Every call with a transcript (ingested from OpenPhone/Quo),
// newest first, with a one-click into its post-call coaching recap. Owner/admin only: transcripts and
// rep-performance recaps are sensitive. The recap itself is INFERENCE over the transcript — generated
// on demand on the detail page, never invented here.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Headphones, ChevronRight, PhoneIncoming, PhoneOutgoing, CheckCircle2, Circle } from "lucide-react";
import { listCoachableCalls, type CoachableCall } from "@/lib/db/repo";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeCoaching } from "@/lib/auth/roles";
import { llmConfigured } from "@/lib/llm";

export const dynamic = "force-dynamic";

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const SENTIMENT_TONE: Record<string, string> = {
  positive: "text-emerald-300",
  negative: "text-rose-300",
  neutral: "text-muted-foreground",
};

function counterparty(c: CoachableCall): string {
  if (c.contactName) return c.contactName;
  const phone = c.direction === "outgoing" ? c.toPhone : c.fromPhone;
  return phone || "Unknown caller";
}

export default async function CoachingPage(): Promise<React.JSX.Element> {
  if (!canSeeCoaching(await viewerRole())) redirect("/dashboard");
  const calls = listCoachableCalls(100);
  const analyzed = calls.filter((c) => c.analyzed).length;

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Headphones className="size-7" /> Coaching
        </h1>
        <p className="text-sm text-muted-foreground">
          Post-call recaps for every call with a transcript. {calls.length} call{calls.length === 1 ? "" : "s"}
          {analyzed > 0 ? ` · ${analyzed} analyzed` : ""}.
        </p>
      </header>

      {!llmConfigured() && (
        <div className="surface mb-4 border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          The coaching model isn&apos;t configured yet — set <code>ANTHROPIC_API_KEY</code> so recaps can be generated.
        </div>
      )}

      {calls.length === 0 ? (
        <div className="surface border border-white/10 p-8 text-center text-sm text-muted-foreground">
          No calls with transcripts yet — they arrive automatically from OpenPhone / Quo once a call is completed.
        </div>
      ) : (
        <ol className="space-y-2">
          {calls.map((c) => (
            <li key={c.id}>
              <Link
                href={`/coaching/${c.id}`}
                className="surface flex items-center gap-3 border border-white/5 p-3 transition-colors hover:bg-white/[0.04]"
              >
                <span className="shrink-0 text-muted-foreground">
                  {c.direction === "outgoing" ? <PhoneOutgoing className="size-4" /> : <PhoneIncoming className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{counterparty(c)}</div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{fmtWhen(c.occurredAt ?? c.ts)}</span>
                    <span>· {fmtDuration(c.durationSec)}</span>
                    {c.sentiment && <span className={SENTIMENT_TONE[c.sentiment] ?? ""}>· {c.sentiment}</span>}
                  </div>
                </div>
                <span className={`flex shrink-0 items-center gap-1 text-[11px] ${c.analyzed ? "text-emerald-300" : "text-muted-foreground"}`}>
                  {c.analyzed ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
                  {c.analyzed ? "Recap ready" : "Not analyzed"}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
