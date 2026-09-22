// Post-Event Analytics — real, deterministic operational metrics (no roadmap placeholder). RULES
// CALCULATE: every rate carries its numerator and denominator; an empty denominator renders "Unavailable",
// never a fabricated percentage. Funnel, conversion, coverage/contact/review rates, aging by stage,
// closure reasons, issue categories, and employee accountability — all computed from real records.

import { TrendingUp } from "lucide-react";
import { syncPostEvent } from "@/lib/postevent/engine";
import { computeMetrics, agingByStage, closureBreakdown, issueBreakdown, employeeActivity } from "@/lib/postevent/metrics";
import { CLOSURE_REASON_LABEL, isClosureReason, type Rate } from "@/lib/postevent/types";

export const dynamic = "force-dynamic";

function pctLabel(r: Rate): string {
  return r.pct == null ? "Unavailable" : `${r.pct}%`;
}
function RateRow({ label, r }: { label: string; r: Rate }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-[var(--row-rule)] py-1.5 text-[12.5px] first:border-t-0">
      <span className="text-tertiary-text">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="tabular-nums text-meta">
          {r.num} / {r.den}
        </span>
        <span className={`w-14 text-right tabular-nums ${r.pct == null ? "text-meta" : "text-foreground"}`}>{pctLabel(r)}</span>
      </span>
    </div>
  );
}
function Card({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded border border-border">
      <h2 className="border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">{title}</h2>
      <div className="p-3">{children}</div>
    </section>
  );
}

