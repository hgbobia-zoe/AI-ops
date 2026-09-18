// Marketing module — PURE shapes + option sets shared by the server stores and the client surfaces.
// No DB import. Zoe runs marketing across social, SEO/blog, reviews/directories and email, for BOTH a
// B2C (weddings/social) and a B2B (corporate/gov) audience. The app is the operating dashboard over the
// tools the team already uses (Confluence, a social poster, ManyChat, Google Business). FACTS only.

// ── Channels the team actually runs (from setup) ──────────────────────────────────────────────────
export type Channel = "social" | "email" | "blog" | "reviews";
export const CHANNEL_LABEL: Record<Channel, string> = {
  social: "Social",
  email: "Email & newsletters",
  blog: "SEO / website / blog",
  reviews: "Reviews & directories",
};
export const CHANNELS: Channel[] = ["social", "email", "blog", "reviews"];

// ── Audience — two-track B2C / B2B ────────────────────────────────────────────────────────────────
export type Audience = "b2c" | "b2b" | "both";
export const AUDIENCE_LABEL: Record<Audience, string> = {
  b2c: "Weddings & social",
  b2b: "Corporate & gov",
  both: "Both",
};
export const AUDIENCES: Audience[] = ["b2c", "b2b", "both"];

// ── Campaign ──────────────────────────────────────────────────────────────────────────────────────
export type CampaignStatus = "idea" | "planned" | "live" | "paused" | "done";
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  idea: "Idea", planned: "Planned", live: "Live", paused: "Paused", done: "Done",
};
export const CAMPAIGN_STATUS_ORDER: CampaignStatus[] = ["idea", "planned", "live", "paused", "done"];

export interface Campaign {
  id: string;
  name: string;
  objective: string;
  channels: Channel[];
  audience: Audience;
  status: CampaignStatus;
  budget: number | null;
  spend: number | null;
  startDate: string | null;
  endDate: string | null;
  goalMetric: string;
  resultLeads: number | null;
  resultBookings: number | null;
  resultRevenue: number | null;
  link: string;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignInput {
  name: string;
  objective?: string;
  channels?: Channel[];
  audience?: Audience;
  status?: CampaignStatus;
  budget?: number | null;
  spend?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  goalMetric?: string;
  resultLeads?: number | null;
  resultBookings?: number | null;
  resultRevenue?: number | null;
  link?: string;
  notes?: string;
}

// ── Content calendar ──────────────────────────────────────────────────────────────────────────────
export type ContentStatus = "idea" | "drafting" | "scheduled" | "posted";
export const CONTENT_STATUS_LABEL: Record<ContentStatus, string> = {
  idea: "Idea", drafting: "Drafting", scheduled: "Scheduled", posted: "Posted",
};
export const CONTENT_STATUS_ORDER: ContentStatus[] = ["idea", "drafting", "scheduled", "posted"];

export interface ContentItem {
  id: string;
  title: string;
  channel: Channel | null;
  format: string;
  planDate: string | null;
  status: ContentStatus;
  audience: Audience;
  owner: string;
  link: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentInput {
  title: string;
  channel?: Channel | null;
  format?: string;
  planDate?: string | null;
  status?: ContentStatus;
  audience?: Audience;
  owner?: string;
  link?: string;
  notes?: string;
}

// ── Reviews & reputation ──────────────────────────────────────────────────────────────────────────
export type ReviewSource = "google" | "the_knot" | "wedding_wire" | "yelp" | "facebook" | "other";
export const REVIEW_SOURCE_LABEL: Record<ReviewSource, string> = {
  google: "Google", the_knot: "The Knot", wedding_wire: "WeddingWire", yelp: "Yelp", facebook: "Facebook", other: "Other",
};
export const REVIEW_SOURCES: ReviewSource[] = ["google", "the_knot", "wedding_wire", "yelp", "facebook", "other"];

export interface Review {
  id: string;
  source: ReviewSource;
  reviewer: string;
  rating: number | null; // 1..5
  reviewDate: string | null;
  text: string;
  responded: boolean;
  responseNote: string;
  link: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewInput {
  source?: ReviewSource;
  reviewer?: string;
  rating?: number | null;
  reviewDate?: string | null;
  text?: string;
  responded?: boolean;
  responseNote?: string;
  link?: string;
}

// ── Lead-source attribution (manual) ──────────────────────────────────────────────────────────────
export type LeadChannel = "referral" | "instagram" | "facebook" | "google" | "the_knot" | "wedding_wire" | "website" | "repeat" | "other";
export const LEAD_CHANNEL_LABEL: Record<LeadChannel, string> = {
  referral: "Referral / word of mouth", instagram: "Instagram", facebook: "Facebook", google: "Google search",
  the_knot: "The Knot", wedding_wire: "WeddingWire", website: "Website", repeat: "Repeat customer", other: "Other",
};
export const LEAD_CHANNELS: LeadChannel[] = ["referral", "instagram", "facebook", "google", "the_knot", "wedding_wire", "website", "repeat", "other"];

// ── Channel hub — links to the external tools the team runs ────────────────────────────────────────
export interface ChannelLinks {
  confluence: string; // content planning
  poster: string; // IG/FB posting tool
  manychat: string; // conversation + IG automation
  googleBusiness: string;
  instagram: string;
  facebook: string;
  theKnot: string;
  weddingWire: string;
  website: string;
}
export const CHANNEL_LINK_FIELDS: { key: keyof ChannelLinks; label: string; hint?: string }[] = [
  { key: "confluence", label: "Confluence", hint: "content planning" },
  { key: "poster", label: "Social poster", hint: "IG / FB scheduling tool" },
  { key: "manychat", label: "ManyChat", hint: "conversations + IG automation" },
  { key: "googleBusiness", label: "Google Business Profile" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "theKnot", label: "The Knot" },
  { key: "weddingWire", label: "WeddingWire" },
  { key: "website", label: "Website" },
];
export function emptyChannelLinks(): ChannelLinks {
  return { confluence: "", poster: "", manychat: "", googleBusiness: "", instagram: "", facebook: "", theKnot: "", weddingWire: "", website: "" };
}
