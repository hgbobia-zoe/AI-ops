"use client";

// Post-Event overview — service-first. It opens with the live service worklist ("what to do next"),
// then prominent access to the board and issue recovery, and only then the period funnel + a small set
// of headline rates. RULES CALCULATE: every count is a real record count and every rate carries its
// numerator and denominator; a rate over an empty denominator explains the MISSING denominator instead
// of showing "0%" or a fabricated success. A customer whose experience is not yet confirmed is work in
// progress, never framed as dissatisfied or lost. Methodology lives in contextual help, not the daily
// summary.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  HeartHandshake,
  Loader2,
  ArrowRight,
  LifeBuoy,
  Columns3,
  ListChecks,
  HelpCircle,
} from "lucide-react";
import type { PostEventMetrics, Rate, BoardColumns, PostEventCard, PostEventState } from "@/lib/postevent/types";
import { POSTEVENT_STATE_ORDER } from "@/lib/postevent/types";
import { buildServiceWorklist, type WorklistGroup } from "@/lib/postevent/worklist";
import { PageHeader } from "@/components/ui/page-header";
import { BladeMain } from "@/components/ui/layouts";
import { Surface } from "@/components/ui/surface";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { StatusBadge } from "@/components/ui/status";
import { EmptyState } from "@/components/ui/states";
import { PostEventSettings } from "@/components/postevent/PostEventSettings";

const PERIODS: { key: string; label: string; heading: string }[] = [
  { key: "7", label: "7 days", heading: "Last 7 days" },
  { key: "30", label: "30 days", heading: "Last 30 days" },
  { key: "90", label: "90 days", heading: "Last 90 days" },
  { key: "all", label: "All time", heading: "All time" },
];

// A rate shows its percentage only when the denominator exists; otherwise it explains WHICH denominator
// is missing (never "0%" or a fabricated success). The explanations name the real backend denominator.
const RATE_UNAVAILABLE: Record<string, string> = {
  confirmation: "No customers have been reached yet, so there is nothing to confirm.",
  issue: "No experiences are confirmed yet, so an issue rate cannot be computed.",
  overall: "No completed events in this period yet.",
};

function CountLink({ href, children }: { href: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </Link>
  );
}

function HeadlineMetric({ label, r, unavailableKey, tone }: { label: string; r: Rate; unavailableKey: string; tone?: "positive" | "attention" | "neutral" }): React.JSX.Element {
  if (r.pct == null) {
    return <Metric label={label} value="Unavailable" sub={RATE_UNAVAILABLE[unavailableKey]} />;
  }
  return <Metric label={label} value={`${r.pct}%`} sub={`${r.num} of ${r.den}`} tone={r.num > 0 && tone === "attention" ? "attention" : undefined} />;
}

// ── Service worklist (the operational "what to do next"; built from the LIVE board, not the period) ───
function WorklistRow({ g, primary }: { g: WorklistGroup; primary?: boolean }): React.JSX.Element {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 ${primary ? "" : "border-t border-rule pt-3"}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusBadge tone={g.tone} size={primary ? "md" : "sm"}>
            {g.label}
          </StatusBadge>
          <span className={`tabular-nums font-semibold text-foreground ${primary ? "text-[20px]" : "text-[15px]"}`}>{g.count}</span>
          {g.overdue > 0 && (
            <span className="text-[11px] tabular-nums text-meta" title="Past the stage SLA">
              {g.overdue} overdue
            </span>
          )}
        </div>
        <p className={`mt-1 text-meta ${primary ? "text-[12.5px]" : "text-[11.5px]"}`}>{g.description}</p>
      </div>
      <CountLink href={g.href}>
        {g.actionLabel} <ArrowRight className="size-3.5" />
      </CountLink>
    </div>
  );
}

