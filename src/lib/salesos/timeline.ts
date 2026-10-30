// Unified per-lead activity timeline — the single source of truth for "what has happened on this
// project", merged chronologically from every stored touch: SMS + calls (comms_events), full call
// detail incl. voicemails (call_events, matched by the lead's phone), quote milestones (bookings),
// captured client-email messages (email_events), the sales audit trail (audit_logs), and the dated
// lines in Goodshuffle's internal notes.
//
// FACTS ONLY. Nothing is inferred: a field the source didn't give us is omitted, never guessed. Note
// lines keep their date EXACTLY as the team wrote it ("9/7") — we do NOT invent a year, so those entries
// are UNDATED (at === null) and sort after the dated ones rather than being placed at a fabricated
// instant. Overlapping sources are de-duplicated (a call in both comms_events and call_events; a quote
// email that also appears as an email_event) so the drawer reads clean and "last outbound" isn't skewed.

import {
  getBookingById,
  getCommsForLead,
  getCallEventsByPhoneDigits,
  getEmailEventsForLead,
  getAuditForEntity,
} from "@/lib/db/repo";
import { datedNoteLines } from "./outreach";
import { ACTION_LABEL, type SalesAction } from "./audit";
import type { LastMessageChannel, LastMessageSnapshot } from "@/lib/aiorg/lastMessage";

export type TimelineChannel = "sms" | "call" | "email" | "note" | "quote" | "system";

export interface TimelineEntry {
  at: string | null; // ISO instant; null = a note dated only as written (no reliable year)
  rawDate?: string | null; // note entries: the date token exactly as written in the notes
  channel: TimelineChannel;
  direction: "in" | "out" | null; // customer's perspective: in = they contacted us, out = we reached them
  actor: string | null; // who did it (rep initials/name) when known; null when unknown
  title: string;
  detail?: string | null;
  source: string; // provenance table: comms_events | call_events | bookings | email_events | audit_logs | internal_notes
}

const last10 = (p: string | null | undefined): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
};

const clip = (s: string | null | undefined, n = 200): string | null => {
  const t = (s ?? "").trim();
  return t ? t.slice(0, n) : null;
};

// Audit actions worth showing on the timeline — the ones that add information NOT already captured by
// comms_events / call_events / email_events (so we never double-log a text or call). These are internal
// rep/system actions, so direction is null (they are not outbound customer outreach).
const AUDIT_ON_TIMELINE: SalesAction[] = ["OUTREACH_DRAFTED", "LOSS_REASON_TAGGED", "BID_REVIEWED", "BOARD_MOVE", "STATE_REANALYZED"];

/** Build the merged, newest-first activity timeline for one lead. Dated entries come first (newest →
 *  oldest); undated note lines follow. Returns [] for an unknown booking. */
