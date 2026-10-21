// E-signature cutoff — disable ONLINE signing N business days before the event (default 3), so a contract
// signs IN PERSON on delivery instead of a last-minute online click. A daily-ish runtime sweep finds each
// UNSIGNED, non-archived project whose event day has crossed into the business-day window and queues one
// Goodshuffle write to turn online signing off (per project, idempotent), then announces it in the
// `sales-ai` channel as the Sales bot.
//
// GOVERNING LAW:
//   • RULES CALCULATE — the window is pure business-day math (src/lib/dates.ts); Viktor only announces.
//   • HONEST WHEN UNOBSERVABLE — Goodshuffle does not expose the online-signing toggle to our pull, AND we
//     have NOT captured the write endpoint that disables it (see extension/pull-injected.js CAPTURE-NEEDED).
//     So: (a) "online signature enabled" is proxied by signed = 0 (an unsigned project still needs signing;
//     a signed one is already done); (b) the queued op does NOT fabricate a request — it sits pending until
//     the endpoint is captured. The announcement therefore says the window was ENTERED and signing is being
//     turned off (PENDING), and only says "disabled" once the op is CONFIRMED (gates-reflect-reality).
//   • REVERSIBLE — the team can re-enable online signing or sign in person in Goodshuffle at any time; the
//     copy says so, and the once-per-project guard never fights that human choice.
//
// OFF BY DEFAULT: the whole sweep is gated by ESIGN_CUTOFF_ENABLED (default OFF). Enqueuing a write that
// can't execute yet, and posting to sales-ai, both wait for the team to flip it on (presumably once the GS
// endpoint is captured and the sales-ai channel is set). When off, the job is a healthy no-op.

import { businessDaysUntil, isWithinBusinessDays, shiftYmd, todayInOpsTz, formatYmdLong } from "@/lib/dates";
import {
  enqueueGsOp,
  disableEsignOpExists,
  esignCutoffCandidates,
  listDisableEsignOps,
  type BookingView,
} from "@/lib/db/repo";
import { getJson, setJson } from "@/lib/kv";
import { notify } from "@/lib/notify/channels";
import { appUrl, type BotCard } from "@/lib/notify/aiBots";

/** Master switch. Default OFF — the write endpoint is an uncaptured stub and the sales-ai channel id is
 *  provided later, so nothing enqueues or posts until the team enables it. */
export function esignCutoffEnabled(): boolean {
  return process.env.ESIGN_CUTOFF_ENABLED === "true";
}

