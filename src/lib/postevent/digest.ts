// Post-Event daily nudge — one morning Slack card from the Customer Experience Bot listing the customers
// who need us today. The blade is otherwise pull-only: if nobody opens it, eligible customers sit in
// "Needs follow-up" with no reminder. This pushes the work out once a day.
//
// RULES CALCULATE. The card is built from the same board cards the Kanban shows (buildBoard), so every
// count is a real card. Each card lands in at most one section, service-first: service recovery, then
// overdue, then due today, then ready for a review invite. Nothing due → no post (never nag an empty day).
// House rules: plain wording, no dashes or emoji in the copy, system notice (no actor attribution).

import { getJson, setJson } from "@/lib/kv";
import { flagOn } from "@/lib/flags";
import { formatYmdLong } from "@/lib/dates";
import { appUrl, botAnnounce, type BotCard } from "@/lib/notify/aiBots";
import type { SlackResult } from "@/lib/notify/slack";
import { buildBoard } from "./engine";
import { NEXT_ACTION_LABEL, POSTEVENT_STATE_ORDER, type PostEventCard } from "./types";

export type DigestSectionKey = "recover" | "overdue" | "due_today" | "invite";

const SECTION_ORDER: DigestSectionKey[] = ["recover", "overdue", "due_today", "invite"];

const SECTION_META: Record<DigestSectionKey, { title: string; summary: string; queue: string | null }> = {
  recover: { title: "Service recovery", summary: "service recovery", queue: "issues" },
  overdue: { title: "Overdue follow ups", summary: "overdue", queue: "overdue" },
  due_today: { title: "Due today", summary: "due today", queue: "due" },
  invite: { title: "Ready for a review invite", summary: "ready for a review invite", queue: null },
};

export interface DigestSection {
  key: DigestSectionKey;
  title: string;
  total: number;
  lines: string[]; // capped at maxPerSection
  more: number; // total minus the lines shown
}

export interface Digest {
  total: number;
  sections: DigestSection[];
  card: BotCard;
}

export interface DigestOptions {
  /** Lines shown per section before "and N more". */
  maxPerSection?: number;
  /** Builds an absolute app link for a path, or null when no public base URL is set (links drop). */
  link?: (path: string) => string | null;
}

/** Which section a card belongs to (service-first), or null when it needs nothing from us today. */
export function sectionFor(c: PostEventCard): DigestSectionKey | null {
  if (c.state === "closed") return null;
  if (c.openIssues > 0 || c.nextAction === "escalate" || c.nextAction === "follow_resolution") return "recover";
  if (c.overdue) return "overdue";
  if (c.dueToday) return "due_today";
  if (c.nextAction === "send_review_request") return "invite";
  return null;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86400000);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Slack mrkdwn escaping for free text (customer and event names come from Goodshuffle). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lineFor(c: PostEventCard, key: DigestSectionKey, today: string, link: (p: string) => string | null): string {
  const url = link(`/postevent/project/${encodeURIComponent(c.bookingId)}`);
  const name = url ? `<${url}|${esc(c.customer)}>` : `*${esc(c.customer)}*`;
  const when = c.eventDate ? ` (${formatYmdLong(c.eventDate.slice(0, 10))})` : "";
  const parts = [`${name}, ${esc(c.eventName)}${when}.`];
  if (key === "recover") {
    parts.push(c.openIssues > 0 ? `${plural(c.openIssues, "open issue", "open issues")}.` : "Needs escalation.");
  } else if (key === "invite") {
    parts.push("Positive experience confirmed.");
  } else {
    parts.push(`Next: ${NEXT_ACTION_LABEL[c.nextAction]}.`);
  }
  if (key === "overdue" && c.dueAt) {
    const late = daysBetween(c.dueAt, today);
    if (late > 0) parts.push(`${plural(late, "day", "days")} overdue.`);
  }
  parts.push(`Owner: ${c.assignedEmployee ? esc(c.assignedEmployee) : "unassigned"}.`);
  return parts.join(" ");
}

