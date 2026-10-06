// Quote-opened alert. When a client opens their quote email (Goodshuffle tracks this via the message
// thread's messageOpenedDate, captured by the pull into bookings.quote_opened_at), that's the moment to
// reach out — objections and questions are top of mind. We Slack the customer-alerts channel, but only
// once per open and only when the open landed at least an hour after we sent the quote (so we don't ping
// while they're glancing at the just-sent confirmation). Deterministic; runs after the notes ingest.

import { pendingQuoteOpenAlerts, markQuoteOpenAlerted, type QuoteOpenCandidate } from "@/lib/db/repo";
import { slackNotifyAlert, slackAlertConfigured } from "@/lib/notify/slack";

// We only ping on a FRESH open — the whole value is catching the client while they still have the quote
// open and us on their mind, not hours later when the moment is cold. The office pull captures opens on a
// ~10-minute cadence, so a genuine "they're looking right now" open is seen within a cycle or two; anything
// older than this window (a backlog on first capture, or a pull catching up after the machine was asleep)
// is silently seeded, never alerted. Tunable without a redeploy via QUOTE_OPEN_ALERT_WINDOW_MIN.
const DEFAULT_WINDOW_MIN = 30;
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

function line(c: QuoteOpenCandidate): string {
  const who = c.clientName?.trim() || "A client";
  const gap = humanGap(c.quoteSentAt, c.quoteOpenedAt);
  const ctx = [c.eventName?.trim(), c.eventDate?.trim(), c.location?.trim()].filter(Boolean).join(" · ");
  const url = `https://pro.goodshuffle.com/app/project/detail?id=${c.bookingId}`;
  return `👀 ${who} just opened their quote${gap ? ` (${gap} after we sent it)` : ""} — good time to reach out.${ctx ? `\n${ctx}` : ""}\n${url}`;
}

/** Fire a one-time Slack alert for each newly-opened quote (>1h after send), and record it so we never
 *  re-alert the same open. Best-effort; returns how many alerts were actually sent. */
export async function runQuoteOpenAlerts(): Promise<number> {
  const candidates = pendingQuoteOpenAlerts();
  if (candidates.length === 0) return 0;
  const configured = slackAlertConfigured();
  const now = Date.now();
  const windowMs = recentWindowMs();
  let sent = 0;
  for (const c of candidates) {
    const recent = now - Date.parse(c.quoteOpenedAt) <= windowMs;
    if (recent && configured) {
      const res = await slackNotifyAlert(line(c));
      if (res.ok) sent += 1;
      // Mark either way: a failed post shouldn't wedge on this open forever; a real new open will re-qualify.
    }
    // Seed/dedupe so this exact open never alerts again (also silently seeds stale backlog opens).
    markQuoteOpenAlerted(c.bookingId, c.quoteOpenedAt);
  }
  return sent;
}