export function buildLeadTimeline(bookingId: string): TimelineEntry[] {
  const b = getBookingById(bookingId);
  if (!b) return [];
  const entries: TimelineEntry[] = [];

  // 1) comms_events — SMS + calls-as-summary. Remember each provider id + call time so call_events can
  //    be de-duplicated against these.
  const commsProviderIds = new Set<string>();
  const commsCallTimes: number[] = [];
  for (const c of getCommsForLead(bookingId, 60)) {
    if (c.providerId) commsProviderIds.add(c.providerId);
    const at = c.occurredAt ?? c.ts;
    const direction = c.direction === "inbound" ? "in" : "out";
    if (c.channel === "call") {
      const t = ms(at);
      if (t != null) commsCallTimes.push(t);
      entries.push({
        at,
        channel: "call",
        direction,
        actor: c.actor ?? null,
        title: direction === "in" ? "Call from client" : "Call to client",
        detail: clip(c.body),
        source: "comms_events",
      });
    } else {
      entries.push({
        at,
        channel: "sms",
        direction,
        actor: c.actor ?? null,
        title: direction === "in" ? "Text from client" : "Text to client",
        detail: clip(c.body),
        source: "comms_events",
      });
    }
  }

  // 2) call_events — full call detail (incl. voicemails), matched by the lead's phone. call_events has
  //    no lead_id, so the link is the phone number. De-dupe against comms_events by provider id, and by
  //    a same-minute call time (the same call surfacing through both feeds).
  const digits = last10(b.clientPhone);
  if (digits) {
    for (const ce of getCallEventsByPhoneDigits(digits, 60)) {
      if (ce.providerId && commsProviderIds.has(ce.providerId)) continue;
      const at = ce.occurredAt ?? ce.ts;
      const t = ms(at);
      if (t != null && commsCallTimes.some((x) => Math.abs(x - t) < 60_000)) continue;
      const direction = ce.direction === "incoming" ? "in" : ce.direction === "outgoing" ? "out" : null;
      const vm = ce.durationSec != null && ce.durationSec === 0;
      entries.push({
        at,
        channel: "call",
        direction,
        actor: null,
        title:
          direction === "in"
            ? vm
              ? "Voicemail from client"
              : "Call from client"
            : direction === "out"
              ? "Call to client"
              : "Call with client",
        detail: clip(ce.summary) ?? (ce.durationSec != null ? `${ce.durationSec}s` : null),
        source: "call_events",
      });
    }
  }

  // 3) Captured client-email messages (email_events, from the office pull).
  const emailOutTimes: number[] = [];
  for (const em of getEmailEventsForLead(bookingId, 60)) {
    const at = em.occurredAt ?? em.ts;
    const direction = em.direction === "outbound" ? "out" : em.direction === "inbound" ? "in" : null;
    if (direction === "out") {
      const t = ms(at);
      if (t != null) emailOutTimes.push(t);
    }
    const subj = (em.subject ?? "").trim();
    const title =
      direction === "out"
        ? `Email sent${subj ? `: ${subj}` : ""}`
        : direction === "in"
          ? `Email received${subj ? `: ${subj}` : ""}`
          : `Email${subj ? `: ${subj}` : ""}`;
    entries.push({
      at,
      channel: "email",
      direction,
      actor: null,
      title,
      detail: clip(em.snippet) ?? (em.participant ? `with ${em.participant}` : null),
      source: "email_events",
    });
  }

  // 4) Quote milestones from the booking. "Quote emailed" is suppressed when an outbound email_event
  //    lands within a minute of it (the richer email entry already represents that send).
  // Quote send is an OUTBOUND rep touch (a sent quote means we reached the client). Prefer the precise
  // captured send time; fall back to the quote-sent DATE when the precise time wasn't captured — so a
  // quoted lead is never miscounted as "never contacted" just because only the date is on file.
  const sentIso = b.quoteSentAt ?? (b.quoteSentDate ? `${b.quoteSentDate}T00:00:00Z` : null);
  const sentT = ms(sentIso);
  if (sentIso && !(sentT != null && emailOutTimes.some((x) => Math.abs(x - sentT) < 60_000))) {
    entries.push({ at: sentIso, channel: "quote", direction: "out", actor: null, title: "Quote emailed", source: "bookings" });
  }
  if (b.quoteOpenedAt) {
    entries.push({ at: b.quoteOpenedAt, channel: "quote", direction: "in", actor: null, title: "Client opened the quote", source: "bookings" });
  }
  // dateLastSent (YYYY-MM-DD) — only when it isn't the same day as the precise quote-sent time (avoids a
  // duplicate of "Quote emailed").
  if (b.lastSentDate && b.lastSentDate.slice(0, 10) !== (b.quoteSentAt ?? "").slice(0, 10)) {
    entries.push({ at: `${b.lastSentDate}T00:00:00Z`, channel: "quote", direction: "out", actor: null, title: "Quote/contract re-sent", source: "bookings" });
  }

  // 5) Sales audit trail — internal rep/system actions not already represented by the comms/email feeds.
  for (const a of getAuditForEntity("lead", bookingId, 60)) {
    if (!AUDIT_ON_TIMELINE.includes(a.action as SalesAction)) continue;
    entries.push({
      at: a.ts,
      channel: "system",
      direction: null,
      actor: a.actor || null,
      title: ACTION_LABEL[a.action as SalesAction] ?? a.action,
      detail: a.detail ? clip(JSON.stringify(a.detail)) : null,
      source: "audit_logs",
    });
  }

  // 6) Dated lines from Goodshuffle internal notes — kept UNDATED (date token as written, no year guess).
  for (const n of datedNoteLines(b.internalNotes)) {
    entries.push({ at: null, rawDate: n.rawDate, channel: "note", direction: null, actor: null, title: "Logged note", detail: clip(n.text), source: "internal_notes" });
  }

  // Newest first for dated entries; undated note lines after (they can't be placed on the timeline
  // without fabricating a year), preserving their written order.
  const dated = entries.filter((e) => e.at != null).sort((x, y) => (ms(y.at)! - ms(x.at)!));
  const undated = entries.filter((e) => e.at == null);
  return [...dated, ...undated];
}

/** The most recent activity of any kind (newest DATED entry), or null when nothing dated exists. */
export function timelineLastActivity(entries: TimelineEntry[]): TimelineEntry | null {
  return entries.find((e) => e.at != null) ?? null;
}

/** The most recent time a REP reached out — newest OUTBOUND dated entry (text/call/email/quote sent).
 *  Internal system actions and inbound entries don't count. Null when a rep has never reached out. */
