"use client";

// Route Staffing Pre-Check panel — the compact, honest view of which PRESENT routes are under-assigned and
// therefore have their debrief on HOLD. Per the design (doc §2.2) a Connecteam work shift is NOT coverage:
// a route staffed only the old way (scheduled in Connecteam, never assigned in the app) shows here as a gap,
// and the Connecteam people are surfaced as the CANDIDATES to assign — never as coverage.
//
// A gap closes ONLY by ASSIGNING crew on the route board below (it then recomputes to "ok" on its own).
// There is deliberately no manual "mark done": no one can silence the hold on an unstaffed route. All-clear
// shows an explicit OK state so the panel is honest when nothing is wrong.

import { AlertTriangle, CheckCircle2, Users } from "lucide-react";
import type { RoutePreCheck } from "@/lib/scheduling/preCheck";

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";

export function StaffingPreCheck({ routes }: { routes: RoutePreCheck[] }): React.JSX.Element | null {
  if (routes.length === 0) return null; // no present routes → nothing to pre-check (page gates this too)

  const gaps = routes.filter((r) => r.status === "gap");
  const okCount = routes.length - gaps.length;

  function scrollToBoard(): void {
    document.getElementById("staffing-board")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section className="mb-6 rounded-lg border border-border">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Users className="size-4 text-meta" />
        <h2 className="text-[13px] font-medium">Staffing pre-check</h2>
        <span className="text-[12px] text-meta">
          {gaps.length === 0
            ? `${routes.length} route${routes.length === 1 ? "" : "s"} checked`
            : `${gaps.length} route${gaps.length === 1 ? "" : "s"} on hold`}
        </span>
      </header>

      {gaps.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-meta">
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
          All {okCount} present route{okCount === 1 ? "" : "s"} have their crew assigned. Debriefs will send
          normally.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {gaps.map((r) => (
            <li key={r.routeId} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span className="text-[13px] font-medium">{r.truckName}</span>
                    <span className="text-[12px] text-meta">
                      {r.stopCount} stop{r.stopCount === 1 ? "" : "s"} · {r.customerCount} customer
                      {r.customerCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-foreground">{r.reason} — debrief held</p>
                  <p className="mt-0.5 text-[12px] text-meta">{candidateLine(r)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" className={BTN} onClick={scrollToBoard}>
                    Assign
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The honest candidate line: real names when Connecteam answered, a clear "unreachable" note when it did
 *  not (never "nobody could help"), and an Instawork hint when the schedule is reachable but nobody is free. */
function candidateLine(r: RoutePreCheck): string {
  if (!r.connecteamReachable) return "Connecteam unreachable — candidate list unknown.";
  if (r.connecteamCandidates.length === 0) return "No scheduled Connecteam crew free to assign (post a gig to fill it).";
  const names = r.connecteamCandidates.slice(0, 6).map((c) => `${c.name} (${c.role})`).join(", ");
  const more = r.connecteamCandidates.length > 6 ? ` +${r.connecteamCandidates.length - 6} more` : "";
  return `Could assign: ${names}${more}`;
}
