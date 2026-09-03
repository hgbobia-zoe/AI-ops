// Per-event timeline (MVP4) — the factual story of one event, combining what every system already
// captured: readiness snapshots (what we knew N days out), the change log (driver assigned, risk
// escalated/resolved, reschedules, booking-value changes), and the post-event outcome. Not an AI
// narrative — a merged chronological record.

import Link from "next/link";
import { ArrowLeft, CircleDot, Camera } from "lucide-react";
import { getEventTimeline, getEventOutcome } from "@/lib/history/store";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const money = (n: number | null): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const when = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
};

interface TL {
  ts: string;
  tone: string;
  text: React.ReactNode;
}

export default async function EventTimelinePage({ params }: { params: Promise<{ eventId: string }> }): Promise<React.JSX.Element> {
  const { eventId } = await params;
  const showMoney = canSeeFinancials(await viewerRole());
  const { snapshots, changes } = getEventTimeline(eventId);
  const outcome = getEventOutcome(eventId);
  const label = snapshots[snapshots.length - 1]?.label || changes.find((c) => c.field)?.field || `Event ${eventId}`;
  const latest = snapshots[snapshots.length - 1];

  const rows: TL[] = [];
  // Snapshots — the "what did we know" series.
  let prevSig = "";
  for (const s of snapshots) {
    const sig = `${s.riskLevel}|${s.readinessScore}|${s.driverName ?? ""}`;
    if (sig === prevSig) continue; // collapse identical consecutive snapshots
    prevSig = sig;
    rows.push({
      ts: s.capturedAt,
      tone: s.riskLevel === "CRITICAL" ? "text-red-300" : s.riskLevel === "HIGH" ? "text-orange-300" : s.riskLevel === "MEDIUM" ? "text-amber-300" : "text-emerald-300",
      text: (
        <>
          <b>{s.daysOut}d out</b> — {s.riskLevel}, readiness {s.readinessScore ?? "—"}
          {s.driverName ? `, driver ${s.driverName}` : ""}
          {showMoney && s.revenue != null ? ` · ${money(s.revenue)}` : ""}
        </>
      ),
    });
  }
  // Change log.
  for (const c of changes) {
    rows.push({
      ts: c.ts,
      tone: "text-muted-foreground",
      text: (
        <>
          {c.kind.replace(/_/g, " ")}
          {c.field ? ` — ${c.field}` : ""}
          {c.fromValue || c.toValue ? ` (${c.fromValue ?? "—"} → ${c.toValue ?? "—"})` : ""}
        </>
      ),
    });
  }
  // Outcome.
  if (outcome) {
    rows.push({
      ts: outcome.closedAt,
      tone: outcome.allCompleted ? "text-emerald-300" : "text-amber-300",
      text: (
        <>
          <Camera className="mr-1 inline size-3.5" /> Route closed — {outcome.completedStops}/{outcome.totalStops} stops {outcome.allCompleted ? "completed" : "(partial)"}
        </>
      ),
    });
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      <Link href="/history" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> History
      </Link>
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">{label}</h1>
        <p className="text-sm text-muted-foreground">
          {latest ? `${latest.eventDate} · latest: ${latest.riskLevel}, readiness ${latest.readinessScore ?? "—"}` : `Event ${eventId}`}
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="border border-white/10 p-8 text-center text-sm text-muted-foreground">
          No history captured for this event yet.
        </div>
      ) : (
        <ol className="relative space-y-3 border-l border-white/10 pl-5">
          {rows.map((r, i) => (
            <li key={i} className="relative">
              <CircleDot className={`absolute -left-[26px] top-0.5 size-3.5 ${r.tone}`} />
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm">{r.text}</span>
                <time className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{when(r.ts)}</time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
