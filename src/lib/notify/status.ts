// System status alerts → the AI Ops status channel. ONE place for every "is the system available" signal:
// a connection that broke, an API key that got rate limited or rejected, Ignition / Goodshuffle / Instawork /
// Gusto signed out, the Auto-Pull fleet going quiet, a background job that keeps failing, the website down.
//
// Every alert is the same small, readable card instead of a data dump:
//
//   ┃ Ignition is signed out                         (bold title, colored bar: red down, amber degraded, green back)
//   ┃ Impact: Customers get the basic tracking page instead of the live truck map.
//   ┃ What to do: Sign in at ignition.zonarsystems.com on the office computer.
//   ┃ Ignition | Down since 2:14 PM (40 min) | Detail: HTTP 401
//
// Channel: SLACK_CHANNEL_STATUS (a name or id), default "ai-ops-status", posted by the Slack bot as
// "System Status". If the bot can't post there it falls back to SLACK_STATUS_WEBHOOK_URL, then the ops webhook,
// so an outage alert is never silently dropped. Never throws.
//
// House style: no dashes used as punctuation, no emoji in the text, short sentences. Technical detail is
// redacted (keys, tokens, bearer headers) and truncated before it leaves the server.

import { getJson, setJson } from "@/lib/kv";
import { DISPLAY_TZ } from "@/lib/dates";
import { slackBotConfigured, slackPostAs, slackWebhookRich, type BotPersona, type SlackResult } from "./slack";

export type StatusLevel = "down" | "degraded" | "recovered";

export interface StatusAlert {
  /** The system, short and human: "Ignition", "Goodshuffle Auto-Pull", "Connecteam". */
  system: string;
  level: StatusLevel;
  /** One plain sentence saying what happened: "Ignition is signed out". */
  title: string;
  /** What stops working for the team or customers while this lasts. */
  impact?: string | null;
  /** The one thing a person should do to fix it. */
  fix?: string | null;
  /** When the problem started (ISO). Shown as "Down since 2:14 PM (40 min)", or "Back after 40 min". */
  since?: string | null;
  /** When it clears on its own (ISO), e.g. a rate limit reset. */
  until?: string | null;
  /** The raw technical reason (HTTP status, error text). Redacted and cut short. */
  detail?: string | null;
  /** Optional button, e.g. "Open settings". Dropped when the url is empty. */
  link?: { text: string; url: string | null } | null;
}

export const STATUS_PERSONA: BotPersona = { name: "System Status", icon: ":satellite_antenna:" };
export const DEFAULT_STATUS_CHANNEL = "ai-ops-status";

const COLORS: Record<StatusLevel, string> = { down: "#D93F3F", degraded: "#E8A33D", recovered: "#2EB67D" };

export function statusChannel(): string {
  return process.env.SLACK_CHANNEL_STATUS?.trim() || DEFAULT_STATUS_CHANNEL;
}

// ── Text helpers ─────────────────────────────────────────────────────────────────────────────────────────

/** House style: turn dashes used as punctuation into commas. Word hyphens (sign-in, re-paste) stay. */
export function noDashes(s: string): string {
  return s
    .replace(/\s+[—–]\s+|\s+-\s+/g, ", ")
    .replace(/[—–]/g, ", ")
    .replace(/,\s*,/g, ",")
    .trim();
}

