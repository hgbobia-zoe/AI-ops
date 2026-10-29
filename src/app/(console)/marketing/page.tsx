// Marketing overview — the task-first landing for Zoe's demand-generation blade. It answers, in order:
// what needs me now, what's going out next, what's running, and where do I jump to work. All of it is
// derived deterministically from FACTS the team entered (campaigns, content plan, reviews logged here,
// outreach prospects) plus the saved tool links — nothing is pulled from a live Google/The-Knot feed, and
// the scope lines say so. Working editors live in the sub-blades; the AI strip is secondary context.
//
// The win here is "quote agreed" — the moment a prospect crosses into Goodshuffle. From there Sales OS
// owns the pipeline; Opportunity Radar runs its own (B2B bid) outreach. Those handoffs are named in-page.

import Link from "next/link";
import {
  Megaphone, CalendarDays, Star, ArrowUpRight, ArrowRight, AlertTriangle, Trophy, Send, Compass, Plus,
} from "lucide-react";
import { marketingDashboard } from "@/lib/marketing/dashboard";
import { buildMarketingOverview, type AttentionItem } from "@/lib/marketing/overview";
import { ChannelHub } from "@/components/marketing/ChannelHub";
import { BladeMain, OverviewLayout } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { Surface } from "@/components/ui/surface";
import { Metric } from "@/components/ui/metric";
import { EmptyState, StatusBanner } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status";
import { buttonVariants } from "@/components/ui/button";
import { REVIEW_SOURCE_LABEL, CHANNEL_LABEL, AUDIENCE_LABEL, PROSPECT_STATUS_LABEL, PROSPECT_OPEN_STAGES } from "@/lib/marketing/types";
import { formatYmdLong } from "@/lib/dates";
import { BladeAgents } from "@/components/aiorg/BladeAgents";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

