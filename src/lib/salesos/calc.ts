// AI Sales OS (Phase 1) — the deterministic core. RULES CALCULATE, AI INTERPRETS: everything here is
// pure, explainable arithmetic over facts we actually hold in the bookings table (quote age, days to
// event, value, contact reachability). No LLM, no fabrication.
//
// HONESTY BOUNDARY: we have NO inbound comms store yet (no replies, no call logs). So "the client went
// quiet" is an INFERENCE from elapsed time, never an observed fact — deriveSalesState assumes no reply
// has arrived. The service/UI must surface that caveat. When we can't compute a signal (no quote-sent
// date, no contact info), we return null / "unknown", never a guess.

/** Lifecycle stage of an OPEN (unsigned) lead — derived purely from dates. */
export type SalesStage = "unsent" | "awaiting" | "follow_up" | "cold" | "closing";

export const STAGE_LABEL: Record<SalesStage, string> = {
  unsent: "Not sent",
  awaiting: "Awaiting reply",
  follow_up: "Follow up",
  cold: "Going cold",
  closing: "Closing window",
};

/** Normalized facts about one lead, all derived upstream from a booking row. */
export interface LeadSignals {
  daysToEvent: number | null; // event_date − today; null when undated; negative if event already passed
  quoteAgeDays: number | null; // days since the quote was sent (or created, if never sent); null if unknown
  everSent: boolean; // did the client receive the quote — from Goodshuffle status (authority) or quote_sent_date
  hasPhone: boolean;
  hasEmail: boolean;
  value: number | null; // potential $ (grand_total) — POTENTIAL, not committed revenue
}

/** Did the client actually receive this quote? Goodshuffle's OWN status is the authority — it knows
 *  "Quote Sent" vs "New Project"/"Draft" even when we don't yet hold a quote_sent_date. Returns
 *  true (sent), false (still a draft/lead), or null (status unknown → let dates decide).
 *
 *  Real Zoe statuses seen in production: "Quote Sent", "New Project", "Contract Signed" (won),
 *  "Unsigned Changes", "Lost". We match on substrings so new label variants still resolve. */
export function sentFromStatus(statusLabel?: string | null): boolean | null {
  const s = (statusLabel ?? "").toLowerCase().trim();
  if (!s) return null;
  // Working/not-yet-sent states first (so "New Project" never trips a "sent" match).
  if (/\b(new project|new|draft|lead|template|working|building)\b/.test(s)) return false;
  // States that mean the client has the quote / it's out.
  if (/(quote sent|sent|proposal|quote|reserved|pending|deposit|invoice|unsigned|await)/.test(s)) return true;
  return null;
}

export interface SalesThresholds {
  awaitingGraceDays: number; // sent within this many days → still reasonably "awaiting a reply"
  coldAfterDays: number; // sent longer ago than this with no signature → going cold
  closingWindowDays: number; // event within this many days & still unsigned → closing window (most urgent)
}

export const DEFAULT_THRESHOLDS: SalesThresholds = {
  awaitingGraceDays: 3,
  coldAfterDays: 21,
  closingWindowDays: 14,
};

/** Derive the lifecycle stage of an open lead. Deterministic and total (defined for every input).
 *  Precedence: an imminent event beats everything, then send-state, then quote age. */
export function deriveSalesState(s: LeadSignals, t: SalesThresholds = DEFAULT_THRESHOLDS): SalesStage {
  // Event is upon us and it's still unsigned — the single most urgent situation, regardless of age.
  if (s.daysToEvent != null && s.daysToEvent >= 0 && s.daysToEvent <= t.closingWindowDays) return "closing";
  // Never sent to the client — the quote is just sitting in a draft.
  if (!s.everSent) return "unsent";
  // Sent, but we can't date it — treat conservatively as needing a follow-up.
  if (s.quoteAgeDays == null) return "follow_up";
  if (s.quoteAgeDays >= t.coldAfterDays) return "cold";
  if (s.quoteAgeDays > t.awaitingGraceDays) return "follow_up";
  return "awaiting";
}

export type ActionChannel = "call" | "text" | "email" | "unknown";
export type ActionUrgency = "now" | "today" | "soon" | "monitor";

export interface NextAction {
  action: string; // imperative — what to do
  reason: string; // why now (fact-based)
  channel: ActionChannel; // best reachable channel given contact info on file
  urgency: ActionUrgency;
}

/** Pick the best channel from what we actually have on file, honoring the action's preference.
 *  For phone-first actions (call/text): phone → prefer, else email, else none.
 *  For email-first actions (sending a quote): email → email, else phone-as-text, else none. */
