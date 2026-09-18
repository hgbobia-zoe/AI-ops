// Marketing module — persistence + reads. FACTS the team enters (campaigns, content plan, reviews,
// per-booking channel tags) plus the channel-hub links. Deterministic; no fabrication. The dashboard
// aggregation lives in dashboard.ts.

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/index";
import {
  type Campaign, type CampaignInput, type CampaignStatus,
  type ContentItem, type ContentInput, type ContentStatus,
  type Review, type ReviewInput, type ReviewSource,
  type LeadChannel, type Channel, type Audience,
  type ChannelLinks, emptyChannelLinks,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// ── Campaigns ─────────────────────────────────────────────────────────────────────────────────────
function toCampaign(r: any): Campaign {
  return {
    id: r.id, name: r.name, objective: r.objective ?? "",
    channels: r.channels ? (JSON.parse(r.channels) as Channel[]) : [],
    audience: (r.audience as Audience) ?? "both", status: r.status as CampaignStatus,
    budget: r.budget ?? null, spend: r.spend ?? null, startDate: r.start_date ?? null, endDate: r.end_date ?? null,
    goalMetric: r.goal_metric ?? "", resultLeads: r.result_leads ?? null, resultBookings: r.result_bookings ?? null, resultRevenue: r.result_revenue ?? null,
    link: r.link ?? "", notes: r.notes ?? "", createdBy: r.created_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export function listCampaigns(): Campaign[] {
  return (getDb().prepare("SELECT * FROM marketing_campaigns ORDER BY (start_date IS NULL), start_date DESC, created_at DESC").all() as any[]).map(toCampaign);
}
export function getCampaign(id: string): Campaign | null {
  const r = getDb().prepare("SELECT * FROM marketing_campaigns WHERE id = ?").get(id);
  return r ? toCampaign(r) : null;
}
export function createCampaign(input: CampaignInput, createdBy: string | null = null): Campaign {
  const id = `MC-${randomUUID()}`;
  const ts = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO marketing_campaigns (id, name, objective, channels, audience, status, budget, spend, start_date, end_date,
       goal_metric, result_leads, result_bookings, result_revenue, link, notes, created_by, created_at, updated_at)
     VALUES (@id,@name,@objective,@channels,@audience,@status,@budget,@spend,@start_date,@end_date,@goal_metric,@result_leads,@result_bookings,@result_revenue,@link,@notes,@created_by,@ts,@ts)`,
  ).run({
    id, name: str(input.name) || "Untitled campaign", objective: str(input.objective),
    channels: JSON.stringify(input.channels ?? []), audience: input.audience ?? "both", status: input.status ?? "idea",
    budget: numOrNull(input.budget), spend: numOrNull(input.spend), start_date: input.startDate || null, end_date: input.endDate || null,
    goal_metric: str(input.goalMetric), result_leads: numOrNull(input.resultLeads), result_bookings: numOrNull(input.resultBookings), result_revenue: numOrNull(input.resultRevenue),
    link: str(input.link), notes: str(input.notes), created_by: createdBy, ts,
  });
  return getCampaign(id)!;
}
export function updateCampaign(id: string, input: CampaignInput): Campaign | null {
  const prev = getCampaign(id);
  if (!prev) return null;
  const ts = new Date().toISOString();
  const merge = <T>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);
  getDb().prepare(
    `UPDATE marketing_campaigns SET name=@name, objective=@objective, channels=@channels, audience=@audience, status=@status,
       budget=@budget, spend=@spend, start_date=@start_date, end_date=@end_date, goal_metric=@goal_metric,
       result_leads=@result_leads, result_bookings=@result_bookings, result_revenue=@result_revenue, link=@link, notes=@notes, updated_at=@ts WHERE id=@id`,
  ).run({
    id, name: str(merge(input.name, prev.name)) || prev.name, objective: str(merge(input.objective, prev.objective)),
    channels: JSON.stringify(merge(input.channels, prev.channels)), audience: merge(input.audience, prev.audience), status: merge(input.status, prev.status),
    budget: input.budget !== undefined ? numOrNull(input.budget) : prev.budget, spend: input.spend !== undefined ? numOrNull(input.spend) : prev.spend,
    start_date: merge(input.startDate, prev.startDate) || null, end_date: merge(input.endDate, prev.endDate) || null, goal_metric: str(merge(input.goalMetric, prev.goalMetric)),
    result_leads: input.resultLeads !== undefined ? numOrNull(input.resultLeads) : prev.resultLeads,
    result_bookings: input.resultBookings !== undefined ? numOrNull(input.resultBookings) : prev.resultBookings,
    result_revenue: input.resultRevenue !== undefined ? numOrNull(input.resultRevenue) : prev.resultRevenue,
    link: str(merge(input.link, prev.link)), notes: str(merge(input.notes, prev.notes)), ts,
  });
  return getCampaign(id);
}
export function deleteCampaign(id: string): boolean {
  return getDb().prepare("DELETE FROM marketing_campaigns WHERE id = ?").run(id).changes > 0;
}

// ── Content calendar ──────────────────────────────────────────────────────────────────────────────
function toContent(r: any): ContentItem {
  return {
    id: r.id, title: r.title, channel: (r.channel as Channel) ?? null, format: r.format ?? "", planDate: r.plan_date ?? null,
    status: r.status as ContentStatus, audience: (r.audience as Audience) ?? "both", owner: r.owner ?? "", link: r.link ?? "", notes: r.notes ?? "",
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export function listContent(): ContentItem[] {
  return (getDb().prepare("SELECT * FROM marketing_content ORDER BY (plan_date IS NULL), plan_date ASC, created_at DESC").all() as any[]).map(toContent);
}
export function getContent(id: string): ContentItem | null {
  const r = getDb().prepare("SELECT * FROM marketing_content WHERE id = ?").get(id);
  return r ? toContent(r) : null;
}
export function createContent(input: ContentInput): ContentItem {
  const id = `MK-${randomUUID()}`;
  const ts = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO marketing_content (id, title, channel, format, plan_date, status, audience, owner, link, notes, created_at, updated_at)
     VALUES (@id,@title,@channel,@format,@plan_date,@status,@audience,@owner,@link,@notes,@ts,@ts)`,
  ).run({
    id, title: str(input.title) || "Untitled", channel: input.channel ?? null, format: str(input.format), plan_date: input.planDate || null,
    status: input.status ?? "idea", audience: input.audience ?? "both", owner: str(input.owner), link: str(input.link), notes: str(input.notes), ts,
  });
  return getContent(id)!;
}
export function updateContent(id: string, input: ContentInput): ContentItem | null {
  const prev = getContent(id);
  if (!prev) return null;
  const ts = new Date().toISOString();
  const merge = <T>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);
  getDb().prepare(
    `UPDATE marketing_content SET title=@title, channel=@channel, format=@format, plan_date=@plan_date, status=@status, audience=@audience, owner=@owner, link=@link, notes=@notes, updated_at=@ts WHERE id=@id`,
  ).run({
    id, title: str(merge(input.title, prev.title)) || prev.title, channel: merge(input.channel, prev.channel), format: str(merge(input.format, prev.format)),
    plan_date: merge(input.planDate, prev.planDate) || null, status: merge(input.status, prev.status), audience: merge(input.audience, prev.audience),
    owner: str(merge(input.owner, prev.owner)), link: str(merge(input.link, prev.link)), notes: str(merge(input.notes, prev.notes)), ts,
  });
  return getContent(id);
}
export function deleteContent(id: string): boolean {
  return getDb().prepare("DELETE FROM marketing_content WHERE id = ?").run(id).changes > 0;
}

// ── Reviews ───────────────────────────────────────────────────────────────────────────────────────
function toReview(r: any): Review {
  return {
    id: r.id, source: (r.source as ReviewSource) ?? "other", reviewer: r.reviewer ?? "", rating: r.rating ?? null, reviewDate: r.review_date ?? null,
    text: r.text ?? "", responded: !!r.responded, responseNote: r.response_note ?? "", link: r.link ?? "", createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export function listReviews(): Review[] {
  return (getDb().prepare("SELECT * FROM marketing_reviews ORDER BY (review_date IS NULL), review_date DESC, created_at DESC").all() as any[]).map(toReview);
}
export function getReview(id: string): Review | null {
  const r = getDb().prepare("SELECT * FROM marketing_reviews WHERE id = ?").get(id);
  return r ? toReview(r) : null;
}
export function createReview(input: ReviewInput): Review {
  const id = `MR-${randomUUID()}`;
  const ts = new Date().toISOString();
  const rating = input.rating == null ? null : Math.max(1, Math.min(5, Math.round(Number(input.rating))));
  getDb().prepare(
    `INSERT INTO marketing_reviews (id, source, reviewer, rating, review_date, text, responded, response_note, link, created_at, updated_at)
     VALUES (@id,@source,@reviewer,@rating,@review_date,@text,@responded,@response_note,@link,@ts,@ts)`,
  ).run({
    id, source: input.source ?? "other", reviewer: str(input.reviewer), rating, review_date: input.reviewDate || null, text: str(input.text),
    responded: input.responded ? 1 : 0, response_note: str(input.responseNote), link: str(input.link), ts,
  });
  return getReview(id)!;
}
export function updateReview(id: string, input: ReviewInput): Review | null {
  const prev = getReview(id);
  if (!prev) return null;
  const ts = new Date().toISOString();
  const merge = <T>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);
  const rating = input.rating !== undefined ? (input.rating == null ? null : Math.max(1, Math.min(5, Math.round(Number(input.rating))))) : prev.rating;
  getDb().prepare(
    `UPDATE marketing_reviews SET source=@source, reviewer=@reviewer, rating=@rating, review_date=@review_date, text=@text, responded=@responded, response_note=@response_note, link=@link, updated_at=@ts WHERE id=@id`,
  ).run({
    id, source: merge(input.source, prev.source), reviewer: str(merge(input.reviewer, prev.reviewer)), rating, review_date: merge(input.reviewDate, prev.reviewDate) || null,
    text: str(merge(input.text, prev.text)), responded: merge(input.responded, prev.responded) ? 1 : 0, response_note: str(merge(input.responseNote, prev.responseNote)), link: str(merge(input.link, prev.link)), ts,
  });
  return getReview(id);
}
export function deleteReview(id: string): boolean {
  return getDb().prepare("DELETE FROM marketing_reviews WHERE id = ?").run(id).changes > 0;
}

// ── Lead-source tags (manual attribution on a booking) ────────────────────────────────────────────
export interface LeadTag { bookingId: string; channel: LeadChannel | null; note: string; taggedBy: string | null; updatedAt: string }
function toTag(r: any): LeadTag {
  return { bookingId: r.booking_id, channel: (r.channel as LeadChannel) ?? null, note: r.note ?? "", taggedBy: r.tagged_by ?? null, updatedAt: r.updated_at };
}
export function getLeadTags(): Map<string, LeadTag> {
  const rows = (getDb().prepare("SELECT * FROM marketing_lead_tags").all() as any[]).map(toTag);
  return new Map(rows.map((t) => [t.bookingId, t]));
}
export function setLeadTag(bookingId: string, channel: LeadChannel | null, note: string, taggedBy: string | null): void {
  const ts = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO marketing_lead_tags (booking_id, channel, note, tagged_by, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(booking_id) DO UPDATE SET channel=excluded.channel, note=excluded.note, tagged_by=excluded.tagged_by, updated_at=excluded.updated_at`,
  ).run(bookingId, channel, str(note), taggedBy, ts);
}

// ── Channel hub links (settings KV) ───────────────────────────────────────────────────────────────
const LINKS_KEY = "marketing_links";
export function getChannelLinks(): ChannelLinks {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(LINKS_KEY) as { value: string } | undefined;
  if (!row) return emptyChannelLinks();
  try {
    return { ...emptyChannelLinks(), ...(JSON.parse(row.value) as Partial<ChannelLinks>) };
  } catch {
    return emptyChannelLinks();
  }
}
export function saveChannelLinks(input: ChannelLinks): ChannelLinks {
  const clean = { ...emptyChannelLinks() };
  for (const k of Object.keys(clean) as (keyof ChannelLinks)[]) clean[k] = str(input[k]);
  getDb().prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(LINKS_KEY, JSON.stringify(clean), new Date().toISOString());
  return clean;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