export function timelineLastOutbound(entries: TimelineEntry[]): TimelineEntry | null {
  return entries.find((e) => e.at != null && e.direction === "out") ?? null;
}

// Channels that represent an actual message in the conversation thread (client-facing or client-
// originated). Internal "system"/audit entries are excluded; an internal note is only a last-resort
// fallback when no real dated communication exists.
const THREAD_CHANNELS = new Set<TimelineChannel>(["sms", "call", "email", "quote"]);

/** The PREVIOUS / LAST message in the client's thread — the one a drafted reply is responding to — as a
 *  compact, serializable snapshot (direction, who, when, channel, truncated body). Prefers the newest
 *  DATED real communication (text/call/email/quote, either direction); falls back to the most recently
 *  WRITTEN undated internal note so a worked-but-undated lead still shows context. Returns null when the
 *  thread is genuinely empty — the honest "no prior message" state (never fabricated). PURE. */
export function lastThreadMessage(entries: TimelineEntry[]): LastMessageSnapshot | null {
  // buildLeadTimeline orders dated entries newest-first, so the first thread-channel hit is the most recent.
  const dated = entries.find((e) => e.at != null && THREAD_CHANNELS.has(e.channel));
  // Undated note lines keep their written order (oldest-first), so the LAST one is the most recently written.
  const undatedNotes = entries.filter((e) => e.at == null && e.channel === "note");
  const chosen = dated ?? (undatedNotes.length ? undatedNotes[undatedNotes.length - 1] : null);
  if (!chosen) return null;
  return {
    channel: chosen.channel as LastMessageChannel,
    direction: chosen.direction,
    at: chosen.at,
    rawDate: chosen.rawDate ?? null,
    actor: chosen.actor,
    title: chosen.title,
    snippet: chosen.detail ? chosen.detail.slice(0, 240) : null,
  };
}

/** The last thread message for a lead id, built from ONE merged-timeline pass. Null for an unknown lead
 *  or an empty thread. Used by the proposers to snapshot the context onto a new approval request. */
export function lastThreadMessageForLead(bookingId: string): LastMessageSnapshot | null {
  return lastThreadMessage(buildLeadTimeline(bookingId));
}

// ── Cockpit-facing last-touch (the Bulk Review-and-Fire "Last touch" column + its recently-contacted
//    guard). These derive from the FULL merged timeline above — comms_events AND call_events AND
//    email_events AND the Goodshuffle internal-note touch log AND the quote-send milestone — NOT just the
//    comms_events rows. That is the fix: a Quote-Sent lead that was actually worked (quote sent, a rep
//    note) must never read "none logged" just because no inbound comms row exists.

export interface LeadLastTouch {
  what: string; // friendly label, e.g. "Outbound text" / "Inbound email" / "Logged note" / "Outbound quote"
  whenIso: string | null; // ISO instant when the entry is dated; null for an undated internal-note line
  rawDate: string | null; // the note's date token exactly as written (e.g. "9/7") when undated; else null
  channel: TimelineChannel;
  direction: "in" | "out" | null;
}

/** A human label for a timeline entry in the cockpit's "Last touch" column. Keeps the existing
 *  "Outbound/Inbound <channel>" shape the UI expects; note lines read "Logged note". */
function describeTouch(e: TimelineEntry): string {
  if (e.channel === "note") return "Logged note";
  const dir = e.direction === "out" ? "Outbound" : e.direction === "in" ? "Inbound" : "";
  const kind =
    e.channel === "sms" ? "text" : e.channel === "call" ? "call" : e.channel === "email" ? "email" : e.channel === "quote" ? "quote" : e.channel;
  const label = `${dir} ${kind}`.trim();
  return label || e.title;
}

export interface LeadTouchSummary {
  /** The latest REAL touch of any kind: the newest DATED entry, falling back to the most recently
   *  WRITTEN undated note (so a worked-but-undated lead is still "logged"). null ONLY when the timeline
   *  is genuinely empty — then "none logged" is the honest answer. */
  lastTouch: LeadLastTouch | null;
  /** The newest DATED outbound instant (a text/call/email/quote WE sent) — the signal the double-contact
   *  guard keys off. Undated note lines are deliberately excluded: we can't honestly claim a note
   *  happened within N hours without a reliable instant. null when no dated outbound touch exists. */
  lastOutboundAt: string | null;
}

/** The last-touch + recently-contacted signal, derived from an ALREADY-BUILT timeline (so callers that
 *  also need the touchpoint strip build the merged timeline exactly once). */
