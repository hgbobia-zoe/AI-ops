// Quote-opened alert. When a client opens their quote email (Goodshuffle tracks this via the message
// thread's messageOpenedDate, captured by the pull into bookings.quote_opened_at), that's the moment to
// reach out — objections and questions are top of mind. This is a SALES notification, so (Part C) it now
// routes to the `sales-ai` channel via the central domain map (notify("sales", ...)), posted AS the Sales
// bot — NOT the customer-alerts channel (that stays for frustrated-caller alerts only). Still fires only
// once per open and only when the open landed at least an hour after we sent the quote (so we don't ping
// while they're glancing at the just-sent confirmation). Deterministic; runs after the notes ingest.

import { pendingQuoteOpenAlerts, markQuoteOpenAlerted, type QuoteOpenCandidate } from "@/lib/db/repo";
import { slackBotConfigured, slackConfigured } from "@/lib/notify/slack";
import { notify } from "@/lib/notify/channels";
import { postStatus } from "@/lib/notify/status";
import { businessHoursGate } from "@/lib/settings";
import { getJson, setJson } from "@/lib/kv";

// We only ping on a FRESH open: the value is catching the client while the quote is on their mind. The pull
// sees an open on its next fast-lane notes pass, but a background Chrome tab can run that pass late, and the
// old 30 minute window then dropped real opens without a trace (no alert has been seen since 2026-10-21).
// 2 hours keeps a slow capture useful; the post says how long ago they opened it. Older opens (a backlog on
// first capture) are seeded, never alerted, and every decision is kept in the trace (quoteOpenTrace).
// Tunable without a redeploy via QUOTE_OPEN_ALERT_WINDOW_MIN.
const DEFAULT_WINDOW_MIN = 120;
function recentWindowMs(): number {
  const m = Number(process.env.QUOTE_OPEN_ALERT_WINDOW_MIN);
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_WINDOW_MIN) * 60_000;
}