/** Build the morning digest from the board cards. Pure (given `link`); null when nothing needs us today. */
export function buildDigest(cards: PostEventCard[], today: string, opts: DigestOptions = {}): Digest | null {
  const max = Math.max(1, opts.maxPerSection ?? 8);
  const link = opts.link ?? (() => null);

  const buckets = new Map<DigestSectionKey, PostEventCard[]>();
  for (const c of cards) {
    const key = sectionFor(c);
    if (!key) continue;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(c);
  }

  const sections: DigestSection[] = [];
  for (const key of SECTION_ORDER) {
    const list = buckets.get(key) ?? [];
    if (list.length === 0) continue;
    // Most urgent first: longest overdue / longest in stage at the top.
    list.sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || b.daysInStage - a.daysInStage);
    const shown = list.slice(0, max);
    sections.push({ key, title: SECTION_META[key].title, total: list.length, lines: shown.map((c) => lineFor(c, key, today, link)), more: list.length - shown.length });
  }
  const total = sections.reduce((s, x) => s + x.total, 0);
  if (total === 0) return null;

  const summary = sections.map((s) => `${s.total} ${SECTION_META[s.key].summary}`).join(", ");
  const blocks = sections.map((s) => {
    const queue = SECTION_META[s.key].queue;
    const sectionUrl = link(queue ? `/postevent/kanban?queue=${queue}` : "/postevent/kanban");
    const head = sectionUrl ? `*<${sectionUrl}|${s.title}>* (${s.total})` : `*${s.title}* (${s.total})`;
    const body = s.lines.map((l) => `• ${l}`).join("\n");
    const more = s.more > 0 ? `\n_and ${s.more} more on the board_` : "";
    return `${head}\n${body}${more}`.slice(0, 2900); // Slack caps a section's text at 3000 chars
  });

  const card: BotCard = {
    title: `Customer follow ups for ${formatYmdLong(today)}`,
    subtitle: `${plural(total, "customer needs", "customers need")} us today: ${summary}.`,
    sections: blocks,
    body: "Service comes first. Resolve issues and confirm how the event went before inviting a review.",
    link: { text: "Open the board", url: link("/postevent/kanban") },
    context: "Customer Experience Bot. Sent once each morning, Monday to Saturday.",
  };
  return { total, sections, card };
}

// ── Daily runner (cloud runtime tick, every ~15 min) ───────────────────────────────────────────────────

export const DIGEST_LAST_KEY = "postevent.digest.lastSentYmd";
/** How many hours after the send hour the morning window stays open (a late restart should not post a
 *  "morning" digest in the evening). */
const WINDOW_HOURS = 4;

export function digestEnabled(): boolean {
  return flagOn("POSTEVENT_DAILY_DIGEST");
}

/** Send hour in ET (default 9). Env POSTEVENT_DIGEST_HOUR overrides. */
export function digestHour(): number {
  const n = Number(process.env.POSTEVENT_DIGEST_HOUR);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 9;
}

/** ET calendar parts; the server runs in UTC but the schedule is in ops (ET) time. */
export function etParts(now: Date): { ymd: string; dow: number; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, dow, hour: Number(parts.hour) };
}

export interface DigestDeps {
  cards?: () => PostEventCard[];
  announce?: (card: BotCard) => Promise<SlackResult>;
  link?: (path: string) => string | null;
}

function boardCards(): PostEventCard[] {
  const { columns } = buildBoard();
  return POSTEVENT_STATE_ORDER.filter((s) => s !== "closed").flatMap((s) => columns[s]);
}

/** Post the digest once per ET day inside the morning window. Healthy no-ops report ok. Never throws. */
export async function runPostEventDigestIfDue(now: Date = new Date(), deps: DigestDeps = {}): Promise<{ ok: boolean; detail: string }> {
  if (!digestEnabled()) return { ok: true, detail: "turned off (POSTEVENT_DAILY_DIGEST=false)" };
  const { ymd, dow, hour } = etParts(now);
  if (dow === 0) return { ok: true, detail: "Sunday, no digest" };
  const start = digestHour();
  if (hour < start) return { ok: true, detail: `waiting for ${start}:00 ET` };
  if (getJson<string | null>(DIGEST_LAST_KEY, null) === ymd) return { ok: true, detail: `already sent for ${ymd}` };
  if (hour >= start + WINDOW_HOURS) {
    setJson(DIGEST_LAST_KEY, ymd);
    return { ok: true, detail: `morning window missed for ${ymd}, skipped` };
  }

  const digest = buildDigest((deps.cards ?? boardCards)(), ymd, { link: deps.link ?? appUrl });
  if (!digest) {
    setJson(DIGEST_LAST_KEY, ymd);
    return { ok: true, detail: "nothing due today, no post" };
  }
  const r = await (deps.announce ?? ((c: BotCard) => botAnnounce("reviews", c)))(digest.card);
  if (r.ok) {
    setJson(DIGEST_LAST_KEY, ymd);
    return { ok: true, detail: `sent: ${plural(digest.total, "customer needs", "customers need")} follow up` };
  }
  if (r.skipped) {
    // No Slack configured at all: mark the day so we don't rebuild the board every tick, but show red.
    setJson(DIGEST_LAST_KEY, ymd);
    return { ok: false, detail: "Slack not configured, digest not sent" };
  }
  return { ok: false, detail: `Slack post failed (${r.error ?? "unknown"}), will retry next tick` };
}