function bestChannel(s: LeadSignals, prefer: "call" | "text" | "email"): ActionChannel {
  if (prefer === "email") {
    if (s.hasEmail) return "email";
    if (s.hasPhone) return "text";
    return "unknown";
  }
  if (s.hasPhone) return prefer;
  if (s.hasEmail) return "email";
  return "unknown";
}

function channelWord(c: ActionChannel): string {
  return c === "call" ? "call" : c === "text" ? "text" : c === "email" ? "email" : "reach out (no phone/email on file)";
}

/** The single recommended next action for a lead. Deterministic; numbers are baked in from signals. */
export function nextBestAction(stage: SalesStage, s: LeadSignals): NextAction {
  const age = s.quoteAgeDays;
  const dte = s.daysToEvent;
  switch (stage) {
    case "closing": {
      const ch = bestChannel(s, "call");
      const when = dte === 0 ? "today" : dte === 1 ? "tomorrow" : `in ${dte} days`;
      return {
        action: `Lock it in — ${channelWord(ch)} now`,
        reason: `Event is ${when} and the contract still isn't signed.`,
        channel: ch,
        urgency: "now",
      };
    }
    case "unsent":
      return {
        action: "Send the quote",
        reason: "This quote was never sent to the client — nothing can happen until it goes out.",
        channel: bestChannel(s, "email"),
        urgency: "now",
      };
    case "follow_up": {
      const ch = bestChannel(s, "text");
      return {
        action: `Follow up — ${channelWord(ch)}`,
        reason: age == null ? "Sent, but no reply on record — worth a nudge." : `Sent ${age} days ago with no signature yet — time for a nudge.`,
        channel: ch,
        urgency: "today",
      };
    }
    case "cold": {
      const ch = bestChannel(s, "call");
      return {
        action: `Last attempt — ${channelWord(ch)}, or close out`,
        reason: `Sent ${age ?? "?"} days ago and gone quiet — make a final push or mark it lost.`,
        channel: ch,
        urgency: "soon",
      };
    }
    case "awaiting":
    default:
      return {
        action: "Give it a beat — monitor",
        reason: age == null ? "Just sent — inside the grace window." : `Sent ${age} day${age === 1 ? "" : "s"} ago — still inside the grace window.`,
        channel: "unknown",
        urgency: "monitor",
      };
  }
}

export interface ScoreFactor {
  label: string;
  points: number;
}

export interface PriorityScore {
  score: number; // higher = act sooner
  factors: ScoreFactor[]; // the explainable breakdown ("why this is #1")
}

const STAGE_BASE: Record<SalesStage, number> = {
  closing: 50,
  unsent: 40,
  follow_up: 30,
  cold: 15,
  awaiting: 5,
};

/** How many points event-proximity is worth (undated / past events earn nothing). */
function proximityPoints(daysToEvent: number | null): number {
  if (daysToEvent == null || daysToEvent < 0) return 0;
  if (daysToEvent <= 7) return 30;
  if (daysToEvent <= 14) return 22;
  if (daysToEvent <= 30) return 12;
  if (daysToEvent <= 60) return 5;
  return 0;
}

/** Value weight — larger potential $ nudges a lead up. Unknown value earns nothing (no guessing). */
function valuePoints(value: number | null): number {
  if (value == null || value <= 0) return 0;
  if (value >= 10000) return 20;
  if (value >= 5000) return 14;
  if (value >= 2000) return 8;
  return 3;
}

/** Deterministic priority score with a named-factor breakdown, so the UI can justify the ranking. */
export function priorityScore(stage: SalesStage, s: LeadSignals): PriorityScore {
  const factors: ScoreFactor[] = [];
  const base = STAGE_BASE[stage];
  factors.push({ label: `${STAGE_LABEL[stage]}`, points: base });

  const prox = proximityPoints(s.daysToEvent);
  if (prox > 0) factors.push({ label: s.daysToEvent != null && s.daysToEvent <= 7 ? "Event this week" : "Event approaching", points: prox });

  const val = valuePoints(s.value);
  if (val > 0) factors.push({ label: "Deal size", points: val });

  // Aging bonus for leads that have been sitting — the older an unanswered quote, the sooner to act.
  if ((stage === "follow_up" || stage === "cold") && s.quoteAgeDays != null) {
    const agePts = Math.min(15, Math.floor(s.quoteAgeDays / 3));
    if (agePts > 0) factors.push({ label: `Sitting ${s.quoteAgeDays} days`, points: agePts });
  }

  const score = factors.reduce((n, f) => n + f.points, 0);
  return { score, factors };
}
