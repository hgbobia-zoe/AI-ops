// Marketing Command Center — deterministic aggregation over what the team runs OUTREACH on (prospects,
// campaigns, content, reviews). This is the top of funnel, BEFORE Goodshuffle: the win is "quote agreed"
// (they cross into Goodshuffle, then Sales OS owns the pipeline). Goodshuffle leads are intentionally not
// counted here. No fabrication.

import { todayInOpsTz } from "@/lib/dates";
import { listCampaigns, listContent, listReviews, listProspects, getChannelLinks } from "./store";
import {
  OUTREACH_SOURCE_LABEL, PROSPECT_OPEN_STAGES,
  type Campaign, type ContentItem, type Review, type Prospect, type ChannelLinks, type CampaignStatus, type ProspectStatus, type OutreachSource,
} from "./types";

const UPCOMING_DAYS = 21;
const WIN_WINDOW = 30; // "wins this month" lookback for quote-agreed prospects

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface MarketingDashboard {
  today: string;
  campaigns: {
    total: number;
    byStatus: Record<CampaignStatus, number>;
    live: Campaign[];
    activeBudget: number;
    activeSpend: number;
  };
  content: {
    upcoming: ContentItem[];
    overdue: ContentItem[];
    ideas: number;
  };
  reviews: {
    count: number;
    avgRating: number | null;
    unresponded: number;
    recent: Review[];
  };
  outreach: {
    open: number; // prospects still in an open stage
    byStage: Record<ProspectStatus, number>;
    winsRecent: number; // quote_agreed in the last WIN_WINDOW days
    dueThisWeek: Prospect[]; // open prospects with next_action within 7 days (or overdue)
    winsBySource: { source: OutreachSource; label: string; wins: number }[]; // which channels turn into agreed quotes
  };
  links: ChannelLinks;
}

export function marketingDashboard(today: string = todayInOpsTz()): MarketingDashboard {
  const campaigns = listCampaigns();
  const byStatus: Record<CampaignStatus, number> = { idea: 0, planned: 0, live: 0, paused: 0, done: 0 };
  for (const c of campaigns) byStatus[c.status]++;
  const live = campaigns.filter((c) => c.status === "live");
  const activeConsidered = campaigns.filter((c) => c.status === "live" || c.status === "planned");
  const activeBudget = activeConsidered.reduce((s, c) => s + (c.budget ?? 0), 0);
  const activeSpend = activeConsidered.reduce((s, c) => s + (c.spend ?? 0), 0);

  const content = listContent();
  const windowEnd = addDays(today, UPCOMING_DAYS);
  const notPosted = content.filter((c) => c.status !== "posted");
  const upcoming = notPosted.filter((c) => c.planDate && c.planDate >= today && c.planDate <= windowEnd);
  const overdue = notPosted.filter((c) => c.planDate && c.planDate < today);
  const ideas = content.filter((c) => c.status === "idea").length;

  const reviews = listReviews();
  const rated = reviews.filter((r) => r.rating != null) as (Review & { rating: number })[];
  const avgRating = rated.length ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10 : null;
  const unresponded = reviews.filter((r) => !r.responded).length;

  // Outreach funnel — the marketing win is "quote agreed".
  const prospects = listProspects();
  const byStage: Record<ProspectStatus, number> = { to_contact: 0, contacted: 0, responded: 0, quote_agreed: 0, not_interested: 0 };
  for (const p of prospects) byStage[p.status]++;
  const openStages = new Set<ProspectStatus>(PROSPECT_OPEN_STAGES);
  const open = prospects.filter((p) => openStages.has(p.status)).length;
  const winSince = addDays(today, -WIN_WINDOW);
  const winsRecent = prospects.filter((p) => p.status === "quote_agreed" && (p.wonAt ?? "").slice(0, 10) >= winSince).length;
  const weekEnd = addDays(today, 7);
  const dueThisWeek = prospects.filter((p) => openStages.has(p.status) && p.nextAction && p.nextAction <= weekEnd).slice(0, 8);
  const wonBucket = new Map<OutreachSource, number>();
  for (const p of prospects) {
    if (p.status !== "quote_agreed" || !p.source) continue;
    wonBucket.set(p.source, (wonBucket.get(p.source) ?? 0) + 1);
  }
  const winsBySource = [...wonBucket.entries()].map(([source, wins]) => ({ source, label: OUTREACH_SOURCE_LABEL[source], wins })).sort((a, b) => b.wins - a.wins);

  return {
    today,
    campaigns: { total: campaigns.length, byStatus, live, activeBudget, activeSpend },
    content: { upcoming, overdue, ideas },
    reviews: { count: reviews.length, avgRating, unresponded, recent: reviews.slice(0, 5) },
    outreach: { open, byStage, winsRecent, dueThisWeek, winsBySource },
    links: getChannelLinks(),
  };
}