function summarizeTimeline(tl: TimelineEntry[]): LeadTouchSummary {
  let entry: TimelineEntry | null = timelineLastActivity(tl); // newest DATED entry of any kind
  if (!entry) {
    // No dated activity, but the lead may still carry undated internal-note touches. datedNoteLines is
    // oldest-first, so the LAST undated entry is the most recently written note — an honest "last touch"
    // even though we can't place it on an exact instant.
    const undated = tl.filter((e) => e.at == null);
    entry = undated.length ? undated[undated.length - 1] : null;
  }

  const lastTouch: LeadLastTouch | null = entry
    ? { what: describeTouch(entry), whenIso: entry.at, rawDate: entry.rawDate ?? null, channel: entry.channel, direction: entry.direction }
    : null;

  return { lastTouch, lastOutboundAt: timelineLastOutbound(tl)?.at ?? null };
}

/** Last-touch + recently-contacted signal for the Bulk Review-and-Fire cockpit, built from ONE pass over
 *  buildLeadTimeline (the same merged source the context-aware draft reads). This replaces the old
 *  comms_events-only last-touch, which showed "none logged" for a lead the team had quoted and texted. */
export function leadTouchSummary(bookingId: string): LeadTouchSummary {
  return summarizeTimeline(buildLeadTimeline(bookingId));
}

// ── Touch-point strip for the cockpit's under-row timeline viz ────────────────────────────────────────
// A bounded, serializable slice of the merged timeline, shaped for the client `LeadTouchTimeline`
// component. FACTS ONLY: every entry is a real stored touch; nothing is synthesized. Dated entries carry
// an ISO instant; an undated internal-note line keeps its written date token and `iso` stays null (it is
// never placed on a fabricated instant). The array is ordered oldest → newest so the strip renders
// left-to-right, with undated notes (which cannot be placed chronologically) kept at the left, clearly
// marked undated by the component.

export interface LeadTouchpoint {
  channel: TimelineChannel;
  direction: "in" | "out" | null;
  title: string; // the entry's own descriptive title, e.g. "Quote emailed" / "Text from client"
  iso: string | null; // ISO instant when dated; null for an undated internal-note line
  dateToken: string | null; // the note's date token exactly as written (e.g. "9/7") when undated; else null
  preview: string | null; // the real captured text/subject/note line (for the hover card); never invented
  isQuote: boolean; // the quote-send milestone — the visual anchor of the strip
}

const toTouchpoint = (e: TimelineEntry): LeadTouchpoint => ({
  channel: e.channel,
  direction: e.direction,
  title: e.title,
  iso: e.at,
  dateToken: e.at ? null : e.rawDate ?? null,
  preview: e.detail ?? null,
  isQuote: e.channel === "quote",
});

export interface ShapedTouchpoints {
  touchpoints: LeadTouchpoint[]; // oldest → newest, bounded to `limit`
  earlier: number; // how many real touches exist BEFORE this bounded window (for a "+K earlier" affordance)
}

/** Shape a bounded, chronological touch-point slice from a merged timeline. Keeps the most recent `limit`
 *  DATED touches (the ones we can place), filling any remaining budget with the most recently-written
 *  undated notes. Returns them oldest → newest (undated notes first) plus the count of older touches that
 *  did not fit. An empty timeline yields an empty array — the honest "no activity yet" state. */
export function shapeTouchpoints(tl: TimelineEntry[], limit = 12): ShapedTouchpoints {
  const dated = tl.filter((e) => e.at != null); // newest-first (buildLeadTimeline order)
  const undated = tl.filter((e) => e.at == null); // note log, oldest-first (written order)
  const recentDated = dated.slice(0, limit); // most-recent `limit`, still newest-first
  const budget = Math.max(0, limit - recentDated.length);
  const shownUndated = budget > 0 ? undated.slice(Math.max(0, undated.length - budget)) : [];
  const earlier = dated.length - recentDated.length + (undated.length - shownUndated.length);
  // oldest → newest for left-to-right rendering: undated notes (no instant) first, then dated ascending.
  const touchpoints = [...shownUndated.map(toTouchpoint), ...recentDated.slice().reverse().map(toTouchpoint)];
  return { touchpoints, earlier };
}

export interface LeadTouchContext extends LeadTouchSummary {
  touchpoints: LeadTouchpoint[];
  touchpointsEarlier: number;
}

/** The cockpit's full per-lead touch context — last-touch summary + the bounded touch-point strip — from
 *  ONE buildLeadTimeline pass (so a cohort of ~50 leads builds each timeline once, not twice). */
export function leadTouchContext(bookingId: string, limit = 12): LeadTouchContext {
  const tl = buildLeadTimeline(bookingId);
  const summary = summarizeTimeline(tl);
  const { touchpoints, earlier } = shapeTouchpoints(tl, limit);
  return { ...summary, touchpoints, touchpointsEarlier: earlier };
}
