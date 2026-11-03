// Per-event timeline (MVP4): the factual story of one event, combining what every system already captured:
// readiness snapshots (what we knew N days out), the change log (driver assigned, risk escalated or
// resolved, reschedules, booking value changes) and the post-event outcome. Not an AI narrative, a merged
// chronological record. Times are in the operating timezone (Eastern).

import Link from "next/link";
import { ArrowLeft, History } from "lucide-react";
import { getEventTimeline, getEventOutcome } from "@/lib/history/store";
import { describeChange } from "@/lib/history/describe";
import { opsDateTime, formatDollars } from "@/lib/history/format";
import { formatYmdLong } from "@/lib/dates";
import { STATUS_DOT, type Tone } from "@/lib/tone";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { BladeMain, TimelineLayout, TimelineItem } from "@/components/ui/layouts";
import { Surface } from "@/components/ui/surface";
import { EmptyState } from "@/components/ui/states";

export const dynamic = "force-dynamic";

const RISK_TONE: Record<string, Tone> = { CRITICAL: "critical", HIGH: "attention", MEDIUM: "attention", LOW: "positive" };
const cap = (s: string): string => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);

interface TL {
  ts: string;
  tone: Tone;
  text: React.ReactNode;
}

export default async function EventTimelinePage({ params }: { params: Promise<{ eventId: string }> }): Promise<React.JSX.Element> {
  const { eventId } = await params;
  const showMoney = canSeeFinancials(await viewerRole());
  const { snapshots, changes } = getEventTimeline(eventId);
  const outcome = getEventOutcome(eventId);
  // Event name: the latest snapshot, else a booking/event change (their field is the event name; a risk's
  // field is the risk title), else any recorded name.
  const namedChange = changes.find((c) => (c.entity === "event" || c.entity === "financial") && c.kind !== "event_completed" && c.field);
  const label = snapshots[snapshots.length - 1]?.label || namedChange?.field || changes.find((c) => c.field)?.field || `Event ${eventId}`;
  const latest = snapshots[snapshots.length - 1];

  const rows: TL[] = [];
  // Snapshots: the "what did we know" series. Identical consecutive snapshots collapse.
  let prevSig = "";
  for (const s of snapshots) {
    const sig = `${s.riskLevel}|${s.readinessScore}|${s.driverName ?? ""}|${s.eventDate}`;
    if (sig === prevSig) continue;
    prevSig = sig;
    const money = showMoney ? formatDollars(s.revenue) : null;
    rows.push({
      ts: s.capturedAt,
      tone: RISK_TONE[s.riskLevel] ?? "neutral",
      text: (
        <>
          <b className="text-foreground">{s.daysOut} days out:</b> {cap(s.riskLevel)} risk, readiness {s.readinessScore ?? "unknown"}
          {s.driverName ? `, driver ${s.driverName}` : ", no driver yet"}
          {money ? `, ${money}` : ""}
        </>
      ),
    });
  }
  // Change log, in the same words as the History feed.
  for (const c of changes) {
    const d = describeChange(c, { showMoney });
    rows.push({
      ts: c.ts,
      tone: d.tone,
      text: (
        <>
          <span className="text-foreground">{d.title}</span>
          {d.subject && d.subject !== label && <span className="text-foreground">: {d.subject}</span>}
          {d.detail && <span> ({d.detail})</span>}
        </>
      ),
    });
  }
  if (outcome) {
    rows.push({
      ts: outcome.closedAt,
      tone: outcome.allCompleted ? "positive" : "attention",
      text: (
        <>
          <span className="text-foreground">Route closed:</span> {outcome.completedStops} of {outcome.totalStops} stops {outcome.allCompleted ? "done" : "done, not all"}
        </>
      ),
    });
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts));

  const subtitle = latest
    ? `${formatYmdLong(latest.eventDate)} · latest: ${cap(latest.riskLevel)} risk, readiness ${latest.readinessScore ?? "unknown"}`
    : `Event ${eventId}`;

  return (
    <BladeMain className="max-w-[900px]">
      <Link href="/history" className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-meta hover:text-foreground">
        <ArrowLeft className="size-4" /> History
      </Link>
      <PageHeader title={label} icon={<History className="size-6" />} subtitle={subtitle} />

      {rows.length === 0 ? (
        <EmptyState title="No history captured for this event yet" />
      ) : (
        <Surface pad="md">
          <TimelineLayout>
            {rows.map((r, i) => (
              <TimelineItem key={i} dot={<span className={cn("mt-1.5 block size-1.5 rounded-full", STATUS_DOT[r.tone])} aria-hidden />}>
                <div className="flex items-start justify-between gap-3">
                  <span className="text-[13px] text-secondary-text">{r.text}</span>
                  <time className="shrink-0 tabular-nums text-[11.5px] text-meta" dateTime={r.ts}>
                    {opsDateTime(r.ts)}
                  </time>
                </div>
              </TimelineItem>
            ))}
          </TimelineLayout>
        </Surface>
      )}
    </BladeMain>
  );
}
