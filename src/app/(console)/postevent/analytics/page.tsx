// Post-Event Analytics — Phase 2 surface. The management funnel + metrics + bottleneck already live on
// the Overview. This blade is where the deeper, deferred work lands: an AI insights panel (clearly
// labelled as interpretation), time-series trend charts, and the full employee-accountability report.
// The data model already supports all of it, so this shows a real early cut over that data and is honest
// about what is still to come.

import { TrendingUp, Info } from "lucide-react";
import { employeeActivity } from "@/lib/postevent/metrics";

export const dynamic = "force-dynamic";

export default function PostEventAnalyticsPage(): React.JSX.Element {
  const rows = employeeActivity();

  return (
    <main className="max-w-[900px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <span className="text-tertiary-text">Post-Event</span> / Analytics
      </div>
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <TrendingUp className="size-5 text-meta" /> Analytics
        </h1>
        <p className="mt-1 text-[12.5px] text-meta">The live funnel and metrics are on the Overview. This blade holds the deeper analytics, staged for Phase 2.</p>
      </header>

      <div className="mb-5 rounded border border-border bg-[var(--row-hover)]/40 p-4">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
          <Info className="size-3.5" /> Phase 2
        </div>
        <ul className="ml-4 list-disc space-y-1 text-[12.5px] text-meta">
          <li>AI insights panel that interprets the funnel bottleneck, clearly labelled as interpretation (never a fabricated metric).</li>
          <li>Time-series trend charts (follow-up coverage, contact rate, review conversion over weeks).</li>
          <li>Full employee-accountability report: eligible follow-ups, initiated, successful contacts, review requests, issues escalated, closed, average time-to-first-follow-up, currently stale.</li>
        </ul>
      </div>

      <section>
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Employee activity (early cut)</h2>
        {rows.length === 0 ? (
          <p className="text-[13px] text-meta">No attributed activity yet. Logged contacts, review requests, and board moves will appear here by employee.</p>
        ) : (
          <div className="overflow-hidden rounded border border-border">
            <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-2 border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] uppercase tracking-[0.06em] text-meta">
              <span>Employee</span>
              <span className="tabular-nums">Contacts</span>
              <span className="tabular-nums">Review requests</span>
              <span className="tabular-nums">Board moves</span>
            </div>
            {rows.map((r) => (
              <div key={r.employee} className="grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-2 border-t border-[var(--row-rule)] px-3 py-2 text-[12.5px] first:border-t-0">
                <span className="min-w-0 truncate text-foreground">{r.employee}</span>
                <span className="tabular-nums text-tertiary-text">{r.contactsLogged}</span>
                <span className="tabular-nums text-tertiary-text">{r.reviewRequests}</span>
                <span className="tabular-nums text-tertiary-text">{r.moves}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-meta">Counts real, attributed actions only. Auto-imported contacts and system moves are excluded from employee credit.</p>
      </section>
    </main>
  );
}
