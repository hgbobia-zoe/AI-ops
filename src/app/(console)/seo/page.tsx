// SEO Growth — Overview. The operating status board for the SEO engine (spec §4): what's awaiting
// analysis / approval, what's in production, what's live, what's parked — led by one honest TOP-LEVEL STATE
// so the operator sees "what do I do now" before any numbers. Counts are 0 until the SERP office runner reads
// Google; that is the correct, honest state, NOT an error, and zero queued records is NOT zero SEO opportunity.
//
// FACTS ONLY. Three sources are kept visually distinct and never conflated:
//   • Observed Google SERP (who ranks, Zoe's position) — via the office runner; the compact source-health strip.
//   • Internal WORKFLOW state (our seo_opportunities table) — the pipeline counts.
//   • Business OUTCOMES (traffic/rankings/revenue) — not tracked yet (Phase 5); shown as such, never faked.

import Link from "next/link";
import {
  TrendingUp, Search, FileText, ClipboardCheck, Rocket, Archive, ArrowUpRight, Globe, ChevronRight,
} from "lucide-react";
import { seoOverview } from "@/lib/seo/dashboard";
import { seoFindings } from "@/lib/seo/findings";
import { BladeMain, OverviewLayout } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { Surface } from "@/components/ui/surface";
import { StatusBanner } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status";
import { SeoSourceHealth } from "@/components/seo/SeoSourceHealth";
import { SeoHealthCard } from "@/components/seo/SeoHealthCard";
import { findingDisplay } from "@/lib/seo/display";
import type { SeoOverviewState } from "@/lib/seo/dashboard";

export const dynamic = "force-dynamic";

/** The real source-settings destination (the /admin "SEO Growth (competitive gap)" section — Zoe + competitor
 *  domains). The office runner itself is operated from the office machine; no secret is set from the app. */
const SETTINGS_HREF = "/admin";

const TILES = [
  { key: "awaitingAnalysis", label: "Awaiting analysis", href: "/seo/opportunities", icon: Search },
  { key: "awaitingApproval", label: "Awaiting approval", href: "/seo/opportunities", icon: ClipboardCheck },
  { key: "inProgress", label: "In progress", href: "/seo/content", icon: FileText },
  { key: "draftsAwaitingReview", label: "Drafts to review", href: "/seo/queue", icon: ClipboardCheck },
  { key: "recentlyPublished", label: "Published / live", href: "/seo/performance", icon: Rocket },
  { key: "deferredOrRejected", label: "Parked", href: "/seo/opportunities", icon: Archive },
] as const;

function PipelineTile({ label, value, href, icon: Icon }: { label: string; value: number; href: string; icon: React.ElementType }): React.JSX.Element {
  return (
    <Link
      href={href}
      className="surface flex flex-col gap-1 border border-border p-3 transition-colors hover:bg-row-hover focus-visible:bg-row-hover"
    >
      <span className="flex items-center gap-1.5 text-[11px] tracking-[0.04em] text-meta">
        <Icon className="size-3.5" aria-hidden /> {label}
      </span>
      <span className="text-[20px] font-semibold leading-none tabular-nums text-foreground">{value}</span>
    </Link>
  );
}

