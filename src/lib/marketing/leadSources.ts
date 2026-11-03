// Inbound lead scoreboard: how many leads each channel (website form, Goodshuffle wishlist, Yelp, Google)
// brought in, for the last 7 days, the week before, 30 days and all time. PURE: callers hand in records.
//
// Where the records come from (see leadLog.ts): the marketing lead log, every lead post in Slack #new-leads
// saved into the app so it is kept for good (Slack's free plan hides posts older than 90 days). Every lead
// path posts there (website form and wishlist Zaps, the old Google Zap, the app's own Yelp and Google
// posts). sales_intake is deliberately NOT counted: it only starts Oct 31, 2026 and also holds Zapier
// "test step" replays of older leads, which made the live count one too high (2026-11-03).
//
// Counting rules (shown on the page):
//  - Days follow the office timezone.
//  - The same person on the same channel within 24 hours counts once (matched by email, phone, or the name
//    for wishlists, which carry no contact).
//  - Test leads are left out: Zoe or example email addresses, a name with "test", or a test message.
//  - Each channel shows the day its record starts, so a short history never reads as a slow channel.

import { ymdInTz, shiftYmd } from "@/lib/dates";

/** One inbound lead, already mapped onto a channel. */
export interface LeadRecord {
  receivedAt: string; // ISO timestamp
  channel: string; // channel key
  name: string;
  email: string;
  phone: string;
  isTest: boolean;
}

export interface LeadChannelStats {
  key: string;
  label: string;
  last7: number;
  /** null when this channel's record starts after that week ended. */
  prev7: number | null;
  last30: number;
  allTime: number;
  /** Leads per calendar month, aligned with LeadScoreboard.months. */
  monthly: number[];
  /** First day (YYYY-MM-DD) with a counted lead on this channel, or null when there is none yet. */
  since: string | null;
  /** ISO time of the most recent counted lead, or null. */
  lastAt: string | null;
}

export interface LeadScoreboard {
  today: string;
  /** Calendar months (YYYY-MM) shown in the trend, oldest first, ending with the current month. */
  months: string[];
  channels: LeadChannelStats[];
  total: Omit<LeadChannelStats, "key" | "label">;
  /** Repeat submissions counted once, last 30 days and all time. */
  repeats30: number;
  repeatsAll: number;
  /** Test leads left out, last 30 days and all time. */
  tests30: number;
  testsAll: number;
  hasData: boolean;
}

export const TREND_MONTHS = 12;
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TEST_EMAIL_DOMAINS = ["zoeeventsdmv.com", "example.com", "example.org", "example.net"];

/** Sources that mean "typed in by sales", not a marketing channel. */
const SALES_ENTERED = new Set(["", "manual", "quo"]);

export const CORE_CHANNELS: { key: string; label: string }[] = [
  { key: "website", label: "Website form" },
  { key: "wishlist", label: "Website wishlist" },
  { key: "yelp", label: "Yelp" },
  { key: "google", label: "Google" },
];
const CORE = Object.fromEntries(CORE_CHANNELS.map((c) => [c.key, c]));

/** Map a raw source tag onto a channel. Returns null for sales-entered intakes. */
export function leadChannel(source: string | null): { key: string; label: string } | null {
  const s = (source ?? "").trim().toLowerCase();
  if (SALES_ENTERED.has(s)) return null;
  if (s.includes("wishlist")) return CORE.wishlist;
  if (s.includes("yelp")) return CORE.yelp;
  if (s.includes("google")) return CORE.google;
  if (/\b(web|website|site|form|contact)\b/.test(s.replace(/[_-]/g, " "))) return CORE.website;
  // The website Zap sometimes tags a lead with the site's domain ("zoeeventsdmv.com").
  if (s.includes("zoeevents") || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s)) return CORE.website;
  const key = s.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "other";
  const label = s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { key, label };
}

export function channelLabel(key: string): string {
  return CORE[key]?.label ?? leadChannel(key)?.label ?? key;
}

