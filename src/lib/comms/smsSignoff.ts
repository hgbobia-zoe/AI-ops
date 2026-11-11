// The thank-you line on customer sales texts: "Thank you for considering us for your event."
//
// Owner rule (2026-11-11): use it when a text STARTS or RESTARTS a conversation, never on quick replies,
// and never twice to the same number in one day.
//   start      the first text to a new lead, the text that wraps up a call or sends a quote. Gets the line
//              unless it already went to this number today.
//   follow_up  a Sales OS follow-up (drafts, bulk, morning, the lead panel send). Gets the line only when
//              the thread has been quiet: no text either way in the last few hours. A call after the last
//              text counts as quiet too, because then the text wraps up that call.
//   reply      a quick reply in a live back-and-forth. Never gets it.
// Operational texts (delivery updates, crew messages, review requests) never pass through here.
//
// PURE: the caller hands in the number's recent texts and calls (smsSignoffHistory.ts reads them from the
// message log and the OpenPhone synced timeline). When the rule says no, a line already in the text (from a
// draft made earlier) is taken out, so the rule holds at send time. Kill switch: SMS_SIGNOFF=false leaves
// every text exactly as written.

import { flagOn } from "@/lib/flags";
import { DISPLAY_TZ, ymdInTz } from "@/lib/dates";

export const SMS_SIGNOFF = "Thank you for considering us for your event.";

/** Hours of silence after which a follow up counts as restarting the conversation. */
export const SIGNOFF_QUIET_HOURS = 3;

export type SignoffOccasion = "start" | "follow_up" | "reply";

/** One past text or call with this number. `at` is an ISO timestamp. */
export interface TextTouch {
  direction: "inbound" | "outbound";
  channel: "sms" | "call";
  at: string;
  body?: string | null;
}

export interface SignoffContext {
  occasion: SignoffOccasion;
  history: TextTouch[];
  now?: Date;
  quietHours?: number;
  tz?: string;
}

export type SignoffReason = "off" | "reply" | "sent_today" | "start" | "restart" | "call_wrap_up" | "live_conversation";

export interface SignoffDecision {
  add: boolean;
  reason: SignoffReason;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
const SIGNOFF_KEY = norm(SMS_SIGNOFF);
// The line with any spacing, case or end punctuation, so a hand typed copy is recognized too.
const SIGNOFF_RE = new RegExp(`\\s*${SMS_SIGNOFF.replace(/\.$/, "").split(" ").join("[^a-z]+")}[.!…]*`, "gi");

export function hasSmsSignoff(text: string | null | undefined): boolean {
  return norm(text ?? "").includes(SIGNOFF_KEY);
}

/** The text with the thank-you line taken out. */
export function stripSmsSignoff(text: string | null | undefined): string {
  return (text ?? "").replace(SIGNOFF_RE, "").trim();
}

/** The text with the thank-you line on the end (once). Empty stays empty. No rule, no kill switch: use
 *  withSmsSignoff for a text that is going to a customer. */
export function appendSmsSignoff(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (!t || hasSmsSignoff(t)) return t;
  const sep = /[.!?…]$/.test(t) ? " " : ". ";
  return `${t}${sep}${SMS_SIGNOFF}`;
}

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
};

/** Should this text carry the thank-you line? */
export function decideSmsSignoff(ctx: SignoffContext): SignoffDecision {
  if (!flagOn("SMS_SIGNOFF")) return { add: false, reason: "off" };
  if (ctx.occasion === "reply") return { add: false, reason: "reply" };

  const now = ctx.now ?? new Date();
  const nowMs = now.getTime();
  const tz = ctx.tz ?? DISPLAY_TZ;
  const today = ymdInTz(tz, now);
  const touches = (ctx.history ?? [])
    .map((t) => ({ ...t, ms: Math.min(timeOf(t.at), nowMs) }))
    .filter((t) => Number.isFinite(t.ms));

  const sentToday = touches.some(
    (t) => t.channel === "sms" && t.direction === "outbound" && hasSmsSignoff(t.body) && ymdInTz(tz, new Date(t.ms)) === today,
  );
  if (sentToday) return { add: false, reason: "sent_today" };
  if (ctx.occasion === "start") return { add: true, reason: "start" };

  const since = nowMs - (ctx.quietHours ?? SIGNOFF_QUIET_HOURS) * 3_600_000;
  const recent = touches.filter((t) => t.ms > since);
  const lastText = Math.max(-Infinity, ...recent.filter((t) => t.channel === "sms").map((t) => t.ms));
  if (lastText === -Infinity) return { add: true, reason: "restart" };
  const lastCall = Math.max(-Infinity, ...recent.filter((t) => t.channel === "call").map((t) => t.ms));
  if (lastCall > lastText) return { add: true, reason: "call_wrap_up" };
  return { add: false, reason: "live_conversation" };
}

/** The customer text with the thank-you line added or taken out per the rule. Empty stays empty. With the
 *  kill switch off the text is returned as written. */
export function withSmsSignoff(text: string | null | undefined, ctx: SignoffContext): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const d = decideSmsSignoff(ctx);
  if (d.reason === "off") return t;
  return d.add ? appendSmsSignoff(t) : stripSmsSignoff(t);
}
