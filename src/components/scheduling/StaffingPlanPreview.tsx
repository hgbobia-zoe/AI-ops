// Proposed staffing plan — a read-only surface for the deterministic optimizer (scheduling/optimize.ts).
// AUTO STAFF PROPOSES a whole-day internal-first plan; it never auto-commits. The dispatcher reviews the
// proposed plan + the summary, then Approves (ApplyPlanButton → /optimize/apply recomputes + writes the
// internal picks and records the temp recommendation; nothing is posted to Instawork). When the current
// staffing is already optimal we say so plainly (never a manufactured saving). Manual choices always win.
//
// Status + metrics use the SHARED Nocturne vocabulary: StatusBadge (health), Metric/MetricGrid (summary,
// values stay foreground with a coloured dot), StatusMark (per-seat internal/temp). No tinted numbers.
// Comms style: no em-dashes, no emoji.

import type { StaffingPlan, PlannedAssignment } from "@/lib/scheduling/optimize";
import type { PlanSummary, StaffingHealth } from "@/lib/scheduling/planView";
import { STAFFING_HEALTH_LABEL } from "@/lib/scheduling/planView";
import { ApplyPlanButton } from "@/components/scheduling/ApplyPlanButton";
import { StatusBadge } from "@/components/ui/status";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { StatusMark } from "@/components/console-primitives";
import type { Tone } from "@/lib/tone";
import { formatClockTime } from "@/lib/dates";

function hours(n: number | null): string {
  return n == null ? "n/a" : `${n}h`;
}

// The seat's wall-clock shift window in Eastern Time (formatClockTime is pinned to America/New_York).
// Honest when unknown: no window → "time not set", never a fabricated or misleading span.
function shiftWindow(a: PlannedAssignment): string {
  const start = formatClockTime(a.startTime);
  const end = formatClockTime(a.endTime);
  if (!start || !end) return "time not set";
  return `${start} to ${end}`;
}

// One clear, human reason for the placement (which person on this route, and why).
function placementReason(a: PlannedAssignment): string {
  return a.kind === "temp" ? (a.whyTemp ?? a.whyThisRoute) : a.whyThisRoute;
}

const HEALTH_TONE: Record<StaffingHealth, Tone> = {
  FULLY_STAFFED: "positive",
  READY: "positive",
  PARTIALLY_STAFFED: "attention",
  INSTAWORK_REQUIRED: "attention",
  ACTION_REQUIRED: "critical",
};

export function StaffingPlanPreview({
  plan,
  date,
  routeLabel,
  summary,
  health,
}: {
  plan: StaffingPlan;
  date: string;
  routeLabel: (routeId: string | null) => string;
  summary: PlanSummary | null;
  health: StaffingHealth | null;
}): React.JSX.Element | null {
  if (plan.assignments.length === 0) return null; // nothing with a known window to optimize yet

  // Group assignments by route for a readable diff.
  const byRoute = new Map<string, PlannedAssignment[]>();
  for (const a of plan.assignments) {
    const key = a.routeId ?? "other";
    const list = byRoute.get(key) ?? [];
    list.push(a);
    byRoute.set(key, list);
  }

  const money = (n: number | null): string => (n == null ? "n/a" : `$${Math.round(n).toLocaleString()}`);

  return (
    <section id="staffing-plan" className="surface mb-5 border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-meta">Proposed staffing plan</h2>
            {health && <StatusBadge tone={HEALTH_TONE[health]} size="sm">{STAFFING_HEALTH_LABEL[health]}</StatusBadge>}
          </div>
          <p className="mt-1.5 text-[13.5px] text-foreground">{plan.note}</p>
          <p className="mt-0.5 text-[11px] text-meta">Proposed only. Approve to commit the internal picks; nothing is posted to Instawork.</p>
        </div>
        <div className="flex items-center gap-5">
          <Figure label="Temp seats" now={plan.currentTempCount} then={plan.planTempCount} />
          <Figure label="Temp hours" now={plan.currentTempHours} then={plan.planTempHours} unit="h" />
          <ApplyPlanButton date={date} enabled={plan.betterThanCurrent} />
        </div>
      </div>

      {/* Plan summary — all figures from coverage / optimize / cost / readiness (no new data). Values stay
          foreground; a coloured dot carries the state (Metric). */}
      {summary && (
        <MetricGrid className="mt-3.5">
          <Metric label="Routes" value={summary.routes} />
          <Metric label="People needed" value={summary.peopleNeeded} />
          <Metric label="Internal available" value={summary.internalAvailable} tone="positive" />
          <Metric label="Internal placed" value={summary.internalAssigned} tone="positive" />
          <Metric label="Staffing gap" value={summary.staffingGap} tone={summary.staffingGap > 0 ? "attention" : undefined} />
          <Metric label="Instawork required" value={summary.instaworkRequired} tone={summary.instaworkRequired > 0 ? "attention" : undefined} />
          <Metric label="Readiness" value={summary.readinessPct == null ? "n/a" : `${summary.readinessPct}%`} />
          <Metric label="Est. Instawork cost" value={money(summary.estInstaworkCost)} />
        </MetricGrid>
      )}

      <div className="mt-3.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {[...byRoute.entries()].map(([routeId, list]) => (
          <div key={routeId} className="rounded border border-[var(--row-rule)] p-2.5">
            <div className="mb-1.5 text-[12.5px] font-medium">{routeLabel(routeId === "other" ? null : routeId)}</div>
            <ul className="space-y-1.5">
              {list.map((a, i) => (
                <li key={`${a.shiftId}-${i}`} className="text-[12px]">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <StatusMark tone={a.kind === "internal" ? "positive" : "attention"} label={a.kind === "internal" ? "Internal" : "Temp"} />
                    <span className="text-foreground">{a.name}</span>
                    <span className="text-meta">
                      {shiftWindow(a)}
                      {a.hours != null && ` · ${hours(a.hours)}`}
                    </span>
                  </span>
                  <div className="ml-5 mt-0.5 text-[11px] text-meta">
                    {placementReason(a)}
                    {a.moved && " · moved to a longer route"}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function Figure({ label, now, then, unit = "" }: { label: string; now: number | null; then: number | null; unit?: string }): React.JSX.Element {
  const fmt = (n: number | null): string => (n == null ? "n/a" : `${n}${unit}`);
  return (
    <div className="whitespace-nowrap text-right">
      <div className="text-[15px] font-medium tabular-nums">
        <span className="text-meta">{fmt(now)}</span>
        <span className="mx-1 text-meta">to</span>
        <span className="text-foreground">{fmt(then)}</span>
      </div>
      <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.1em] text-meta">{label}</div>
    </div>
  );
}