/** Strip anything that looks like a credential from technical detail before it reaches Slack. */
export function redactSecrets(s: string): string {
  return s
    .replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|x-intake-token|token|secret|password|passwd|authorization|cookie)["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi, "$1[redacted]")
    .replace(/([?&](?:key|sig|signature|auth)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(sk|pk|rk|xox[abprs])[-_][A-Za-z0-9-_]{10,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}

const DETAIL_MAX = 240;

export function cleanDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const one = redactSecrets(String(detail)).replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > DETAIL_MAX ? `${one.slice(0, DETAIL_MAX - 3)}...` : one;
}

/** "40 min", "2 h 5 min", "3 days". Null when it can't be computed. */
export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** A wall-clock time in the ops timezone: "2:14 PM", or "Nov 8, 2:14 PM" when it's not today. */
export function formatClock(iso: string, now: number = Date.now()): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const day = (x: Date) => x.toLocaleDateString("en-US", { timeZone: DISPLAY_TZ });
  // Newer ICU puts a narrow no-break space before AM/PM; normalize to a plain space.
  const time = d.toLocaleTimeString("en-US", { timeZone: DISPLAY_TZ, hour: "numeric", minute: "2-digit" }).replace(/[  ]/g, " ");
  if (day(d) === day(new Date(now))) return time;
  const date = d.toLocaleDateString("en-US", { timeZone: DISPLAY_TZ, month: "short", day: "numeric" });
  return `${date}, ${time}`;
}

/** The small grey context line: "Ignition | Down since 2:14 PM (40 min) | Clears 8:00 PM | Detail: HTTP 429". */
export function statusContext(a: StatusAlert, now: number = Date.now()): string {
  const parts: string[] = [a.system];
  const sinceMs = a.since ? Date.parse(a.since) : NaN;
  if (a.level === "recovered") {
    const dur = Number.isFinite(sinceMs) ? formatDuration(now - sinceMs) : null;
    parts.push(dur ? `Back after ${dur}` : "Back up");
  } else if (Number.isFinite(sinceMs)) {
    const clock = formatClock(a.since!, now);
    const dur = formatDuration(now - sinceMs);
    parts.push(`${a.level === "down" ? "Down" : "Degraded"} since ${clock}${dur ? ` (${dur})` : ""}`);
  } else {
    parts.push(a.level === "down" ? "Down" : "Degraded");
  }
  if (a.until && a.level !== "recovered") {
    const clock = formatClock(a.until, now);
    if (clock) parts.push(`Clears ${clock}`);
  }
  const detail = cleanDetail(a.detail);
  if (detail) parts.push(`Detail: ${detail}`);
  return parts.join(" | ");
}

/** Plain text version: the push notification line and the fallback for clients that don't render cards. */
export function statusText(a: StatusAlert, now: number = Date.now()): string {
  const lines = [noDashes(a.title)];
  if (a.impact) lines.push(`Impact: ${noDashes(a.impact)}`);
  if (a.fix) lines.push(`What to do: ${noDashes(a.fix)}`);
  lines.push(statusContext(a, now));
  if (a.link?.url) lines.push(`${a.link.text}: ${a.link.url}`);
  return lines.join("\n");
}

/** The colored attachment (Block Kit inside, so it renders cleanly on desktop and mobile). */
export function statusAttachment(a: StatusAlert, now: number = Date.now()): Record<string, unknown> {
  const body = [`*${noDashes(a.title)}*`];
  if (a.impact) body.push(`*Impact:* ${noDashes(a.impact)}`);
  if (a.fix) body.push(`*What to do:* ${noDashes(a.fix)}`);
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: body.join("\n").slice(0, 2900) } },
    { type: "context", elements: [{ type: "mrkdwn", text: statusContext(a, now).slice(0, 2900) }] },
  ];
  if (a.link?.url) {
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: a.link.text }, url: a.link.url }] });
  }
  return { color: COLORS[a.level], fallback: noDashes(a.title), blocks };
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────────────────────

/** Post one status alert to the status channel. Bot first, then the status webhook, then the ops webhook. */
export async function postStatus(a: StatusAlert, now: number = Date.now()): Promise<SlackResult> {
  try {
    const text = statusText(a, now);
    const attachments = [statusAttachment(a, now)];
    // The notification line is just the title; the card carries the rest.
    const notice = noDashes(a.title);
    let r: SlackResult = { ok: false, skipped: true };
    if (slackBotConfigured()) {
      r = await slackPostAs(statusChannel(), STATUS_PERSONA, notice, { attachments });
      if (r.ok) return r;
    }
    const statusHook = process.env.SLACK_STATUS_WEBHOOK_URL?.trim();
    if (statusHook) {
      r = await slackWebhookRich(statusHook, notice, { attachments });
      if (r.ok) return r;
    }
    r = await slackWebhookRich(process.env.SLACK_WEBHOOK_URL, notice, { attachments });
    if (!r.ok) console.error(`[status] ${text.replace(/\n/g, " | ")} (slack ${r.skipped ? "not configured" : r.error})`);
    return r;
  } catch (e) {
    console.error("[status] failed to send status alert:", e);
    return { ok: false, error: String(e) };
  }
}

// ── Failure classification (for raw integration errors) ──────────────────────────────────────────────────

export type FailureKind = "rate_limit" | "auth" | "unreachable" | "error";

