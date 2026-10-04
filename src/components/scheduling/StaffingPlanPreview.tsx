// Staffing Plan PREVIEW — a read-only surface for the deterministic optimizer (scheduling/optimize.ts).
// It SUGGESTS a whole-day internal-first plan and shows the temp hours/seats it would avoid, or says
// plainly that the current staffing is already optimal (never a manufactured saving). There is NO Apply
// yet: persisting a plan needs the per-worker entity + an audit path (a later phase), so the affordance
// is shown disabled. The dispatcher's manual choices always win; this is record/preview only.
//
// Comms style: no em-dashes, no emoji.

import type { StaffingPlan, PlannedAssignment } from "@/lib/scheduling/optimize";

function hours(n: number | null): string {
  return n == null ? "n/a" : `${n}h`;
}

export function StaffingPlanPreview({
  plan,
  routeLabel,
}: {
  plan: StaffingPlan;
  routeLabel: (routeId: string | null) => string;
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

  return (
    <section className="mb-5 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-meta">Staffing plan preview</h2>
          <p className={`mt-1 text-[13.5px] ${tone}`}>{plan.note}</p>
        </div>
        <div className="flex items-center gap-5">
          <Figure label="Temp seats" now={plan.currentTempCount} then={plan.planTempCount} />
          <Figure label="Temp hours" now={plan.currentTempHours} then={plan.planTempHours} unit="h" />
          <button
            type="button"
            disabled
            title="Applying a plan arrives with the assignment write path (a later phase)."
            className="cursor-not-allowed rounded border border-border px-3 py-1.5 text-[12px] text-meta opacity-60"
          >
            Apply (coming)
          </button>
        </div>
      </div>

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