export default function PostEventAnalyticsPage(): React.JSX.Element {
  syncPostEvent(); // keep eligibility + auto-contacts current before reading
  const m = computeMetrics();
  const aging = agingByStage();
  const closures = closureBreakdown();
  const issues = issueBreakdown();
  const employees = employeeActivity();
  const funnelMax = Math.max(1, ...m.funnel.map((f) => f.count));

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <span className="text-tertiary-text">Post-Event</span> / Analytics
      </div>
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <TrendingUp className="size-5 text-meta" /> Analytics
        </h1>
        <p className="mt-1 text-[12.5px] text-meta">All-time, computed from real records. Every percentage shows its numerator and denominator.</p>
      </header>

      {m.bottleneck && (
        <div className="mb-4 rounded border border-attention/40 bg-attention/[0.05] px-3 py-2 text-[12.5px] text-attention">
          Where the process is breaking down: {m.bottleneck.headline}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Funnel */}
        <Card title="Funnel">
          <div className="space-y-1.5">
            {m.funnel.map((f, i) => {
              const prev = i > 0 ? m.funnel[i - 1].count : null;
              const conv = prev && prev > 0 ? Math.round((f.count / prev) * 100) : null;
              return (
                <div key={f.key} className="text-[12.5px]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-tertiary-text">{f.label}</span>
                    <span className="flex items-baseline gap-2">
                      <span className="tabular-nums text-foreground">{f.count}</span>
                      {conv != null && <span className="w-16 text-right text-[11px] tabular-nums text-meta">{conv}% of prev</span>}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-[var(--row-rule)]">
                    <div className="h-full bg-foreground/40" style={{ width: `${Math.round((f.count / funnelMax) * 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Rates */}
        <Card title="Rates (numerator / denominator)">
          <div>
            <RateRow label="Follow-up coverage" r={m.rates.followUpCoverage} />
            <RateRow label="Customer contact rate" r={m.rates.contactRate} />
            <RateRow label="Experience confirmation" r={m.rates.experienceConfirmationRate} />
            <RateRow label="Issue rate" r={m.rates.issueRate} />
            <RateRow label="Review request rate" r={m.rates.reviewRequestRate} />
            <RateRow label="Review conversion" r={m.rates.reviewConversion} />
            <RateRow label="Overall review rate" r={m.rates.overallReviewRate} />
          </div>
        </Card>

        {/* Aging by stage */}
        <Card title="Aging by stage (active work)">
          <div className="grid grid-cols-[1.4fr_auto_auto_auto] gap-x-3 gap-y-1 text-[12.5px]">
            <span className="text-[10.5px] uppercase tracking-[0.06em] text-meta">Stage</span>
            <span className="text-right text-[10.5px] uppercase tracking-[0.06em] text-meta">Count</span>
            <span className="text-right text-[10.5px] uppercase tracking-[0.06em] text-meta">Stale</span>
            <span className="text-right text-[10.5px] uppercase tracking-[0.06em] text-meta">Avg days</span>
            {aging.map((a) => (
              <div key={a.state} className="contents">
                <span className="truncate text-tertiary-text">{a.label}</span>
                <span className="text-right tabular-nums text-foreground">{a.count}</span>
                <span className={`text-right tabular-nums ${a.stale > 0 ? "text-attention" : "text-meta"}`}>{a.stale}</span>
                <span className="text-right tabular-nums text-meta">{a.avgDays == null ? "—" : a.avgDays}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Issue categories */}
        <Card title={`Issue categories (${issues.open} open / ${issues.total} total)`}>
          {issues.rows.length === 0 ? (
            <p className="text-[12.5px] text-meta">No issues recorded.</p>
          ) : (
            <div className="space-y-1">
              {issues.rows.map((r) => (
                <div key={r.type} className="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span className="text-tertiary-text">{r.label}</span>
                  <span className="tabular-nums text-meta">
                    <span className={r.open > 0 ? "text-attention" : "text-meta"}>{r.open} open</span> · {r.count} total
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Closure reasons */}
        <Card title={`Closure reasons (${closures.total})`}>
          {closures.rows.length === 0 ? (
            <p className="text-[12.5px] text-meta">Nothing closed yet.</p>
          ) : (
            <div className="space-y-1">
              {closures.rows.map((r) => (
                <div key={r.reason} className="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span className="text-tertiary-text">{isClosureReason(r.reason) ? CLOSURE_REASON_LABEL[r.reason] : r.reason}</span>
                  <span className="tabular-nums text-meta">{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Employee accountability */}
        <Card title="Employee accountability">
          {employees.length === 0 ? (
            <p className="text-[12.5px] text-meta">No attributed activity yet.</p>
          ) : (
            <div className="grid grid-cols-[1.5fr_repeat(6,auto)] gap-x-3 gap-y-1 text-[12px]">
              <span className="text-[10px] uppercase tracking-[0.05em] text-meta">Employee</span>
              <span className="text-right text-[10px] uppercase tracking-[0.05em] text-meta" title="Contact attempts">Att</span>
              <span className="text-right text-[10px] uppercase tracking-[0.05em] text-meta" title="Customer reached">Rch</span>
              <span className="text-right text-[10px] uppercase tracking-[0.05em] text-meta" title="Review requests">Rev</span>
              <span className="text-right text-[10px] uppercase tracking-[0.05em] text-meta" title="Issues opened">Iss</span>
              <span className="text-right text-[10px] uppercase tracking-[0.05em] text-meta" title="Projects closed">Cls</span>
              <span className="text-right text-[10px] uppercase tracking-[0.05em] text-meta" title="Board moves">Mv</span>
              {employees.map((e) => (
                <div key={e.employee} className="contents">
                  <span className="truncate text-foreground">{e.employee}</span>
                  <span className="text-right tabular-nums text-tertiary-text">{e.attempts}</span>
                  <span className="text-right tabular-nums text-tertiary-text">{e.reached}</span>
                  <span className="text-right tabular-nums text-tertiary-text">{e.reviewRequests}</span>
                  <span className="text-right tabular-nums text-tertiary-text">{e.issuesOpened}</span>
                  <span className="text-right tabular-nums text-tertiary-text">{e.projectsClosed}</span>
                  <span className="text-right tabular-nums text-tertiary-text">{e.moves}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <p className="mt-3 text-[11px] text-meta">Counts real, attributed actions only. Auto-imported contacts and system moves are excluded from employee credit. Unknown values render as Unavailable, never fabricated.</p>
    </main>
  );
}
