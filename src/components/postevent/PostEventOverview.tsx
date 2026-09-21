"use client";

// Post-Event management view — the current-period funnel with REAL counts, the metrics (each with its
// absolute numerator/denominator), and a prominent "Where are we losing customers?" bottleneck. This is
// operational, not a generic analytics dashboard. Deterministic; a rate over an empty denominator shows
// "Unavailable", never a fabricated percentage.

import { useEffect, useState } from "react";
import Link from "next/link";
import { HeartHandshake, Loader2, AlertTriangle, ArrowRight } from "lucide-react";
import type { PostEventMetrics, Rate } from "@/lib/postevent/types";
import { PostEventSettings } from "@/components/postevent/PostEventSettings";

const PERIODS: { key: string; label: string }[] = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "all", label: "All time" },
];

function pctText(r: Rate): string {
  return r.pct == null ? "Unavailable" : `${r.pct}%`;
}

function RateTile({ label, r, help }: { label: string; r: Rate; help: string }): React.JSX.Element {
  return (
    <div className="rounded border border-border p-3">
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-meta">{label}</div>
      <div className={`mt-1 text-[20px] font-medium tabular-nums ${r.pct == null ? "text-meta" : "text-foreground"}`}>{pctText(r)}</div>
      <div className="text-[11.5px] tabular-nums text-tertiary-text">
        {r.num} of {r.den}
      </div>
      <div className="mt-0.5 text-[11px] text-meta">{help}</div>
    </div>
  );
}

export function PostEventOverview(): React.JSX.Element {
  const [period, setPeriod] = useState("30");
  const [data, setData] = useState<PostEventMetrics | null>(null);
  const [loading, setLoading] = useState(true);

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

  const maxFunnel = data ? Math.max(1, ...data.funnel.map((f) => f.count)) : 1;

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
            <HeartHandshake className="size-5 text-meta" /> Post-Event
          </h1>
          <p className="mt-1 max-w-[640px] text-[13px] text-meta">
            Human-first follow-up after every completed event. Understand the experience, resolve issues, and only then, when it&apos;s genuinely warranted, invite a review. The review is an outcome of good service, never the goal.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded border border-border p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => {
                setLoading(true);
                setPeriod(p.key);
              }}
              className={`rounded px-2.5 py-1 text-[12px] transition-colors ${period === p.key ? "bg-foreground/[0.08] text-foreground" : "text-meta hover:text-foreground"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {loading || !data ? (
        <div className="flex items-center gap-2 text-[13px] text-meta">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {/* Where are we losing customers? */}
          <section className="mb-5 rounded border border-attention/40 bg-attention/[0.04] p-4">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.1em] text-attention">
              <AlertTriangle className="size-3.5" /> Where are we losing customers?
            </div>
            {data.bottleneck ? (
              <p className="text-[15px] text-foreground">{data.bottleneck.headline}</p>
            ) : (
              <p className="text-[13px] text-meta">
                {data.counts.completed === 0 ? "No completed events in this period yet." : "No drop-off to flag: every eligible project is progressing."}
              </p>
            )}
            <p className="mt-1 text-[11px] text-meta">Computed deterministically from the funnel. AI interpretation is a Phase 2 add-on and would be clearly labelled.</p>
          </section>

          {/* Funnel with real counts */}
          <section className="mb-6">
            <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Current period funnel</h2>
            <div className="rounded border border-border p-3">
              <ul className="space-y-2">
                {data.funnel.map((f, i) => {
                  const prev = i > 0 ? data.funnel[i - 1].count : null;
                  const drop = prev != null && prev > 0 ? prev - f.count : 0;
                  return (
                    <li key={f.key}>
                      <div className="flex items-center justify-between text-[13px]">
                        <span className="text-foreground">{f.label}</span>
                        <span className="tabular-nums text-tertiary-text">
                          {f.count}
                          {drop > 0 && <span className="ml-2 text-[11px] text-meta">-{drop}</span>}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-[var(--bar)]">
                        <div className="h-full bg-positive" style={{ width: `${Math.round((f.count / maxFunnel) * 100)}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 border-t border-[var(--row-rule)] pt-2 text-[11px] text-meta">
                Completed events, review requests, and reviews received are different numbers on purpose. {data.counts.completed} completed does not mean {data.counts.completed} review requests.
              </p>
            </div>
          </section>

          {/* Rates — each with its absolute numerator/denominator */}
          <section className="mb-6">
            <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Metrics</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <RateTile label="Follow-up coverage" r={data.rates.followUpCoverage} help="initiated / completed" />
              <RateTile label="Contact rate" r={data.rates.contactRate} help="reached / initiated" />
              <RateTile label="Experience confirmed" r={data.rates.experienceConfirmationRate} help="confirmed / reached" />
              <RateTile label="Issue rate" r={data.rates.issueRate} help="issues / confirmed" />
              <RateTile label="Review-request rate" r={data.rates.reviewRequestRate} help="requests / positive" />
              <RateTile label="Review conversion" r={data.rates.reviewConversion} help="received / requested" />
              <RateTile label="Overall review rate" r={data.rates.overallReviewRate} help="received / completed" />
            </div>
          </section>

          <div className="flex flex-wrap gap-2 text-[12.5px]">
            <Link href="/postevent/kanban" className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
              Work the board <ArrowRight className="size-3.5" />
            </Link>
            <Link href="/postevent/issues" className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
              Issues / recovery ({data.counts.issues})
            </Link>
            <Link href="/postevent/closures" className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
              Closure reasons
            </Link>
          </div>

          <PostEventSettings />
        </>
      )}
    </main>
  );
}
