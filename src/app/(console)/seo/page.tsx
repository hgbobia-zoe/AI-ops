// SEO Growth — Overview. The operating status board for the SEO engine (spec §4): what's awaiting
// analysis / approval, what's in production, what's live, what's parked, and — honestly — the state of the
// SERP data source (the office runner). Counts are 0 until the runner reads SERPs; that is the correct,
// honest state, NOT an error.
//
// FACTS ONLY. The data sources are kept visually distinct and never conflated:
//   • Observed Google SERP (who ranks, Zoe's position) — via the office runner; the integration-health card.
//   • Internal WORKFLOW state (our seo_opportunities table) — the status counts.
//   • Business OUTCOMES — not tracked yet (Phase 5); shown as such, never faked.

import Link from "next/link";
import { TrendingUp, Search, FileText, ClipboardCheck, Rocket, Archive, ArrowUpRight, Info } from "lucide-react";
import { seoOverview } from "@/lib/seo/dashboard";
import { SeoHealthCard } from "@/components/seo/SeoHealthCard";

export const dynamic = "force-dynamic";

function StatusTile({ label, value, href, icon: Icon }: { label: string; value: number; href: string; icon: React.ElementType }): React.JSX.Element {
  return (
    <Link href={href} className="rounded border border-border p-3 transition-colors hover:bg-[var(--row-hover)]">
      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-meta">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-1 text-[22px] font-medium tabular-nums text-foreground">{value}</div>
    </Link>
  );
}

export default function SeoOverviewPage(): React.JSX.Element {
  const d = seoOverview();
  const empty = d.counts.total === 0;

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <TrendingUp className="size-5 text-meta" /> SEO Growth
        </h1>
        <p className="mt-1 text-[13px] text-meta">
          Find the keywords where competitors outrank Zoe, decide what to create or improve, and track content from idea to live. Rankings come from live Google SERP reads; the decisions and workflow live here.
        </p>
      </header>

      {/* Operational status (spec §4) — internal WORKFLOW facts only. */}
      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Pipeline status</h2>
          <Link href="/seo/opportunities" className="inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
            Opportunities <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatusTile label="Awaiting analysis" value={d.counts.awaitingAnalysis} href="/seo/opportunities" icon={Search} />
          <StatusTile label="Awaiting approval" value={d.counts.awaitingApproval} href="/seo/queue" icon={ClipboardCheck} />
          <StatusTile label="In progress" value={d.counts.inProgress} href="/seo/content" icon={FileText} />
          <StatusTile label="Drafts to review" value={d.counts.draftsAwaitingReview} href="/seo/queue" icon={ClipboardCheck} />
          <StatusTile label="Recently published" value={d.counts.recentlyPublished} href="/seo/performance" icon={Rocket} />
          <StatusTile label="Deferred / rejected" value={d.counts.deferredOrRejected} href="/seo/opportunities" icon={Archive} />
        </div>
        {empty && (
          <div className="mt-3 flex items-start gap-2 rounded border border-border bg-[var(--row-hover)] px-3 py-2.5 text-[12.5px] text-tertiary-text">
            <Info className="mt-0.5 size-3.5 shrink-0 text-meta" />
            <span>
              No opportunities yet. The gap + matching engine is live; it populates once the office runner reads Google SERPs and pushes them (a small drip a few times a day). Opportunities then appear here awaiting analysis.
            </span>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-x-8 gap-y-5 lg:grid-cols-2">
        {/* Integration health — the SERP office-runner data source. */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Integration</h2>
            <Link href="/admin/health" className="inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
              Connections <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
          <SeoHealthCard health={d.health} watcher={d.watcher} />
        </section>

        {/* Retrieval diagnostics — honest log of what the boundary actually did. */}
        <section>
          <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Recent retrievals</h2>
          <div className="rounded border border-border">
            {d.diagnostics.length === 0 ? (
              <p className="p-3 text-[12.5px] text-meta">No reads recorded yet. Run the SERP office runner (tools/seo-runner) to start.</p>
            ) : (
              d.diagnostics.map((x) => (
                <div key={x.id} className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[12.5px] first:border-t-0">
                  <span className={`size-1.5 shrink-0 rounded-full ${x.ok ? "bg-positive" : x.rateLimited ? "bg-attention" : "bg-critical"}`} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{x.operation}</span>
                  {x.detail && <span className="hidden min-w-0 flex-1 truncate text-meta sm:inline" title={x.detail}>{x.detail}</span>}
                  <span className="shrink-0 tabular-nums text-[11px] text-meta">{x.ts.slice(0, 16).replace("T", " ")}</span>
                </div>
              ))
            )}
          </div>
          <p className="mt-2 text-[11.5px] text-meta">
            Business outcomes (traffic, rankings, revenue) are not tracked yet — they arrive with publishing in a later phase and will never be estimated.
          </p>
        </section>
      </div>
    </main>
  );
}
