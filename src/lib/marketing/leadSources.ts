// Inbound lead scoreboard: how many leads each channel (website form, Yelp, Google) brought in. PURE: the
// caller hands in rows from sales_intake, nothing here touches the DB.
//
// What counts (kept honest in the UI's scope line):
//  - Only leads that arrived through the lead Zaps (/api/intake/lead). Intakes typed in by sales (source
//    'manual' / 'quo' / blank) are not marketing channels and are left out.
//  - Our own test submissions (a Zoe email address) are left out.
//  - The same person submitting again on the same channel within a day counts once.
//  - Days are counted in the operating timezone, so "last 7 days" matches the office calendar.
//  - Goodshuffle wishlists go straight to Goodshuffle (not through the app) and are not counted here.

import { ymdInTz, shiftYmd } from "@/lib/dates";

/** One sales_intake row, only the fields the scoreboard needs. */
export interface InboundLeadRow {
  createdAt: string; // ISO timestamp
  source: string | null;
  email: string | null;
  phone: string | null;
}

export interface LeadChannelStats {
  key: string;
  label: string;
  last7: number;
  prev7: number;
  last30: number;
  /** Leads per rolling 7-day week, oldest first; the last entry is the week ending today. */
  weekly: number[];
  /** ISO time of the most recent counted lead in the window, or null. */
  lastAt: string | null;
}

export interface LeadScoreboard {
  today: string;
  weeks: number;
  /** Start day (YYYY-MM-DD) of each weekly bucket, oldest first. */
  weekStarts: string[];
  /** Core channels always listed (a real zero shows as 0); any other source appears after them. */
  channels: LeadChannelStats[];
  total: Omit<LeadChannelStats, "key" | "label">;
  /** Repeat submissions in the last 30 days that were counted once. */
  repeats30: number;
  /** Internal test submissions in the last 30 days that were left out. */
  internal30: number;
  /** True when at least one lead was counted in the whole window. */
  hasData: boolean;
}

export const LEAD_WEEKS = 8;
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INTERNAL_EMAIL_DOMAINS = ["zoeeventsdmv.com"];
/** Sources that mean "typed in by sales", not a marketing channel. */
const SALES_ENTERED = new Set(["", "manual", "quo"]);

const CORE_CHANNELS: { key: string; label: string }[] = [
  { key: "website", label: "Website form" },
  { key: "yelp", label: "Yelp" },
  { key: "google", label: "Google" },
];

/** Map a raw source tag onto a channel. Returns null for sales-entered intakes. */
export function leadChannel(source: string | null): { key: string; label: string } | null {
  const s = (source ?? "").trim().toLowerCase();
  if (SALES_ENTERED.has(s)) return null;
  if (s.includes("yelp")) return CORE_CHANNELS[1];
  if (s.includes("google")) return CORE_CHANNELS[2];
  if (/\b(web|website|site|form|contact)\b/.test(s.replace(/[_-]/g, " "))) return CORE_CHANNELS[0];
  const key = s.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "other";
  const label = s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { key, label };
}

function contactKey(r: InboundLeadRow): string | null {
  const email = (r.email ?? "").trim().toLowerCase();
  if (email) return `e:${email}`;
  const digits = (r.phone ?? "").replace(/\D/g, "").slice(-10);
  return digits.length >= 7 ? `p:${digits}` : null;
}

function isInternal(r: InboundLeadRow): boolean {
  const email = (r.email ?? "").trim().toLowerCase();
  return INTERNAL_EMAIL_DOMAINS.some((d) => email.endsWith(`@${d}`));
}

function emptyStats(key: string, label: string): LeadChannelStats {
  return { key, label, last7: 0, prev7: 0, last30: 0, weekly: Array(LEAD_WEEKS).fill(0), lastAt: null };
}

/** Oldest ISO timestamp the caller needs to fetch to fill the scoreboard (with a day of margin for tz). */
export function leadScoreboardSince(now: Date = new Date()): string {
  return new Date(now.getTime() - (LEAD_WEEKS * 7 + 2) * 24 * 60 * 60 * 1000).toISOString();
}

export function buildLeadScoreboard(rows: InboundLeadRow[], today: string, tz: string): LeadScoreboard {
  const weekStarts = Array.from({ length: LEAD_WEEKS }, (_, i) => shiftYmd(today, -7 * (LEAD_WEEKS - i) + 1));
  const windowStart = weekStarts[0];
  const start7 = shiftYmd(today, -6);
  const startPrev7 = shiftYmd(today, -13);
  const start30 = shiftYmd(today, -29);

  const byKey = new Map<string, LeadChannelStats>(CORE_CHANNELS.map((c) => [c.key, emptyStats(c.key, c.label)]));
  const total = emptyStats("total", "Total");
  const lastCounted = new Map<string, number>(); // channel + contact → time of the last counted lead
  let repeats30 = 0;
  let internal30 = 0;
  let counted = 0;

  const sorted = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of sorted) {
    const ch = leadChannel(r.source);
    if (!ch) continue;
    const t = Date.parse(r.createdAt);
    if (Number.isNaN(t)) continue;
    const day = ymdInTz(tz, new Date(t));
    if (day < windowStart || day > today) continue;
    const in30 = day >= start30;

    if (isInternal(r)) {
      if (in30) internal30++;
      continue;
    }
    const ck = contactKey(r);
    if (ck) {
      const k = `${ch.key}|${ck}`;
      const prev = lastCounted.get(k);
      if (prev != null && t - prev < REPEAT_WINDOW_MS) {
        if (in30) repeats30++;
        continue;
      }
      lastCounted.set(k, t);
    }

    let stats = byKey.get(ch.key);
    if (!stats) {
      stats = emptyStats(ch.key, ch.label);
      byKey.set(ch.key, stats);
    }
    const week = Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${windowStart}T00:00:00Z`)) / (7 * 86400000));
    for (const s of [stats, total]) {
      if (day >= start7) s.last7++;
      else if (day >= startPrev7) s.prev7++;
      if (in30) s.last30++;
      if (week >= 0 && week < LEAD_WEEKS) s.weekly[week]++;
      s.lastAt = r.createdAt;
    }
    counted++;
  }

  // Core channels first in their fixed order, then any other source by volume.
  const core = CORE_CHANNELS.map((c) => byKey.get(c.key)!);
  const extra = [...byKey.values()]
    .filter((s) => !CORE_CHANNELS.some((c) => c.key === s.key))
    .sort((a, b) => b.last30 - a.last30 || a.label.localeCompare(b.label));

  return {
    today,
    weeks: LEAD_WEEKS,
    weekStarts,
    channels: [...core, ...extra],
    total: { last7: total.last7, prev7: total.prev7, last30: total.last30, weekly: total.weekly, lastAt: total.lastAt },
    repeats30,
    internal30,
    hasData: counted > 0,
  };
}
