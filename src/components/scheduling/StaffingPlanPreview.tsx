// Proposed staffing plan — a read-only surface for the deterministic optimizer (scheduling/optimize.ts).
// AUTO STAFF PROPOSES a whole-day internal-first plan; it never auto-commits. The dispatcher reviews the
// proposed plan + the summary, then Approves (ApplyPlanButton → /optimize/apply recomputes + writes the
// internal picks and records the temp recommendation; nothing is posted to Instawork). When the current
// staffing is already optimal we say so plainly (never a manufactured saving). Manual choices always win.
//
// Comms style: no em-dashes, no emoji.

import type { StaffingPlan, PlannedAssignment } from "@/lib/scheduling/optimize";
import type { PlanSummary, StaffingHealth } from "@/lib/scheduling/planView";
import { STAFFING_HEALTH_LABEL } from "@/lib/scheduling/planView";
import { ApplyPlanButton } from "@/components/scheduling/ApplyPlanButton";

function hours(n: number | null): string {
  return n == null ? "n/a" : `${n}h`;
}

const HEALTH_TONE: Record<StaffingHealth, string> = {
  FULLY_STAFFED: "border-positive/40 text-positive",
  READY: "border-positive/40 text-positive",
  PARTIALLY_STAFFED: "border-attention/40 text-attention",
  INSTAWORK_REQUIRED: "border-attention/40 text-attention",
  ACTION_REQUIRED: "border-critical/50 text-critical",
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

  const tone = plan.betterThanCurrent ? "text-attention" : "text-positive";
  const money = (n: number | null): string => (n == null ? "n/a" : `$${Math.round(n).toLocaleString()}`);

  return (
    <section id="staffing-plan" className="mb-5 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-meta">Proposed staffing plan</h2>
            {health && (
              <span className={`rounded border px-1.5 py-px text-[10.5px] font-medium uppercase tracking-[0.06em] ${HEALTH_TONE[health]}`}>
                {STAFFING_HEALTH_LABEL[health]}
              </span>
            )}
          </div>
          <p className={`mt-1 text-[13.5px] ${tone}`}>{plan.note}</p>
          <p className="mt-0.5 text-[11px] text-meta">Proposed only. Approve to commit the internal picks; nothing is posted to Instawork.</p>
        </div>
        <div className="flex items-center gap-5">
          <Figure label="Temp seats" now={plan.currentTempCount} then={plan.planTempCount} />
          <Figure label="Temp hours" now={plan.currentTempHours} then={plan.planTempHours} unit="h" />
          <ApplyPlanButton date={date} enabled={plan.betterThanCurrent} />
        </div>
      </div>

      {/* Plan summary — all figures from coverage / optimize / cost / readiness (no new data). */}
      {summary && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-[var(--row-rule)] pt-3">
          <Stat label="Routes" value={summary.routes} />
          <Stat label="People needed" value={summary.peopleNeeded} />
          <Stat label="Internal available" value={summary.internalAvailable} tone="positive" />
          <Stat label="Internal placed" value={summary.internalAssigned} tone="positive" />
          <Stat label="Staffing gap" value={summary.staffingGap} tone={summary.staffingGap > 0 ? "attention" : "default"} />
          <Stat label="Instawork required" value={summary.instaworkRequired} tone={summary.instaworkRequired > 0 ? "attention" : "default"} />
          <Stat label="Readiness" value={summary.readinessPct == null ? "n/a" : `${summary.readinessPct}%`} />
          <Stat label="Est. Instawork cost" value={money(summary.estInstaworkCost)} />
        </div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {[...byRoute.entries()].map(([routeId, list]) => (
          <div key={routeId} className="rounded border border-[var(--row-rule)] p-2.5">
            <div className="mb-1.5 text-[12.5px] font-medium">{routeLabel(routeId === "other" ? null : routeId)}</div>
            <ul className="space-y-1.5">
              {list.map((a, i) => (
                <li key={`${a.shiftId}-${i}`} className="text-[12px]">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`size-1.5 rounded-full ${a.kind === "internal" ? "bg-positive" : "bg-attention"}`} aria-hidden />
                    <span className="text-foreground">{a.name}</span>
                    <span className="text-meta">
                      {a.kind === "internal" ? "Internal" : "Temp"} · {hours(a.hours)}
                    </span>
                  </span>
                  <div className="ml-3 mt-0.5 text-[11px] text-meta">
                    {a.kind === "temp" ? a.whyTemp : a.whyThisRoute}
                    {a.moved && <span className="text-attention"> · moved to a longer route</span>}
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

function Stat({ label, value, tone = "default" }: { label: string; value: number | string; tone?: "default" | "positive" | "attention" }): React.JSX.Element {
  const toneClass = tone === "positive" ? "text-positive" : tone === "attention" ? "text-attention" : "text-foreground";
  return (
    <div className="whitespace-nowrap">
      <div className={`text-[15px] font-medium tabular-nums ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.1em] text-meta">{label}</div>
    </div>
  );
}