/** The honest lead banner for each non-populated state. Returns null when the pipeline is populated + fresh. */
function OverviewBanner({ state, lastSuccessLabel }: { state: SeoOverviewState; lastSuccessLabel: string | null }): React.JSX.Element | null {
  switch (state) {
    case "setup_needed":
      return (
        <StatusBanner
          tone="neutral"
          title="Connect the SEO source to begin"
          action={
            <Link href={SETTINGS_HREF} className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-row-hover">
              Open source settings <ArrowUpRight className="size-3.5" />
            </Link>
          }
        >
          Set Zoe&apos;s domain and the competitor domains in Settings, then run the Google SERP office runner from
          the office machine. Opportunities appear here once it reads. No live keyword data is shown until then —
          nothing is fabricated.
        </StatusBanner>
      );
    case "error":
      return (
        <StatusBanner tone="critical" title="The SERP source needs attention">
          The last Google SERP read failed or was blocked. The runner retries on its next drip; existing
          opportunities below are unaffected. See the source health for the specific reason.
        </StatusBanner>
      );
    case "retrieving":
      return (
        <StatusBanner tone="info" title="Reading live SERPs — first results on the way">
          The source is connected and reading Google. No opportunities have been queued yet; they appear here as
          the runner matches read keywords against Zoe&apos;s site.
        </StatusBanner>
      );
    case "no_records":
      return (
        <StatusBanner tone="attention" title="No opportunities queued">
          The source has read before{lastSuccessLabel ? ` (last success ${lastSuccessLabel})` : ""} but nothing is
          queued right now. This is zero <em>queued records</em>, not zero SEO opportunity — re-run the office
          runner to read more keywords.
        </StatusBanner>
      );
    case "stale":
      return (
        <StatusBanner tone="attention" title="Source data may be out of date">
          The pipeline below is real, but the SERP source hasn&apos;t refreshed inside the staleness window
          {lastSuccessLabel ? ` (last success ${lastSuccessLabel})` : ""}. Re-run the office runner for current rankings.
        </StatusBanner>
      );
    case "populated":
    default:
      return null;
  }
}

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function SeoOverviewPage(): React.JSX.Element {
  const d = seoOverview();
  const lastSuccessLabel = ago(d.health.lastSuccessAt);
  // When there are records, lead the operator to the most actionable work (gaps/improves), newest-priority first.
  const actionable = d.counts.total > 0 ? seoFindings({ actionableOnly: true, limit: 6 }) : [];
  const scopeNote = d.watcher.totalSeeds > 0
    ? `${d.watcher.discovered} of ${d.watcher.totalSeeds} tracked keywords read`
    : "Scope: Zoe's service categories across the DMV";

  return (
    <BladeMain>
      <PageHeader
        size="display"
        icon={<TrendingUp className="size-6" />}
        title="SEO Growth"
        subtitle="Find where competitors outrank Zoe, decide what to create or improve, and move content from idea to live. Rankings come from live Google SERP reads; the decisions and workflow live here."
      />

      <div className="space-y-5">
        <OverviewBanner state={d.state} lastSuccessLabel={lastSuccessLabel} />

        <OverviewLayout
          main={
            <div className="space-y-5">
              {/* Pipeline status — internal WORKFLOW facts only (never SERP/outcome data). */}
              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="text-[13px] font-semibold text-foreground">Pipeline</h2>
                  <span className="text-[11.5px] text-meta">{scopeNote}</span>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {TILES.map((t) => (
                    <PipelineTile key={t.key} label={t.label} value={d.counts[t.key]} href={t.href} icon={t.icon} />
                  ))}
                </div>
              </section>

              {/* What needs action — only when real records exist; deterministic gap/improve findings. */}
              {actionable.length > 0 && (
                <section>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-[13px] font-semibold text-foreground">Awaiting your action</h2>
                    <Link href="/seo/opportunities" className="inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
                      All opportunities <ArrowUpRight className="size-3.5" />
                    </Link>
                  </div>
                  <Surface pad="none" className="divide-y divide-[color:var(--row-rule)]">
                    {actionable.map((f) => {
                      const fd = findingDisplay(f.kind);
                      return (
                        <Link key={f.opportunityId} href="/seo/opportunities" className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-row-hover">
                          <span className="w-[86px] shrink-0"><StatusBadge tone={fd.tone} size="sm">{fd.label}</StatusBadge></span>
                          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground" title={f.keyword}>{f.keyword}</span>
                          {f.priority != null && <span className="shrink-0 tabular-nums text-[11px] text-meta">P{f.priority}</span>}
                          <ChevronRight className="size-3.5 shrink-0 text-meta" aria-hidden />
                        </Link>
                      );
                    })}
                  </Surface>
                </section>
              )}

              {/* Source health + retrieval detail — NOT the daily default; a disclosure, so the overview isn't a
                  wall of plumbing. Preserves the full health card + diagnostics log. */}
              <details className="group">
                <summary className="flex cursor-pointer items-center gap-1.5 text-[12px] text-meta transition-colors hover:text-foreground">
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
                  Source health &amp; recent retrievals
                </summary>
                <div className="mt-3 space-y-3">
                  <SeoHealthCard health={d.health} watcher={d.watcher} />
                  <div>
                    <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Recent retrievals</h3>
                    <Surface pad="none">
                      {d.diagnostics.length === 0 ? (
                        <p className="p-3 text-[12.5px] text-meta">No reads recorded yet. Run the SERP office runner to start.</p>
                      ) : (
                        <ul className="divide-y divide-[color:var(--row-rule)]">
                          {d.diagnostics.map((x) => (
                            <li key={x.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                              <StatusBadge tone={x.ok ? "positive" : x.rateLimited ? "attention" : "critical"} size="sm">
                                <span className="sr-only">{x.ok ? "ok" : x.rateLimited ? "limited" : "failed"}</span>
                              </StatusBadge>
                              <span className="min-w-0 flex-1 truncate text-foreground">{x.operation}</span>
                              {x.detail && <span className="hidden min-w-0 flex-1 truncate text-meta sm:inline" title={x.detail}>{x.detail}</span>}
                              <span className="shrink-0 tabular-nums text-[11px] text-meta">{x.ts.slice(0, 16).replace("T", " ")}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Surface>
                  </div>
                </div>
              </details>
            </div>
          }
          context={
            <>
              <SeoSourceHealth health={d.health} watcher={d.watcher} settingsHref={SETTINGS_HREF} />

              {/* Destinations the overview hands off to (vertical nav carries the rest). */}
              <Surface pad="md" className="space-y-1">
                <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Destinations</h3>
                <Link href="/seo/competitors" className="flex items-center justify-between py-1 text-[12.5px] text-secondary-text transition-colors hover:text-foreground">
                  <span className="inline-flex items-center gap-2"><Search className="size-3.5 text-meta" /> Competitors &amp; gaps</span>
                  <ArrowUpRight className="size-3.5 text-meta" />
                </Link>
                <Link href="/seo/content" className="flex items-center justify-between py-1 text-[12.5px] text-secondary-text transition-colors hover:text-foreground">
                  <span className="inline-flex items-center gap-2"><FileText className="size-3.5 text-meta" /> Content Studio</span>
                  <ArrowUpRight className="size-3.5 text-meta" />
                </Link>
                <Link href="/website-studio" className="flex items-center justify-between py-1 text-[12.5px] text-secondary-text transition-colors hover:text-foreground">
                  <span className="inline-flex items-center gap-2"><Globe className="size-3.5 text-meta" /> Website Studio</span>
                  <ArrowUpRight className="size-3.5 text-meta" />
                </Link>
              </Surface>

              <Surface pad="md">
                <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Business outcomes</h3>
                <p className="text-[12px] leading-relaxed text-meta">
                  Traffic, rankings and revenue are not tracked yet — they arrive with publishing in a later phase
                  and will never be estimated.
                </p>
              </Surface>
            </>
          }
        />
      </div>
    </BladeMain>
  );
}