export function PostEventOverview(): React.JSX.Element {
  const [period, setPeriod] = useState("30");
  const [data, setData] = useState<PostEventMetrics | null>(null);
  const [board, setBoard] = useState<BoardColumns | null>(null);
  const [loading, setLoading] = useState(true);
  const [boardErr, setBoardErr] = useState(false);

  // Period-scoped funnel + rates. `loading` is flipped on by the period control (not in this effect) so
  // the effect only syncs state in from the fetch callbacks.
  useEffect(() => {
    let alive = true;
    fetch(`/api/postevent/overview?days=${period}`)
      .then((r) => r.json())
      .then((j: PostEventMetrics) => {
        if (alive) setData(j);
      })
      .catch(() => {
        if (alive) setData(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [period]);

  // Live active work (NOT period-scoped) → the service worklist. Fetched once.
  useEffect(() => {
    let alive = true;
    fetch("/api/postevent/board")
      .then((r) => r.json())
      .then((j: { columns: BoardColumns }) => {
        if (alive) setBoard(j.columns);
      })
      .catch(() => {
        if (alive) setBoardErr(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const periodHeading = PERIODS.find((p) => p.key === period)?.heading ?? "";
  const maxFunnel = data ? Math.max(1, ...data.funnel.map((f) => f.count)) : 1;

  const activeCards: PostEventCard[] = board ? POSTEVENT_STATE_ORDER.flatMap((s: PostEventState) => board[s]) : [];
  const worklist = board ? buildServiceWorklist(activeCards) : null;
  // Open issue RECORDS across active projects (matches the Issues list), distinct from the count of
  // projects in service recovery (which can also include an identified problem with no issue logged yet).
  const openIssues = activeCards.reduce((n, c) => n + c.openIssues, 0);

  const periodSelector = (
    <div className="flex items-center gap-0.5 rounded border border-border p-0.5" role="group" aria-label="Reporting period">
      {PERIODS.map((p) => (
        <button
          key={p.key}
          onClick={() => {
            if (p.key !== period) setLoading(true);
            setPeriod(p.key);
          }}
          aria-pressed={period === p.key}
          className={`rounded px-2.5 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${period === p.key ? "bg-row-hover text-foreground" : "text-meta hover:text-foreground"}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );

  return (
    <BladeMain>
      <PageHeader
        icon={<HeartHandshake className="size-5" />}
        title="Post-Event"
        subtitle="Human-first follow-up after every completed event: understand the experience, resolve any issue, and only then, when it is genuinely warranted, invite a review."
        actions={periodSelector}
      />

      {/* ── Service worklist: the next actionable customer-service task, from the live board ───────── */}
      <section className="mb-5" aria-labelledby="pe-worklist-h">
        <div className="mb-2 flex items-center gap-2">
          <h2 id="pe-worklist-h" className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            <ListChecks className="size-4 text-meta" aria-hidden /> Open work
          </h2>
          <span className="text-[11.5px] text-meta">Live, across all active projects</span>
        </div>
        {!board ? (
          boardErr ? (
            <Surface pad="md" className="text-[12.5px] text-meta">
              The board could not be loaded. Open the board to see current work.
            </Surface>
          ) : (
            <Surface pad="md" className="flex items-center gap-2 text-[12.5px] text-meta">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading current work…
            </Surface>
          )
        ) : worklist && worklist.groups.length > 0 ? (
          <Surface pad="md" className="space-y-3">
            <WorklistRow g={worklist.groups[0]} primary />
            {worklist.groups.slice(1).map((g) => (
              <WorklistRow key={g.key} g={g} />
            ))}
          </Surface>
        ) : (
          <EmptyState
            icon={<ListChecks className="size-6" />}
            title="No active follow-up work"
            body="Every eligible project has been worked through. New completed events appear here once their pickup is done."
          />
        )}
      </section>

      {/* ── Prominent access: work the board + issue recovery (BEFORE analytics) ──────────────────── */}
      <div className="mb-6 flex flex-wrap gap-2 text-[12.5px]">
        <Link
          href="/postevent/kanban"
          className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Columns3 className="size-4 text-meta" aria-hidden /> Work the board <ArrowRight className="size-3.5" />
        </Link>
        <Link
          href="/postevent/issues"
          className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-tertiary-text transition-colors hover:bg-row-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LifeBuoy className="size-4 text-meta" aria-hidden /> Issues / recovery
          {board && <span className="tabular-nums text-meta">({openIssues} open)</span>}
        </Link>
      </div>

      {loading || !data ? (
        <div className="flex items-center gap-2 text-[13px] text-meta">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading metrics…
        </div>
      ) : (
        <>
          {/* ── Period funnel: distinct counts, conversion/drop-off, named denominators ──────────── */}
          <section className="mb-6" aria-labelledby="pe-funnel-h">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="pe-funnel-h" className="text-[13px] font-medium text-foreground">
                Follow-up funnel
              </h2>
              <span className="text-[11.5px] text-meta">{periodHeading}</span>
            </div>
            <Surface pad="sm">
              <ul className="space-y-2.5">
                {data.funnel.map((f, i) => {
                  const prev = i > 0 ? data.funnel[i - 1] : null;
                  // Conversion = this step / previous step. The previous step IS the named denominator
                  // for each rate (coverage/contact/confirmation/positive-subset/request/receipt).
                  const conv = prev && prev.count > 0 ? Math.round((f.count / prev.count) * 1000) / 10 : null;
                  // Drop-off is only meaningful when this step is a subset of the previous one; the
                  // review-request step is counted independently, so a negative "drop" is suppressed.
                  const drop = prev ? prev.count - f.count : 0;
                  return (
                    <li key={f.key}>
                      <div className="flex items-baseline justify-between gap-2 text-[13px]">
                        <Link
                          href="/postevent/kanban"
                          className="text-foreground transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`${f.label}: ${f.count} projects. View on the board.`}
                        >
                          {f.label}
                        </Link>
                        <span className="flex items-baseline gap-2">
                          <span className="tabular-nums text-foreground">{f.count}</span>
                          {prev &&
                            (conv == null ? (
                              <span className="w-[120px] text-right text-[11px] text-meta">No {prev.label.toLowerCase()}</span>
                            ) : (
                              <span className="w-[120px] text-right text-[11px] tabular-nums text-meta">
                                {conv}% of {prev.label.toLowerCase()}
                                {drop > 0 ? ` · -${drop}` : ""}
                              </span>
                            ))}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-bar" role="presentation">
                        <div className="h-full bg-bar-2" style={{ width: `${Math.round((f.count / maxFunnel) * 100)}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 border-t border-rule pt-2 text-[11px] text-meta">
                These are distinct metrics, not the same projects counted again. {data.counts.completed} completed events does not mean {data.counts.completed} review requests: a review is invited only after a confirmed positive experience, and review requests are recorded independently of disposition.
              </p>
            </Surface>
          </section>

          {/* ── Headline rates (reduced; each names its denominator or explains the missing one) ──── */}
          <section className="mb-6" aria-labelledby="pe-rates-h">
            <h2 id="pe-rates-h" className="mb-2 text-[13px] font-medium text-foreground">
              Headline rates
            </h2>
            <MetricGrid className="lg:grid-cols-3">
              <HeadlineMetric label="Experiences confirmed" r={data.rates.experienceConfirmationRate} unavailableKey="confirmation" />
              <HeadlineMetric label="Issue rate" r={data.rates.issueRate} unavailableKey="issue" tone="attention" />
              <HeadlineMetric label="Overall review rate" r={data.rates.overallReviewRate} unavailableKey="overall" />
            </MetricGrid>
          </section>

          <div className="mb-6 flex flex-wrap gap-2 text-[12.5px]">
            <CountLink href="/postevent/analytics">
              Full analytics <ArrowRight className="size-3.5" />
            </CountLink>
            <CountLink href="/postevent/closures">Closure reasons</CountLink>
          </div>

          {/* ── Contextual help: methodology lives here, out of the daily workflow ─────────────────── */}
          <details className="mb-6 rounded border border-border">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-[12px] font-medium text-tertiary-text">
              <HelpCircle className="size-3.5 text-meta" aria-hidden /> How this is measured
            </summary>
            <div className="space-y-2 border-t border-rule p-3 text-[12px] text-meta">
              <p>
                Every number here is a count of real records. Follow-up is a human-first service process: completed events, outreach attempts, customers reached, experiences confirmed, issues, review requests and published reviews are kept as separate facts and are never collapsed into one another.
              </p>
              <p>
                Rates are computed deterministically and always show their numerator and denominator. When a denominator is empty the rate is reported as unavailable with the reason, never as 0% or a success. A customer whose experience is not yet confirmed is counted as work in progress, not as a lost or unhappy customer.
              </p>
              <p>Any interpretive, non-deterministic layer would be labelled as such; nothing on this page is inferred or generated.</p>
            </div>
          </details>

          <PostEventSettings />
        </>
      )}
    </BladeMain>
  );
}
