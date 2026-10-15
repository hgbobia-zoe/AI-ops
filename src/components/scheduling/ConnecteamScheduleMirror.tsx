// Connecteam schedule MIRROR panel — shows, accurately and always-visible, exactly who a coordinator put on
// the Connecteam schedule for the day (every role, including office/"other"), with their work windows. This
// is the direct answer to "Dispatch isn't pulling accurately": a coordinator who schedules in Connecteam can
// see her entries reflected 1:1, instead of only the route-derived app shifts.
//
// It never credits a Connecteam schedule as route coverage (the board's gap is untouched) — it only MIRRORS
// what Connecteam holds. Honest: when Connecteam is unreachable it says so (never "nobody scheduled").
//
// Comms style: no em-dashes as punctuation, no emoji.

import { CalendarClock } from "lucide-react";
import type { ConnecteamScheduleSummary } from "@/lib/scheduling/connecteamSchedule";
import { shiftClock } from "@/lib/connecteam";

const ROLE_LABEL: Record<string, string> = { driver: "Driver", prep: "Warehouse", other: "Other" };

export function ConnecteamScheduleMirror({
  summary,
  timezone,
}: {
  summary: ConnecteamScheduleSummary;
  timezone: string;
}): React.JSX.Element | null {
  // Nothing to mirror: unreachable is already said in the headline above; a truly-empty day needs no panel.
  if (!summary.reachable || summary.totalScheduled === 0) return null;

  return (
    <section className="mb-5 border border-border">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2">
          <CalendarClock className="size-4 text-meta" />
          <span className="text-[13px] font-medium uppercase tracking-[0.08em] text-tertiary-text">On the Connecteam schedule</span>
        </span>
        <span className="text-[11px] text-meta">{summary.totalScheduled} scheduled (as entered in Connecteam)</span>
      </header>
      <div>
        {summary.people.map((p) => (
          <div key={p.userId} className="flex items-center justify-between gap-3 border-t border-[var(--row-rule)] px-4 py-2 text-[13.5px] first:border-t-0">
            <span className="flex items-center gap-2">
              <span className="font-medium">{p.name}</span>
              <span className="text-[11px] uppercase tracking-[0.06em] text-meta">{p.title || ROLE_LABEL[p.role] || p.role}</span>
            </span>
            <span className="text-[12px] text-meta">
              {p.windows.length === 0
                ? "time not set"
                : p.windows.map((w) => `${shiftClock(w.start, timezone)} – ${shiftClock(w.end, timezone)}`).join(", ")}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
