// Read-only "Operations baseline" panel for /scheduling. Surfaces the deterministic activity roll-up from
// opsMetrics (assigned/notified/confirmed funnel, engine actions, exceptions + median time-to-resolve) over a
// trailing window, so workload change can be MEASURED over several cycles. Honest: confirmation is labelled
// as dispatcher-only (worker acknowledgement isn't wired), and no time-saved figure is shown.

import type { SchedulingBaseline } from "@/lib/scheduling/opsMetrics";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-[0.08em] text-meta">{label}</span>
      <span className="text-[15px] font-medium tabular-nums">{value}</span>
      {hint && <span className="text-[11px] text-meta">{hint}</span>}
    </div>
  );
}

export function SchedulingBaselinePanel({ baseline }: { baseline: SchedulingBaseline }): React.JSX.Element {
  const b = baseline;
  const topCodes = Object.entries(b.exceptions.byCode)
    .sort((a, c) => c[1] - a[1])
    .slice(0, 3)
    .map(([code, n]) => `${code.replace(/_/g, " ")} ${n}`)
    .join(" · ");
  return (
    <details className="group mt-6 border border-border">
      <summary className="cursor-pointer select-none px-4 py-3 text-[13px] font-medium transition-colors hover:bg-[var(--row-hover)]">
        Operations baseline · {b.window.start} to {b.window.end} ({b.window.days}d)
      </summary>
      <div className="space-y-4 border-t border-border p-4">
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-meta">Assignment lifecycle</div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Assigned" value={b.funnel.assigned} />
            <Stat label="Notified" value={b.funnel.notified} hint="packet / text sent" />
            <Stat label="Confirmed" value={b.funnel.confirmed} hint={b.funnel.confirmedObservable ? undefined : "dispatcher only"} />
          </div>
        </div>
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-meta">Engine activity</div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Auto-assigned" value={b.autoAssigned} />
            <Stat label="Shifts tracked to route" value={b.shiftsAdjustedToRoute} />
            <Stat label="Connecteam created" value={b.connecteamCreated} />
            <Stat label="Published" value={`${b.publishes.sent}${b.publishes.failedNoScheduler ? ` (${b.publishes.failedNoScheduler} failed)` : ""}`} />
          </div>
        </div>
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-meta">Human interventions &amp; exceptions</div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Overrides" value={b.assignments.overridden} />
            <Stat label="Needs review" value={b.needsReview} />
            <Stat label="Manual touchpoints" value={b.manualTouchpoints} hint="not a time figure" />
            <Stat
              label="Exceptions"
              value={`${b.exceptions.opened} (${b.exceptions.resolved} resolved, ${b.exceptions.stillOpen} open)`}
              hint={b.exceptions.medianMinutesToResolve == null ? "none resolved in window" : `median ${b.exceptions.medianMinutesToResolve}m to resolve`}
            />
          </div>
          {topCodes && <div className="mt-2 text-[12px] text-meta">Top exception types: {topCodes}</div>}
        </div>
        <ul className="space-y-1 border-t border-border pt-3 text-[11.5px] text-meta">
          {b.caveats.map((c, i) => (
            <li key={i}>• {c}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}