/** A submission the team made to test the flow, not a customer. */
export function isTestLead(l: { name?: string; email?: string; message?: string }): boolean {
  const email = (l.email ?? "").trim().toLowerCase();
  if (TEST_EMAIL_DOMAINS.some((d) => email.endsWith(`@${d}`))) return true;
  if (/test/i.test(l.name ?? "")) return true;
  const msg = (l.message ?? "").trim();
  return /^(hello\s+|hi\s+)?test\b/i.test(msg) || /\btest (lead|event|submission)\b/i.test(msg) || /please ignore/i.test(msg);
}

function contactKey(r: LeadRecord): string | null {
  const email = r.email.trim().toLowerCase();
  if (email) return `e:${email}`;
  const digits = r.phone.replace(/\D/g, "").slice(-10);
  if (digits.length >= 7) return `p:${digits}`;
  const name = r.name.trim().toLowerCase().replace(/\s+/g, " ");
  return name && name !== "(no name)" ? `n:${name}` : null;
}

function emptyStats(key: string, label: string): LeadChannelStats {
  return { key, label, last7: 0, prev7: 0, last30: 0, allTime: 0, monthly: Array(TREND_MONTHS).fill(0), since: null, lastAt: null };
}

function monthList(today: string): string[] {
  const [y, m] = today.split("-").map(Number);
  return Array.from({ length: TREND_MONTHS }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (TREND_MONTHS - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export function buildLeadScoreboard(records: LeadRecord[], today: string, tz: string): LeadScoreboard {
  const months = monthList(today);
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const start7 = shiftYmd(today, -6);
  const startPrev7 = shiftYmd(today, -13);
  const endPrev7 = shiftYmd(today, -7);
  const start30 = shiftYmd(today, -29);

  const byKey = new Map<string, LeadChannelStats>(CORE_CHANNELS.map((c) => [c.key, emptyStats(c.key, c.label)]));
  const total = emptyStats("total", "Total");
  const lastCounted = new Map<string, number>();
  let repeats30 = 0, repeatsAll = 0, tests30 = 0, testsAll = 0;

  const sorted = [...records].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  for (const r of sorted) {
    const t = Date.parse(r.receivedAt);
    if (Number.isNaN(t)) continue;
    const day = ymdInTz(tz, new Date(t));
    if (day > today) continue;
    const in30 = day >= start30;

    if (r.isTest) {
      testsAll++;
      if (in30) tests30++;
      continue;
    }
    const ck = contactKey(r);
    if (ck) {
      const k = `${r.channel}|${ck}`;
      const prev = lastCounted.get(k);
      if (prev != null && t - prev < REPEAT_WINDOW_MS) {
        repeatsAll++;
        if (in30) repeats30++;
        continue;
      }
      lastCounted.set(k, t);
    }

    let stats = byKey.get(r.channel);
    if (!stats) {
      stats = emptyStats(r.channel, channelLabel(r.channel));
      byKey.set(r.channel, stats);
    }
    const mi = monthIndex.get(day.slice(0, 7));
    for (const s of [stats, total]) {
      s.allTime++;
      if (day >= start7) s.last7++;
      else if (day >= startPrev7) s.prev7 = (s.prev7 ?? 0) + 1;
      if (in30) s.last30++;
      if (mi != null) s.monthly[mi]++;
      if (!s.since) s.since = day;
      s.lastAt = r.receivedAt;
    }
  }

  // A week before a channel's record began is unknown, not zero.
  for (const s of [...byKey.values(), total]) {
    if (!s.since || s.since > endPrev7) s.prev7 = null;
  }

  const core = CORE_CHANNELS.map((c) => byKey.get(c.key)!);
  const extra = [...byKey.values()]
    .filter((s) => !CORE[s.key])
    .sort((a, b) => b.allTime - a.allTime || a.label.localeCompare(b.label));

  return {
    today,
    months,
    channels: [...core, ...extra],
    total: {
      last7: total.last7, prev7: total.prev7, last30: total.last30, allTime: total.allTime,
      monthly: total.monthly, since: total.since, lastAt: total.lastAt,
    },
    repeats30, repeatsAll, tests30, testsAll,
    hasData: total.allTime > 0,
  };
}
