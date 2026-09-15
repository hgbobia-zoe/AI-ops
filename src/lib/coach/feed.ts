// Build a conversation feed for a customer: their calls (from call_events, each with its AI summary +
// next step) merged with their texts (from comms_events), chronological (oldest → newest). Server-only.

import { getCallEventById, getCoachingAnalysis, getCommsForLead, type CoachableCall, type CommsEventView, type BookingView } from "@/lib/db/repo";
import { getCustomerTextThread } from "@/lib/comms/openphone";
import { computeCallMetrics, momentumScore } from "@/lib/coach/metrics";
import { ourPhoneDigits } from "@/lib/comms/identity";
import type { CallItem, CallSignals, TextItem, EmailItem, TimelineItem } from "./feedTypes";

/** All comms for a lead's conversation feed: the stored comms_events PLUS the live OpenPhone SMS thread
 *  (texts sent/received natively in Quo, or before our webhook, that never hit comms_events), deduped by
 *  provider id. Best-effort — a live-pull failure falls back to the stored rows only. */
export async function conversationCommsForLead(leadId: string, clientPhone: string | null | undefined, limit = 60): Promise<CommsEventView[]> {
  const stored = getCommsForLead(leadId, limit);
  const live = clientPhone ? await getCustomerTextThread(clientPhone, { limit: 40 }) : [];
  if (!live.length) return stored;
  const seen = new Set(stored.map((c) => c.providerId).filter(Boolean));
  return [...stored, ...live.filter((l) => l.providerId && !seen.has(l.providerId))];
}

/** Email events we can see from Goodshuffle: sending a quote emails the client. */
export function emailFeedItems(booking: BookingView | null | undefined): EmailItem[] {
  if (!booking) return [];
  const out: EmailItem[] = [];
  if (booking.quoteSentDate) out.push({ kind: "email", id: `qs-${booking.bookingId}`, at: booking.quoteSentDate, subject: "Quote sent to client", via: "Goodshuffle" });
  if (booking.lastSentDate && booking.lastSentDate.slice(0, 10) !== (booking.quoteSentDate ?? "").slice(0, 10)) {
    out.push({ kind: "email", id: `ls-${booking.bookingId}`, at: booking.lastSentDate, subject: "Quote re-sent to client", via: "Goodshuffle" });
  }
  return out;
}

/** Map coachable calls to feed items, pulling each call's Quo summary / recap. */
export function callFeedItems(calls: CoachableCall[]): CallItem[] {
  const ourDigits = ourPhoneDigits();
  return calls.map((c) => {
    const rc = getCoachingAnalysis(c.id);
    const ev = getCallEventById(c.id);
    const summary = rc?.keyPoints?.length ? rc.keyPoints : ev?.summary ? [ev.summary] : [];
    // The teaching layer, only when the recap actually carries some (no empty coaching blocks).
    const coaching =
      rc && ((rc.coachingNotes?.length ?? 0) || (rc.objections?.length ?? 0) || (rc.customerConcerns?.length ?? 0) || (rc.actionItems?.length ?? 0))
        ? { notes: rc.coachingNotes ?? [], objections: rc.objections ?? [], concerns: rc.customerConcerns ?? [], actionItems: rc.actionItems ?? [] }
        : null;
    // Instant signals: computed straight from the transcript, so they're ready before the AI recap is.
    let signals: CallSignals | null = null;
    if (ev?.transcript) {
      const m = computeCallMetrics(ev.transcript, c.durationSec, ourDigits);
      const repShare = m.speakers.find((s) => s.label === "Rep")?.share ?? null;
      const mom = momentumScore({ sentiment: c.sentiment, repShare, questions: m.questions, hasNextStep: !!rc?.nextStep });
      signals = { wordsPerMin: m.wordsPerMin, repSharePct: repShare != null ? Math.round(repShare * 100) : null, questions: m.questions, momentum: { score: mom.score, label: mom.label, tone: mom.tone } };
    }
    return { kind: "call", id: c.id, direction: c.direction, at: c.occurredAt ?? c.ts, durationSec: c.durationSec, sentiment: c.sentiment, summary, nextStep: rc?.nextStep ?? "", analyzed: !!rc, coaching, signals };
  });
}

/** Merge calls + text comms + Goodshuffle email events into one chronological feed. */
export function buildConversationFeed(calls: CoachableCall[], comms: CommsEventView[], emails: EmailItem[] = []): TimelineItem[] {
  const callItems = callFeedItems(calls);
  const textItems: TextItem[] = comms
    .filter((c) => c.channel !== "call")
    .map((c) => ({ kind: "text", id: c.id, direction: c.direction, body: c.body ?? "", actor: c.actor, at: c.occurredAt ?? c.ts }));
  return [...callItems, ...textItems, ...emails].sort((a, b) => (Date.parse(a.at ?? "") || 0) - (Date.parse(b.at ?? "") || 0));
}