function humanGap(fromISO: string, toISO: string): string {
  const ms = Date.parse(toISO) - Date.parse(fromISO);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const h = Math.round(ms / 3600000);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

/** "just opened their quote" when it is fresh, else "opened their quote 25 min ago". PURE. */
function openedPhrase(openedAt: string, now: number): string {
  const min = Math.max(0, Math.round((now - Date.parse(openedAt)) / 60_000));
  if (min <= 2) return "just opened their quote";
  return `opened their quote ${min < 60 ? `${min} min` : `${Math.round(min / 60)}h`} ago`;
}

/** Why an open would not alert, in the order the alert checks, or null when it qualifies. PURE. */
export function quoteOpenWhyNot(r: { quote_sent_at: string | null; quote_sent_date: string | null; last_sent_date: string | null; quote_opened_at: string; quote_open_alerted_at: string | null }): string | null {
  if (!r.quote_sent_date && !r.last_sent_date) return "no Goodshuffle sent date on the project (honesty gate)";
  if (r.quote_open_alerted_at && r.quote_opened_at <= r.quote_open_alerted_at) return "already handled";
  const anchor = r.quote_sent_at ?? (r.quote_sent_date ? `${r.quote_sent_date}T00:00:00Z` : `${r.last_sent_date}T00:00:00Z`);
  if (Date.parse(r.quote_opened_at) - Date.parse(anchor) < 3_600_000) return "opened less than an hour after it was sent";
  return null;
}

export function line(c: QuoteOpenCandidate, now: number = Date.now()): string {
  const who = c.clientName?.trim() || "A client";
  const gap = humanGap(c.quoteSentAt, c.quoteOpenedAt);
  const ctx = [c.eventName?.trim(), c.eventDate?.trim(), c.location?.trim()].filter(Boolean).join(" · ");
  const url = `https://pro.goodshuffle.com/app/project/detail?id=${c.bookingId}`;
  return `👀 ${who} ${openedPhrase(c.quoteOpenedAt, now)}${gap ? ` (${gap} after we sent it)` : ""}. Good time to reach out.${ctx ? `\n${ctx}` : ""}\n${url}`;
}

// ── Trace (why each open did or did not post) ────────────────────────────────────────────────────────

export type QuoteOpenDecision = "posted" | "post_failed" | "stale" | "no_slack";
export interface QuoteOpenTraceEntry {
  at: string; // when we decided (ISO)
  bookingId: string;
  openedAt: string;
  ageMin: number; // how old the open was when we saw it
  decision: QuoteOpenDecision;
  detail?: string | null; // the Slack error when a post failed
}
const TRACE_KEY = "salesos.quoteOpen.trace";
const TRACE_MAX = 200;
const FAIL_ALERT_KEY = "salesos.quoteOpen.lastFailAlertAt";

/** The most recent decisions, newest first (owner GET /api/salesos/quote-open-alerts). */
export function quoteOpenTrace(): QuoteOpenTraceEntry[] {
  return getJson<QuoteOpenTraceEntry[]>(TRACE_KEY, []);
}
function trace(e: QuoteOpenTraceEntry): void {
  try {
    setJson(TRACE_KEY, [e, ...quoteOpenTrace()].slice(0, TRACE_MAX));
  } catch {
    /* the trace is best effort */
  }
}

/** A post that failed is loud in ai-ops-status (once per 2 hours), never a silent loss. */
async function reportPostFailure(error: string, now: number): Promise<void> {
  const last = getJson<number>(FAIL_ALERT_KEY, 0);
  if (now - last < 2 * 3_600_000) return;
  setJson(FAIL_ALERT_KEY, now);
  await postStatus({ system: "Quote opened alerts", level: "degraded", title: "A quote opened alert could not post to Slack", impact: "Sales does not hear that a client just opened their quote.", fix: "Check the Sales Bot is in the sales channel (SLACK_CHANNEL_SALES) and the Slack token works.", detail: error }, now).catch(() => {});
}

/** Fire a one-time Slack alert for each newly-opened quote (>1h after send), and record it so we never
 *  re-alert the same open. Best-effort; returns how many alerts were actually sent. `now` is injectable for
 *  tests and drives both the recency window and the business-hours gate. */
export async function runQuoteOpenAlerts(now: number = Date.now()): Promise<number> {
  // Business-hours gate: "they just opened their quote, reach out now" is a recommendation, so the owner's
  // rule holds it outside business hours. Hold BEFORE touching the candidates so nothing is marked/dropped
  // — a still-fresh open re-qualifies on the next in-hours notes ingest (a stale one is seeded then as
  // usual). A quote-open alert held until morning would be cold anyway, so this never sends a stale ping.
  if (!businessHoursGate(new Date(now)).open) return 0;

  const candidates = pendingQuoteOpenAlerts();
  if (candidates.length === 0) return 0;
  // Sales transport = the Sales bot into sales-ai, with an ops-webhook fallback (notify("sales")). It can
  // deliver when EITHER the bot token or the ops webhook is set; with neither it degrades to a clean skip.
  const configured = slackBotConfigured() || slackConfigured();
  const windowMs = recentWindowMs();
  let sent = 0;
  for (const c of candidates) {
    const ageMs = now - Date.parse(c.quoteOpenedAt);
    const base = { at: new Date(now).toISOString(), bookingId: c.bookingId, openedAt: c.quoteOpenedAt, ageMin: Math.round(ageMs / 60_000) };
    if (ageMs > windowMs) trace({ ...base, decision: "stale" });
    else if (!configured) trace({ ...base, decision: "no_slack" });
    else {
      const res = await notify("sales", line(c, now));
      if (res.ok) {
        sent += 1;
        trace({ ...base, decision: "posted" });
      } else {
        const err = "error" in res && res.error ? String(res.error) : "skipped";
        trace({ ...base, decision: "post_failed", detail: err });
        await reportPostFailure(err, now);
      }
      // Mark either way: a failed post shouldn't wedge on this open forever; a real new open will re-qualify.
    }
    // Seed/dedupe so this exact open never alerts again (also seeds stale backlog opens).
    markQuoteOpenAlerted(c.bookingId, c.quoteOpenedAt);
  }
  return sent;
}
