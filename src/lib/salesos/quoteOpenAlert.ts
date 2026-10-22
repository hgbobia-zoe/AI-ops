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
import { businessHoursGate } from "@/lib/settings";

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
    const recent = now - Date.parse(c.quoteOpenedAt) <= windowMs;
    if (recent && configured) {
      const res = await notify("sales", line(c));
      if (res.ok) sent += 1;
      // Mark either way: a failed post shouldn't wedge on this open forever; a real new open will re-qualify.
    }
    // Seed/dedupe so this exact open never alerts again (also silently seeds stale backlog opens).
    markQuoteOpenAlerted(c.bookingId, c.quoteOpenedAt);
  }
  return sent;
}
