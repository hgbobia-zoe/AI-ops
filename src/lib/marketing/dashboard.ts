// Marketing Command Center — deterministic aggregation over what the team has entered (campaigns,
// content plan, reviews) plus the booking data the app already holds (for lead-source attribution).
// Honest about gaps: Goodshuffle does not tell us how a lead heard about Zoe, so attribution only counts
// bookings a person has tagged. No fabrication.

import { todayInOpsTz } from "@/lib/dates";
import { getRecentBookings } from "@/lib/db/repo";
import { listCampaigns, listContent, listReviews, getLeadTags, getChannelLinks } from "./store";
import { LEAD_CHANNEL_LABEL, type Campaign, type ContentItem, type Review, type ChannelLinks, type LeadChannel, type CampaignStatus } from "./types";

const ATTRIBUTION_WINDOW = 90; // recent bookings we consider for the lead-source snapshot
const UPCOMING_DAYS = 21;

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
    upcoming: ContentItem[]; // planned within the next window, not yet posted
    overdue: ContentItem[]; // planned in the past, not yet posted
    ideas: number;
  };
  reviews: {
    count: number;
    avgRating: number | null;
    unresponded: number;
    recent: Review[];
  };
  leads: {
    consideredBookings: number; // recent bookings in the window
    taggedCount: number;
    byChannel: { channel: LeadChannel; label: string; count: number; revenue: number }[];
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

  // Lead-source attribution — recent bookings joined with manual channel tags.
  const windowStart = addDays(today, -ATTRIBUTION_WINDOW);
  const recent = getRecentBookings(200).filter((b) => (b.dateCreated ?? b.eventDate ?? "") >= windowStart);
  const tags = getLeadTags();
  const bucket = new Map<LeadChannel, { count: number; revenue: number }>();
  let taggedCount = 0;
  for (const b of recent) {
    const tag = tags.get(b.bookingId);
    if (!tag?.channel) continue;
    taggedCount++;
    const cur = bucket.get(tag.channel) ?? { count: 0, revenue: 0 };
    cur.count++;
    if (b.signed && b.grandTotal) cur.revenue += b.grandTotal;
    bucket.set(tag.channel, cur);
  }
  const byChannel = [...bucket.entries()]
    .map(([channel, v]) => ({ channel, label: LEAD_CHANNEL_LABEL[channel], count: v.count, revenue: v.revenue }))
    .sort((a, b) => b.count - a.count);

  return {
    today,
    campaigns: { total: campaigns.length, byStatus, live, activeBudget, activeSpend },
    content: { upcoming, overdue, ideas },
    reviews: { count: reviews.length, avgRating, unresponded, recent: reviews.slice(0, 5) },
    leads: { consideredBookings: recent.length, taggedCount, byChannel },
    links: getChannelLinks(),
  };
}