function money(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${Math.round(n)}`;
}

/** A section header with a "jump to the working view" link. Secondary access to every sub-blade. */
function SectionHead({ title, href, linkLabel, scope }: { title: string; href: string; linkLabel: string; scope?: string }): React.JSX.Element {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
        {scope && <p className="mt-0.5 text-[11px] text-meta">{scope}</p>}
      </div>
      <Link href={href} className="inline-flex shrink-0 items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
        {linkLabel} <ArrowUpRight className="size-3.5" />
      </Link>
    </div>
  );
}

function AttentionRow({ a }: { a: AttentionItem }): React.JSX.Element {
  const label = a.key === "outreach" ? "Due" : a.key === "content" ? "Overdue" : "Reply";
  return (
    <Link
      href={a.href}
      className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 transition-colors first:border-t-0 hover:bg-[var(--row-hover)]"
    >
      <StatusBadge tone={a.tone} size="sm">{label}</StatusBadge>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-foreground">{a.title}</span>
        <span className="block truncate text-[11.5px] text-meta">{a.detail}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-meta">{a.linkLabel} <ArrowRight className="size-3.5" /></span>
    </Link>
  );
}

export default function MarketingHome(): React.JSX.Element {
  const d = marketingDashboard();
  const vm = buildMarketingOverview(d);
  const stars = d.reviews.avgRating != null ? `${d.reviews.avgRating}★` : "—";

  const primaryBtn = (
    <Link
      href={vm.primary.href}
      className={cn(buttonVariants({ variant: vm.primary.tone === "attention" ? "default" : "outline", size: "sm" }))}
    >
      {vm.primary.tone === "neutral" && <Plus className="size-3.5" />}
      {vm.primary.label}
    </Link>
  );

  const subtitle =
    "Top-of-funnel demand gen across weddings/social and corporate/gov. The win is a quote agreed — then it's Goodshuffle and Sales OS.";

  // ── Setup state: nothing entered and no tools linked. One focused screen, not a wall of zeros. ──
  if (vm.isSetup) {
    return (
      <BladeMain className="max-w-[1000px]">
        <PageHeader title="Marketing" icon={<Megaphone className="size-5" />} subtitle={subtitle} />
        <EmptyState
          icon={<Megaphone className="size-6" />}
          title="Set up your marketing workspace"
          body="This blade is an operating dashboard over the tools you already run — it tracks what you log here (outreach, campaigns, content, reviews) and links straight out to Confluence, your social poster, ManyChat and your profiles. It does not pull from Google or The Knot, so an empty board means nothing is logged yet, not that there's no activity."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Link href="/marketing/outreach" className={cn(buttonVariants({ variant: "default", size: "sm" }))}>Add your first prospect</Link>
              <Link href="/marketing/campaigns" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Plan a campaign</Link>
            </div>
          }
        />
        <div className="mt-4">
          <ChannelHub initial={d.links} />
        </div>
        <HandoffNote className="mt-4" />
      </BladeMain>
    );
  }

  return (
    <BladeMain>
      <PageHeader title="Marketing" icon={<Megaphone className="size-5" />} subtitle={subtitle} actions={primaryBtn} />

      <OverviewLayout
        main={
          <div className="space-y-5">
            {/* Needs me now — the task-first focus. Only real, non-empty work; else a caught-up note. */}
            <section>
              <SectionHead title="Needs your attention" href={vm.attention[0]?.href ?? "/marketing/outreach"} linkLabel="Go to work" />
              {vm.attention.length === 0 ? (
                <Surface pad="sm">
                  <div className="flex items-center gap-2 text-[12.5px] text-secondary-text">
                    <StatusBadge tone="positive" size="sm">Caught up</StatusBadge>
                    <span>No follow-ups due, content past date, or reviews to answer right now.</span>
                  </div>
                </Surface>
              ) : (
                <Surface pad="none">
                  {vm.attention.map((a) => <AttentionRow key={a.key} a={a} />)}
                </Surface>
              )}
            </section>

            {/* Going out next — upcoming content (honest 3-week period + source). */}
            <section>
              <SectionHead title="Going out next" href="/marketing/content" linkLabel="Content calendar" scope={vm.scope.content} />
              <Surface pad="none">
                {d.content.overdue.length > 0 && (
                  <div className="flex items-center gap-2 border-b border-[var(--row-rule)] px-3 py-2 text-[12px] text-secondary-text">
                    <AlertTriangle className="size-3.5 shrink-0 text-status-blocked" aria-hidden />
                    {d.content.overdue.length} planned {d.content.overdue.length === 1 ? "piece is" : "pieces are"} past date and not posted
                  </div>
                )}
                {d.content.upcoming.length === 0 && d.content.overdue.length === 0 ? (
                  <p className="p-3 text-[12.5px] text-meta">Nothing scheduled in the next three weeks. Plan content in Confluence, then log it here so the team can see it coming.</p>
                ) : (
                  d.content.upcoming.slice(0, 6).map((c) => (
                    <div key={c.id} className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[13px] first:border-t-0">
                      <CalendarDays className="size-3.5 shrink-0 text-meta" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-foreground">{c.title}</span>
                      <span className="hidden shrink-0 text-[11.5px] text-meta sm:inline">{c.channel ? CHANNEL_LABEL[c.channel] : ""}</span>
                      <span className="shrink-0 tabular-nums text-[11.5px] text-tertiary-text">{c.planDate ? formatYmdLong(c.planDate) : ""}</span>
                    </div>
                  ))
                )}
              </Surface>
            </section>

            {/* Live campaigns — what's actually running (honest source). */}
            <section>
              <SectionHead title="Live campaigns" href="/marketing/campaigns" linkLabel="All campaigns" scope={vm.scope.campaigns} />
              <Surface pad="none">
                {d.campaigns.live.length === 0 ? (
                  <p className="p-3 text-[12.5px] text-meta">
                    {vm.hasCampaignData
                      ? `Nothing live right now · ${d.campaigns.byStatus.planned} planned, ${d.campaigns.byStatus.idea} ${d.campaigns.byStatus.idea === 1 ? "idea" : "ideas"}.`
                      : "No campaigns tracked yet. Plan one to drive bookings."}
                  </p>
                ) : (
                  d.campaigns.live.map((c) => (
                    <div key={c.id} className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[13px] first:border-t-0">
                      <span className="min-w-0 flex-1 truncate text-foreground">{c.name}</span>
                      <span className="hidden shrink-0 text-[11.5px] text-meta sm:inline">{AUDIENCE_LABEL[c.audience]}</span>
                      {c.budget != null && <span className="shrink-0 tabular-nums text-[12px] text-tertiary-text">{money(c.spend ?? 0)}/{money(c.budget)}</span>}
                    </div>
                  ))
                )}
                {(d.campaigns.activeBudget > 0 || d.campaigns.activeSpend > 0) && (
                  <div className="flex items-center justify-between border-t border-[var(--row-rule)] px-3 py-2 text-[12px] text-meta">
                    <span>Active spend vs budget (live + planned)</span>
                    <span className="tabular-nums text-tertiary-text">{money(d.campaigns.activeSpend)} / {money(d.campaigns.activeBudget)}</span>
                  </div>
                )}
              </Surface>
            </section>
          </div>
        }
        context={
          <>
            {/* Snapshot — only the areas that actually carry data, each with an honest scope sub. No
                wall of zero tiles implying complete company reporting; hidden entirely until something
                is logged (links alone don't create a snapshot). */}
            {(vm.hasOutreachData || vm.hasContentData || vm.hasCampaignData || vm.hasReviewData) && (
            <section>
              <h2 className="mb-2 text-[13px] font-medium text-foreground">Snapshot</h2>
              <div className="grid grid-cols-2 gap-3">
                {vm.hasOutreachData && (
                  <Metric label="In outreach" value={String(d.outreach.open)} sub={`${d.outreach.winsRecent} won · 30d`} tone={d.outreach.open > 0 ? "info" : undefined} />
                )}
                {vm.hasContentData && (
                  <Metric label="Content queued" value={String(d.content.upcoming.length)} sub={d.content.overdue.length ? `${d.content.overdue.length} overdue` : `${d.content.ideas} ideas`} tone={d.content.overdue.length ? "attention" : undefined} />
                )}
                {vm.hasCampaignData && (
                  <Metric label="Campaigns" value={String(d.campaigns.total)} sub={`${d.campaigns.byStatus.live} live · ${d.campaigns.byStatus.planned} planned`} />
                )}
                {vm.hasReviewData && (
                  <Metric label="Reviews logged" value={stars} sub={`${d.reviews.count} logged · ${d.reviews.unresponded} to answer`} tone={d.reviews.unresponded ? "attention" : undefined} />
                )}
              </div>
            </section>
            )}

            {/* Channel hub — jump out to the tools, edit links in context. */}
            <ChannelHub initial={d.links} />

            {/* Reputation — explicit scope so "none logged" never reads as "no reviews". */}
            <section>
              <SectionHead title="Reputation" href="/marketing/reviews" linkLabel="All reviews" scope={vm.scope.reviews} />
              <Surface pad="none">
                <div className="flex items-center justify-between border-b border-[var(--row-rule)] px-3 py-2 text-[12.5px]">
                  <span className="flex items-center gap-1.5 text-foreground"><Star className="size-3.5 text-status-warning" aria-hidden /> {stars} avg</span>
                  <span className="text-[11.5px] text-meta">{d.reviews.count} logged{d.reviews.unresponded ? ` · ${d.reviews.unresponded} to answer` : ""}</span>
                </div>
                {d.reviews.recent.length === 0 ? (
                  <p className="p-3 text-[12px] text-meta">No reviews logged here yet. This tracks reviews you record manually; it does not read your Google or The Knot listings.</p>
                ) : (
                  d.reviews.recent.slice(0, 4).map((r) => (
                    <div key={r.id} className="border-t border-[var(--row-rule)] px-3 py-2 text-[12.5px] first:border-t-0">
                      <div className="flex items-center gap-2">
                        <span className="tabular-nums text-status-warning">{r.rating != null ? `${r.rating}★` : "—"}</span>
                        <span className="min-w-0 flex-1 truncate text-foreground">{r.reviewer || "Anonymous"}</span>
                        <span className="shrink-0 text-[11px] text-meta">{REVIEW_SOURCE_LABEL[r.source]}</span>
                        {!r.responded && <StatusBadge tone="attention" size="sm" className="shrink-0">Reply</StatusBadge>}
                      </div>
                      {r.text && <p className="mt-0.5 line-clamp-2 text-meta">{r.text}</p>}
                    </div>
                  ))
                )}
              </Surface>
            </section>

            {/* Outreach funnel + the explicit handoff to Radar / Sales OS. */}
            <section>
              <SectionHead title="Outreach funnel" href="/marketing/outreach" linkLabel="Work outreach" scope={vm.scope.outreach} />
              <Surface pad="sm" className="space-y-3">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="flex items-center gap-1.5 text-foreground"><Send className="size-3.5 text-meta" aria-hidden /> {d.outreach.open} in outreach</span>
                  <span className="flex items-center gap-1.5 text-foreground"><Trophy className="size-3.5 text-status-ready" aria-hidden /> {d.outreach.winsRecent} won · 30d</span>
                </div>
                {vm.hasOutreachData ? (
                  <div className="flex flex-wrap gap-1.5">
                    {PROSPECT_OPEN_STAGES.map((s) => (
                      <span key={s} className="rounded border border-border px-2 py-0.5 text-[11.5px] text-tertiary-text">
                        {PROSPECT_STATUS_LABEL[s]} <span className="tabular-nums text-meta">{d.outreach.byStage[s]}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11.5px] text-meta">No prospects yet. Add who you&apos;re reaching out to — the win is when they agree to a quote and cross into Goodshuffle.</p>
                )}
                {d.outreach.winsBySource.length > 0 && (
                  <div className="border-t border-[var(--row-rule)] pt-2">
                    <div className="mb-1 text-[11px] text-meta">Quotes won by channel</div>
                    <ul className="space-y-1.5">
                      {d.outreach.winsBySource.map((c) => {
                        const max = d.outreach.winsBySource[0].wins || 1;
                        return (
                          <li key={c.source} className="text-[12.5px]">
                            <div className="flex items-center justify-between"><span className="text-foreground">{c.label}</span><span className="tabular-nums text-meta">{c.wins}</span></div>
                            <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-[var(--bar)]"><div className="h-full bg-status-ready" style={{ width: `${Math.round((c.wins / max) * 100)}%` }} /></div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </Surface>
            </section>

            <HandoffNote />

            {/* AI activity — compact, secondary. "Coming / not wired" agents stay in AI Org. */}
            <section>
              <h2 className="mb-2 text-[13px] font-medium text-foreground">AI activity</h2>
              <BladeAgents blade="marketing" />
            </section>
          </>
        }
      />
    </BladeMain>
  );
}

/** Names the three outreach surfaces so operators know which is which and where a lead goes next. */
function HandoffNote({ className }: { className?: string }): React.JSX.Element {
  return (
    <StatusBanner
      tone="neutral"
      edge={false}
      icon={<Compass className="size-4 text-status-neutral" aria-hidden />}
      title="Where leads go next"
      className={className}
    >
      <ul className="space-y-1">
        <li><span className="text-foreground">Marketing outreach</span> is top-of-funnel prospects before Goodshuffle; the win is a quote agreed.</li>
        <li><Link href="/radar/outreach" className="text-foreground underline-offset-2 hover:underline">Radar outreach</Link> runs the B2B bid / opportunity pursuit track separately.</li>
        <li>Once a quote is agreed and the client is in Goodshuffle, <Link href="/salesos" className="text-foreground underline-offset-2 hover:underline">Sales OS</Link> owns the pipeline.</li>
      </ul>
    </StatusBanner>
  );
}
