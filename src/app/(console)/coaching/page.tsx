// Coaching blade — Custodian in Maestro. Every call with a transcript (ingested from OpenPhone/Quo),
// newest first, with a one-click into its post-call coaching recap. Owner/admin only: transcripts and
// rep-performance recaps are sensitive. The recap itself is INFERENCE over the transcript — generated
// on demand on the detail page, never invented here.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Headphones, ChevronRight, PhoneIncoming, PhoneOutgoing, CheckCircle2, Circle } from "lucide-react";
import { listCoachableCalls, countUnanalyzedCoachableCalls, type CoachableCall } from "@/lib/db/repo";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeCoaching } from "@/lib/auth/roles";
import { llmConfigured } from "@/lib/llm";
import { fmtPhone } from "@/lib/comms/identity";
import { BackfillDriver } from "./BackfillDriver";

export const dynamic = "force-dynamic";

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "—";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const SENTIMENT_CHIP: Record<string, string> = {
  positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  negative: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  neutral: "border-white/10 bg-white/5 text-muted-foreground",
};

function counterparty(c: CoachableCall): string {
  if (c.contactName) return c.contactName;
  const phone = (c.direction === "outgoing" ? c.toPhone : c.fromPhone) || c.fromPhone || c.toPhone;
  return fmtPhone(phone) || "Unknown caller";
}

function initials(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").toUpperCase() + (parts[1]?.[0] ?? "").toUpperCase();
}

export default async function CoachingPage(): Promise<React.JSX.Element> {
  if (!canSeeCoaching(await viewerRole())) redirect("/dashboard");
  const calls = listCoachableCalls(100);
  const analyzed = calls.filter((c) => c.analyzed).length;
  const unanalyzed = llmConfigured() ? countUnanalyzedCoachableCalls() : 0;

  return (
    <main className="mx-auto max-w-4xl p-5 pb-16 md:p-8">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Headphones className="size-7" /> Coaching
        </h1>
        <p className="text-sm text-muted-foreground">
          Every call with a transcript is analyzed automatically. {calls.length} call{calls.length === 1 ? "" : "s"}
          {analyzed > 0 ? ` · ${analyzed} analyzed` : ""}.
        </p>
      </header>

      {unanalyzed > 0 && <BackfillDriver initialRemaining={unanalyzed} />}

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
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-xs font-semibold text-muted-foreground">
                  {/[A-Za-z]/.test(counterparty(c)) ? initials(counterparty(c)) : (c.direction === "outgoing" ? <PhoneOutgoing className="size-4" /> : <PhoneIncoming className="size-4" />)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{counterparty(c)}</div>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {c.direction === "outgoing" ? <PhoneOutgoing className="size-3" /> : <PhoneIncoming className="size-3" />}
                    <span>{fmtWhen(c.occurredAt ?? c.ts)}</span>
                    <span>· {fmtDuration(c.durationSec)}</span>
                  </div>
                </div>
                {c.sentiment && (
                  <span className={`hidden shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize sm:inline ${SENTIMENT_CHIP[c.sentiment] ?? SENTIMENT_CHIP.neutral}`}>
                    {c.sentiment}
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
      )}
    </main>
  );
}
