// Contract-signed card. When a customer signs (our Goodshuffle pull sees a project go from unsigned to
// signed, stamped as bookings.signed_at in saveBookings), the Sales Bot posts one celebration card to the
// signed-deals channel: who closed it, the client, event, venue, contract total, and a weekly tally.
//
// Once per project, ever (claimed via bookings.signed_alerted_at). Test projects (TEST 1/2/3) are skipped.
// A signing older than STALE_HOURS is stamped silently (a backlog after downtime or a kill switch flip is
// not news). If the signed-deals channel can't be reached (the bot was never invited to the private
// channel), the card falls back to the Sales Bot's own channel so it is never lost.
// Kill switch: SIGNED_CARD=false.

import { pendingSignedAlerts, claimSignedAlert, releaseSignedAlert, signedSince, type SignedCandidate } from "@/lib/db/repo";
import { BOTS, appUrl, botAnnounce, cardBlocks, cardToText, type BotCard } from "@/lib/notify/aiBots";
import { slackPostAs, slackBotConfigured, slackConfigured } from "@/lib/notify/slack";
import { flagOn } from "@/lib/flags";
import { DISPLAY_TZ, formatYmdLong, shiftYmd, todayInOpsTz, ymdInTz } from "@/lib/dates";

/** Where the card goes. The team made a private #quote-signed channel; override with SLACK_CHANNEL_SIGNED. */
export function signedChannel(): string {
  return process.env.SLACK_CHANNEL_SIGNED?.trim() || "quote-signed";
}

const STALE_HOURS = 48;

/** TEST 1 / TEST 2 / TEST 3 are the sandbox projects writes are tried on. Never celebrate those. */
export function isTestProject(eventName: string | null): boolean {
  return /^\s*test\b/i.test(eventName ?? "");
}

