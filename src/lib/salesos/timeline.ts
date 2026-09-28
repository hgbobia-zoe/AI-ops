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
  const sentT = ms(b.quoteSentAt);
  if (b.quoteSentAt && !(sentT != null && emailOutTimes.some((x) => Math.abs(x - sentT) < 60_000))) {
    entries.push({ at: b.quoteSentAt, channel: "quote", direction: "out", actor: null, title: "Quote emailed", source: "bookings" });
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