/** Business-day lead time before the event. Default 3 (the user's spec); tunable without a redeploy. */
export function cutoffBusinessDays(): number {
  const n = Number(process.env.ESIGN_CUTOFF_BUSINESS_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/** kv key: the set of disable_esignature op ids whose CONFIRMED follow-up we've already posted (announce
 *  the "disabled" line once, never on every tick after the op lands). */
const CONFIRMED_ANNOUNCED_KEY = "esign.cutoff.confirmedAnnounced";

function projectUrl(bookingId: string): string {
  return `https://pro.goodshuffle.com/app/project/detail?id=${bookingId}`;
}

function projectLabel(b: BookingView): string {
  return b.eventName?.trim() || b.clientName?.trim() || `#${b.bookingId}`;
}

function eventDateLong(b: BookingView): string {
  return b.eventDate ? formatYmdLong(b.eventDate) : "date TBD";
}

/**
 * HONEST announcement copy. PENDING (the write is queued but the endpoint is an uncaptured stub / the op
 * hasn't confirmed): say the project ENTERED the window and online signing is being turned off, that it's
 * reversible, and that in-person signing still works — never claim it's already off. CONFIRMED: say online
 * signing has been disabled. No em-dashes, no emoji (house rule).
 */
export function pendingCutoffCard(b: BookingView, bizDays: number, n: number): BotCard {
  const label = projectLabel(b);
  return {
    title: `Online signing cutoff: ${label}`,
    fields: [
      { label: "Event", value: eventDateLong(b) },
      { label: "Window", value: `${bizDays} business day${bizDays === 1 ? "" : "s"} out (cutoff ${n})` },
      { label: "Status", value: "Turning online signing off (pending)" },
    ],
    body:
      `${label} entered the ${n}-business-day window before its event, so online signing is being turned off. ` +
      `This is queued, not confirmed yet. It is reversible: the team can re-enable online signing or sign in person in Goodshuffle at any time.`,
    link: { text: "Open in app", url: appUrl("/salesos") },
    context: `Sales Bot · reversible · set SALES_AI_SLACK_CHANNEL to route this channel`,
  };
}

export function confirmedCutoffCard(label: string, bookingId: string): BotCard {
  return {
    title: `Online signing disabled: ${label}`,
    body:
      `Goodshuffle confirmed online signing is now off for ${label}. ` +
      `Sign in person in Goodshuffle. This is reversible if the team needs online signing back on.`,
    link: { text: "Open the project", url: projectUrl(bookingId) },
    context: "Sales Bot",
  };
}

export interface EsignCutoffResult {
  ok: boolean;
  detail: string;
  queued: number; //    projects newly queued this run
  confirmed: number; // confirmed follow-ups posted this run
  scanned: number; //   candidates examined
}

/**
 * One sweep: (1) queue + announce (pending) each project that newly crossed the cutoff; (2) post the
 * confirmed follow-up for any disable op Goodshuffle has since accepted. Idempotent and outage-safe:
 * dedupe by the once-per-project op guard and the confirmed-announced kv set, so a daily (or more frequent)
 * tick never double-queues or double-posts. Never throws.
 */
export async function runEsignCutoffSweep(now: Date = new Date()): Promise<EsignCutoffResult> {
  if (!esignCutoffEnabled()) {
    return { ok: true, detail: "ESIGN_CUTOFF_ENABLED off — inert", queued: 0, confirmed: 0, scanned: 0 };
  }

  const n = cutoffBusinessDays();
  const today = todayInOpsTz(now);
  // A calendar horizon that safely covers n business days across a weekend (n weekdays can span up to
  // n + 2 calendar days; pad a little). The pure business-day rule does the exact gate within this window.
  const horizon = shiftYmd(today, n + 4);

  let queued = 0;
  let scanned = 0;
  try {
    const candidates = esignCutoffCandidates(today, horizon);
    for (const b of candidates) {
      if (!b.eventDate) continue;
      scanned++;
      if (!isWithinBusinessDays(b.eventDate, n, now)) continue; // not yet (or no longer) in the window
      if (disableEsignOpExists(b.bookingId)) continue; // once per project, ever
      const bizDays = businessDaysUntil(b.eventDate, now);
      enqueueGsOp({
        op: "disable_esignature",
        transactionId: b.bookingId,
        label: `disable online signing → ${projectLabel(b)}`,
        payload: { transactionId: b.bookingId },
      });
      queued++;
      await notify("sales", pendingCutoffCard(b, bizDays, n));
    }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "sweep error", queued, confirmed: 0, scanned };
  }

  // Confirmed follow-ups: any disable op Goodshuffle has accepted that we haven't announced-confirmed yet.
  let confirmed = 0;
  try {
    const announced = new Set(getJson<string[]>(CONFIRMED_ANNOUNCED_KEY, []));
    const done = listDisableEsignOps("done");
    for (const op of done) {
      if (announced.has(op.id)) continue;
      const label = op.label?.replace(/^disable online signing → /, "") || `#${op.transactionId ?? ""}`;
      await notify("sales", confirmedCutoffCard(label, op.transactionId ?? ""));
      announced.add(op.id);
      confirmed++;
    }
    if (confirmed > 0) setJson(CONFIRMED_ANNOUNCED_KEY, [...announced]);
  } catch {
    // A follow-up post failing must never fail the whole sweep; the unannounced op re-qualifies next tick.
  }

  const detail =
    queued === 0 && confirmed === 0
      ? `${scanned} in window, none newly queued`
      : `${queued} queued${confirmed ? `, ${confirmed} confirmed` : ""} (${scanned} scanned)`;
  return { ok: true, detail, queued, confirmed, scanned };
}