function money(n: number): string {
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

function firstName(full: string | null): string | null {
  const f = (full ?? "").trim().split(/\s+/)[0];
  return f || null;
}

/** Monday of the Eastern week holding `todayYmd`. */
export function weekStartYmd(todayYmd: string): string {
  const dow = new Date(`${todayYmd}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return shiftYmd(todayYmd, dow === 0 ? -6 : 1 - dow);
}

export interface WeekTally {
  count: number;
  total: number;
}

/** The card for one signing. PURE: everything it shows comes from its inputs. */
export function buildSignedCard(c: SignedCandidate, week: WeekTally, now: Date = new Date()): BotCard {
  const today = todayInOpsTz(now);
  const signedYmd = ymdInTz(DISPLAY_TZ, new Date(c.signedAt));
  const rep = c.salesLead?.trim() || null;
  const repFirst = firstName(rep);

  const when = signedYmd === today ? "signed today" : `signed ${formatYmdLong(signedYmd)}`;
  let subtitle = rep ? `${rep} closed it. ` : "";
  if (c.quoteSentDate) {
    const days = Math.max(0, daysBetween(c.quoteSentDate, signedYmd));
    subtitle += `Quote sent ${formatYmdLong(c.quoteSentDate)}, ${when} (${days === 1 ? "1 day" : `${days} days`}).`;
  } else {
    subtitle += `${when[0].toUpperCase()}${when.slice(1)}.`;
  }

  const fields: { label: string; value: string }[] = [];
  fields.push({ label: "Client", value: c.clientName?.trim() || "Not on file" });
  // bookings.event_date is Goodshuffle's LOGISTICS start (the drop-off, or the day the customer collects an
  // in-store order). The real event start (event_start, captured with the lead notes) leads when we have it;
  // the logistics day follows only when it is a different day.
  const dateLabel = c.delivers === 1 ? "Delivery" : c.delivers === 0 ? "Customer pickup" : "Delivery / pickup";
  const daysOut = (ymd: string) => {
    const out = daysBetween(today, ymd);
    return out > 1 ? ` (${out} days out)` : out === 1 ? " (tomorrow)" : out === 0 ? " (today)" : "";
  };
  const eventStartMs = c.eventStart ? Date.parse(c.eventStart) : NaN;
  if (Number.isFinite(eventStartMs)) {
    const at = new Date(eventStartMs);
    const eventYmd = ymdInTz(DISPLAY_TZ, at);
    const time = at.toLocaleTimeString("en-US", { timeZone: DISPLAY_TZ, hour: "numeric", minute: "2-digit" });
    fields.push({ label: "Event date", value: `${formatYmdLong(eventYmd)}, ${eventYmd.slice(0, 4)}, ${time}${daysOut(eventYmd)}` });
    if (c.eventDate && c.eventDate !== eventYmd) fields.push({ label: dateLabel, value: formatYmdLong(c.eventDate) });
  } else if (c.eventDate) {
    fields.push({ label: dateLabel, value: `${formatYmdLong(c.eventDate)}, ${c.eventDate.slice(0, 4)}${daysOut(c.eventDate)}` });
  } else {
    fields.push({ label: "Event date", value: "Not set yet" });
  }
  const place = c.venue?.trim() || c.location?.trim();
  if (place) fields.push({ label: "Venue", value: place });
  // Only the contract total: deposit and balance lines take the excitement out of a win (owner, 2026-11-11).
  if (c.grandTotal != null) fields.push({ label: "Contract total", value: money(c.grandTotal) });

  const tally =
    week.count <= 1
      ? "That's the first one signed this week."
      : `That makes ${week.count} signed this week for ${money(week.total)}.`;
  const body = `${repFirst ? `Nice work, ${repFirst}. ` : ""}${tally}`;

  return {
    emoji: "🎉",
    title: `Contract signed: ${c.eventName?.trim() || c.clientName?.trim() || `Project ${c.bookingId}`}`,
    subtitle,
    fields,
    body,
    link: { text: "Open in Goodshuffle", url: `https://pro.goodshuffle.com/app/project/detail?id=${encodeURIComponent(c.bookingId)}` },
    links: [{ text: "Open in Zoe", url: appUrl(`/salesos/${encodeURIComponent(c.bookingId)}`) }],
    context: "Sales Bot · seen on the Goodshuffle sync",
  };
}

/** This week's signings (Monday start, Eastern), test projects left out. */
function weekTally(now: Date): WeekTally {
  const start = weekStartYmd(todayInOpsTz(now));
  // Pull a little extra, then keep the ones whose Eastern date falls in this week.
  const rows = signedSince(new Date(now.getTime() - 8 * 86_400_000).toISOString()).filter(
    (r) => !isTestProject(r.eventName) && ymdInTz(DISPLAY_TZ, new Date(r.signedAt)) >= start,
  );
  return { count: rows.length, total: rows.reduce((s, r) => s + (r.grandTotal ?? 0), 0) };
}

/** Post a card for every newly signed project. Never throws; returns how many cards went out. */
export async function runSignedAlerts(now: Date = new Date()): Promise<number> {
  if (!flagOn("SIGNED_CARD")) return 0;
  const pending = pendingSignedAlerts();
  if (pending.length === 0) return 0;
  const canPost = slackBotConfigured() || slackConfigured();
  const stamp = now.toISOString();
  let sent = 0;
  for (const c of pending) {
    const stale = now.getTime() - Date.parse(c.signedAt) > STALE_HOURS * 3_600_000;
    if (!claimSignedAlert(c.bookingId, stamp)) continue; // another pull already has it
    if (stale || isTestProject(c.eventName) || !canPost) continue; // stamped, never announced
    try {
      const card = buildSignedCard(c, weekTally(now), now);
      let res = await slackPostAs(signedChannel(), BOTS.sales, cardToText(card), { blocks: cardBlocks(card) });
      if (!res.ok) {
        console.warn(`[signedAlert] #${signedChannel()} post failed (${res.error ?? "skipped"}), falling back to the Sales Bot channel`);
        res = await botAnnounce("sales", card);
      }
      if (res.ok) sent += 1;
      else releaseSignedAlert(c.bookingId);
    } catch (e) {
      console.error("[signedAlert] failed", e);
      releaseSignedAlert(c.bookingId);
    }
  }
  return sent;
}
