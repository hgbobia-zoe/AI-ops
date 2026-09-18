// Marketing Command Center — the operating dashboard for Zoe's demand generation. One screen: active
// campaigns, what's going out (content), reputation (reviews), where leads come from (attribution), and
// quick-launch links to the tools the team runs. Deterministic; honest about gaps. Working views live in
// the sub-blades. Two-track by design (weddings/social + corporate/gov).

import Link from "next/link";
import { Megaphone, CalendarDays, Star, ArrowUpRight, AlertTriangle } from "lucide-react";
import { marketingDashboard } from "@/lib/marketing/dashboard";
import { ChannelHub } from "@/components/marketing/ChannelHub";
import { REVIEW_SOURCE_LABEL, CHANNEL_LABEL, AUDIENCE_LABEL } from "@/lib/marketing/types";
import { formatYmdLong } from "@/lib/dates";

export const dynamic = "force-dynamic";

function money(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${Math.round(n)}`;
}

function Metric({ label, value, sub, href }: { label: string; value: string; sub?: string; href: string }): React.JSX.Element {
  return (
    <Link href={href} className="rounded border border-border p-3 transition-colors hover:bg-[var(--row-hover)]">
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-meta">{label}</div>
      <div className="mt-1 text-[22px] font-medium tabular-nums text-foreground">{value}</div>
      {sub && <div className="text-[11.5px] text-meta">{sub}</div>}
    </Link>
  );
}

function Section({ title, href, linkLabel, children }: { title: string; href: string; linkLabel: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</h2>
        <Link href={href} className="inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">{linkLabel} <ArrowUpRight className="size-3.5" /></Link>
      </div>
      {children}
    </section>
  );
}

export default function MarketingHome(): React.JSX.Element {
  const d = marketingDashboard();
  const stars = d.reviews.avgRating != null ? `${d.reviews.avgRating}★` : "—";

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight"><Megaphone className="size-5 text-meta" /> Marketing</h1>
        <p className="mt-1 text-[13px] text-meta">Zoe&apos;s demand-generation command center — campaigns, content, reputation, and lead sources across weddings/social and corporate/gov.</p>
      </header>

      {/* Metrics */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Campaigns" value={String(d.campaigns.total)} sub={`${d.campaigns.byStatus.live} live · ${d.campaigns.byStatus.planned} planned`} href="/marketing/campaigns" />
        <Metric label="Content queued" value={String(d.content.upcoming.length)} sub={d.content.overdue.length ? `${d.content.overdue.length} overdue` : `${d.content.ideas} ideas`} href="/marketing/content" />
        <Metric label="Reviews" value={stars} sub={`${d.reviews.count} logged · ${d.reviews.unresponded} to answer`} href="/marketing/reviews" />
        <Metric label="Leads tagged" value={String(d.leads.taggedCount)} sub={`of ${d.leads.consideredBookings} recent`} href="/marketing/sources" />
      </div>

      {/* Channel hub */}
      <div className="mb-5">
        <ChannelHub initial={d.links} />
      </div>

      <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
        <div>
          {/* Live campaigns */}
          <Section title="Live campaigns" href="/marketing/campaigns" linkLabel="All campaigns">
            <div className="rounded border border-border">
              {d.campaigns.live.length === 0 ? (
                <p className="p-3 text-[12.5px] text-meta">Nothing live right now. Plan a campaign to drive bookings.</p>
              ) : (
                d.campaigns.live.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[13px] first:border-t-0">
                    <span className="min-w-0 flex-1 truncate text-foreground">{c.name}</span>
                    <span className="shrink-0 text-[11.5px] text-meta">{AUDIENCE_LABEL[c.audience]}</span>
                    {c.budget != null && <span className="shrink-0 tabular-nums text-[12px] text-tertiary-text">{money(c.spend ?? 0)}/{money(c.budget)}</span>}
                  </div>
                ))
              )}
              {(d.campaigns.activeBudget > 0 || d.campaigns.activeSpend > 0) && (
                <div className="flex items-center justify-between border-t border-[var(--row-rule)] px-3 py-2 text-[12px] text-meta">
                  <span>Active spend vs budget</span>
                  <span className="tabular-nums text-tertiary-text">{money(d.campaigns.activeSpend)} / {money(d.campaigns.activeBudget)}</span>
                </div>
              )}
            </div>
          </Section>

          {/* Content */}
          <Section title="Going out next" href="/marketing/content" linkLabel="Content calendar">
            <div className="rounded border border-border">
              {d.content.overdue.length > 0 && (
                <div className="flex items-center gap-2 border-b border-[var(--row-rule)] bg-attention/[0.04] px-3 py-2 text-[12px] text-attention">
                  <AlertTriangle className="size-3.5" /> {d.content.overdue.length} planned {d.content.overdue.length === 1 ? "piece is" : "pieces are"} past date and not posted
                </div>
              )}
              {d.content.upcoming.length === 0 && d.content.overdue.length === 0 ? (
                <p className="p-3 text-[12.5px] text-meta">Nothing scheduled in the next three weeks. Plan content in Confluence, then log it here.</p>
              ) : (
                d.content.upcoming.slice(0, 6).map((c) => (
                  <div key={c.id} className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[13px] first:border-t-0">
                    <CalendarDays className="size-3.5 shrink-0 text-meta" />
                    <span className="min-w-0 flex-1 truncate text-foreground">{c.title}</span>
                    <span className="shrink-0 text-[11.5px] text-meta">{c.channel ? CHANNEL_LABEL[c.channel] : ""}</span>
                    <span className="shrink-0 tabular-nums text-[11.5px] text-tertiary-text">{c.planDate ? formatYmdLong(c.planDate) : ""}</span>
                  </div>
                ))
              )}
            </div>
          </Section>
        </div>

        <div>
          {/* Reviews */}
          <Section title="Reputation" href="/marketing/reviews" linkLabel="All reviews">
            <div className="rounded border border-border">
              <div className="flex items-center justify-between border-b border-[var(--row-rule)] px-3 py-2 text-[13px]">
                <span className="flex items-center gap-1.5 text-foreground"><Star className="size-3.5 text-attention" /> {stars} average</span>
                <span className="text-[12px] text-meta">{d.reviews.count} logged{d.reviews.unresponded ? ` · ${d.reviews.unresponded} to answer` : ""}</span>
              </div>
              {d.reviews.recent.length === 0 ? (
                <p className="p-3 text-[12.5px] text-meta">No reviews logged yet. Add your Google and The Knot reviews to track reputation.</p>
              ) : (
                d.reviews.recent.map((r) => (
                  <div key={r.id} className="border-t border-[var(--row-rule)] px-3 py-2 text-[12.5px] first:border-t-0">
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums text-attention">{r.rating != null ? `${r.rating}★` : "—"}</span>
                      <span className="text-foreground">{r.reviewer || "Anonymous"}</span>
                      <span className="text-[11px] text-meta">{REVIEW_SOURCE_LABEL[r.source]}</span>
                      {!r.responded && <span className="ml-auto rounded border border-attention/40 px-1.5 py-px text-[10px] uppercase tracking-[0.05em] text-attention">Reply</span>}
                    </div>
                    {r.text && <p className="mt-0.5 line-clamp-2 text-meta">{r.text}</p>}
                  </div>
                ))
              )}
            </div>
          </Section>

          {/* Lead sources */}
          <Section title="Where leads come from" href="/marketing/sources" linkLabel="Tag leads">
            <div className="rounded border border-border p-3">
              {d.leads.byChannel.length === 0 ? (
                <p className="text-[12.5px] text-meta">No leads tagged yet. Goodshuffle doesn&apos;t record how a lead heard about Zoe, so tag recent bookings to see which channels actually book.</p>
              ) : (
                <ul className="space-y-1.5">
                  {d.leads.byChannel.map((c) => {
                    const max = d.leads.byChannel[0].count || 1;
                    return (
                      <li key={c.channel} className="text-[12.5px]">
                        <div className="flex items-center justify-between">
                          <span className="text-foreground">{c.label}</span>
                          <span className="tabular-nums text-meta">{c.count}{c.revenue > 0 ? ` · ${money(c.revenue)}` : ""}</span>
                        </div>
                        <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-[var(--bar)]"><div className="h-full bg-positive" style={{ width: `${Math.round((c.count / max) * 100)}%` }} /></div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-2 border-t border-[var(--row-rule)] pt-2 text-[11px] text-meta">Tagged {d.leads.taggedCount} of {d.leads.consideredBookings} recent bookings. Attribution is manual until a lead-source field is captured from Goodshuffle.</p>
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}