/** Read a raw error and say what kind of outage it is, so the title is human ("rate limited") not a dump. */
export function classifyFailure(detail: string | null | undefined): FailureKind {
  const d = String(detail ?? "");
  if (/\b429\b|rate.?limit|too many requests|over_query_limit|quota|resource_exhausted/i.test(d)) return "rate_limit";
  if (/\b40[13]\b|request_denied|unauthori[sz]ed|forbidden|invalid.{0,12}(api.?)?key|api key|signed out|not logged in|expired/i.test(d)) return "auth";
  if (/fetch failed|enotfound|econnrefused|econnreset|etimedout|timed? ?out|abort|network|unreachable|socket|\b50[0-4]\b/i.test(d)) return "unreachable";
  return "error";
}

const KIND_TITLE: Record<FailureKind, string> = {
  rate_limit: "is rate limited",
  auth: "rejected our login or API key",
  unreachable: "is not responding",
  error: "calls are failing",
};

const KIND_FIX: Record<FailureKind, string> = {
  rate_limit: "Nothing to do if it clears on its own. If it keeps happening, check the plan limits for this key.",
  auth: "Check the API key or sign-in for this service in Admin settings.",
  unreachable: "Usually clears on its own. Check the provider's status page if it lasts.",
  error: "Check the detail below. If it keeps happening, look at the server logs.",
};

/** Build a status alert from a raw integration failure: "<System> is rate limited", with a sensible fix. */
export function failureAlert(system: string, detail: string | null | undefined, opts: { impact?: string | null; fix?: string | null; since?: string | null; until?: string | null } = {}): StatusAlert {
  const kind = classifyFailure(detail);
  return {
    system,
    level: kind === "rate_limit" ? "degraded" : "down",
    title: `${system} ${KIND_TITLE[kind]}`,
    impact: opts.impact ?? null,
    fix: opts.fix ?? KIND_FIX[kind],
    since: opts.since ?? null,
    until: opts.until ?? null,
    detail: detail ?? null,
  };
}

// ── Durable down / recovered tracking ────────────────────────────────────────────────────────────────────

export interface StatusTrackRecord {
  failingSince?: string;
  alertedAt?: string;
}

export const STATUS_COOLOFF_MS = 2 * 3_600_000;

/** Pure decision: page once when something has been down for `sustainMs`, at most once per `cooloffMs`
 *  while it stays down, and once when it recovers (only if we paged). */
export function decideStatus(
  rec: StatusTrackRecord,
  down: boolean,
  now: number,
  opts: { sustainMs?: number; cooloffMs?: number } = {},
): { post: "down" | "recovered" | null; next: StatusTrackRecord; failingSince: string | null } {
  const sustain = opts.sustainMs ?? 0;
  const cooloff = opts.cooloffMs ?? STATUS_COOLOFF_MS;
  if (!down) {
    return { post: rec.alertedAt ? "recovered" : null, next: {}, failingSince: rec.failingSince ?? null };
  }
  const failingSince = rec.failingSince ?? new Date(now).toISOString();
  const downFor = now - Date.parse(failingSince);
  const alertedAgo = rec.alertedAt ? now - Date.parse(rec.alertedAt) : Infinity;
  if (downFor >= sustain && alertedAgo > cooloff) {
    return { post: "down", next: { failingSince, alertedAt: new Date(now).toISOString() }, failingSince };
  }
  return { post: null, next: { ...rec, failingSince }, failingSince };
}

/** Track a named health signal across runs (kv-backed) and post the down / recovered card when it flips.
 *  `build` gets the failing-since time so the card can say how long it has been down. Never throws. */
export async function trackStatus(
  key: string,
  down: boolean,
  build: (state: "down" | "recovered", failingSince: string | null) => StatusAlert,
  opts: { sustainMs?: number; cooloffMs?: number; now?: number } = {},
): Promise<"down" | "recovered" | null> {
  try {
    const now = opts.now ?? Date.now();
    const kvKey = `status_track:${key}`;
    const rec = getJson<StatusTrackRecord>(kvKey, {});
    const { post, next, failingSince } = decideStatus(rec, down, now, opts);
    setJson(kvKey, next);
    if (post) await postStatus(build(post, failingSince), now);
    return post;
  } catch (e) {
    console.error(`[status] track ${key} failed:`, e);
    return null;
  }
}
