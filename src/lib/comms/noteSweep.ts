// Note sweep: every human call and text with an open lead gets a line in the Goodshuffle project notes,
// so the team (and the Sales Bot) read the full context in one place.
//
// The real time paths only covered part of it: texts sent FROM Sales OS write a note (smsSend.ts), and
// calls write one off Quo's webhook events (comms/service.ts). Texts sent in the Quo app never did, and
// call notes were missing when a webhook event never arrived. This sweep runs with the OpenPhone text sync
// (every 15 min): for each open lead it reads the last NOTE_SWEEP_HOURS of texts and calls straight from
// Quo and queues any note that is not there yet. Same dedupe keys as the real time paths (sms:<message id>,
// call:<call id>), so a touch is noted once whichever path sees it first. Texts the app itself sent
// (logged in `messages` with their Quo id) are left to their own path. Attribution: the Quo user's
// initials (JM), else the honest "Zoe team". Gated by the same GS_NOTE_SYNC_ENABLED switch.

import { getDb } from "@/lib/db";
import { gsNoteOpExists, type CommsEventView } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import { syncTouchpointNote, noteSyncEnabled, type CallOutcome } from "./noteSync";
import { getCallSummary, listOpenphoneCalls, openphoneUserInitials, type QuoCall, type QuoNumber } from "./openphone";

/** Look back this far. Older touches are history, not something to start noting now. */
export const NOTE_SWEEP_HOURS = 48;
/** Give a finished call this long for Quo to write its summary before noting it. */
export const CALL_SETTLE_MS = 10 * 60_000;

export interface SweepLead {
  bookingId: string;
  clientName: string | null;
  clientPhone: string | null;
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Inside the look back window and (for calls) settled long enough. Pure. */
export function inSweepWindow(iso: string | null | undefined, now: number, settleMs = 0): boolean {
  const t = ms(iso);
  return Number.isFinite(t) && t <= now - settleMs && now - t <= NOTE_SWEEP_HOURS * 3_600_000;
}

/** The note outcome for a call, the same rules as the webhook path (callNote.ts). Pure. */
export function callOutcome(c: Pick<QuoCall, "direction" | "durationSec">, summary: string | null): CallOutcome {
  if ((summary ?? "").trim()) return "conversation";
  if ((c.durationSec ?? 0) > 0) return "conversation";
  return c.direction === "incoming" ? "voicemail_received" : "voicemail_left";
}

/** Was this Quo message sent by the app itself (Sales OS, dispatch)? Those write their own note. */
export function sentByApp(providerId: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM messages WHERE provider_msg_id = ? LIMIT 1").get(providerId));
}

const ymd = (iso: string): string => todayInOpsTz(new Date(iso));

/** Queue notes for the rep's recent outbound texts in this lead's thread (as read from Quo). */
export function noteRecentTexts(lead: SweepLead, thread: CommsEventView[], now: number = Date.now()): number {
  if (!noteSyncEnabled()) return 0;
  let queued = 0;
  for (const m of thread) {
    if (m.direction !== "outbound" || !m.body || !m.providerId || !m.occurredAt) continue;
    if (!inSweepWindow(m.occurredAt, now) || sentByApp(m.providerId)) continue;
    const res = syncTouchpointNote({
      kind: "text",
      messageId: m.providerId,
      transactionId: lead.bookingId,
      repInitials: m.actor && m.actor !== "Zoe" ? m.actor : null,
      clientName: lead.clientName,
      snippet: m.body,
      dateYmd: ymd(m.occurredAt),
    });
    if (res.enqueued) queued++;
  }
  return queued;
}

/** Queue notes for this lead's recent finished calls, read live from Quo. */
export async function noteRecentCalls(lead: SweepLead, numbers: QuoNumber[], now: number = Date.now()): Promise<number> {
  if (!noteSyncEnabled()) return 0;
  const d10 = (lead.clientPhone ?? "").replace(/\D/g, "").slice(-10);
  if (d10.length !== 10) return 0;
  let queued = 0;
  for (const n of numbers) {
    const { calls } = await listOpenphoneCalls(n.id, `+1${d10}`).catch(() => ({ calls: [] as QuoCall[] }));
    for (const c of calls) {
      if (!inSweepWindow(c.occurredAt, now, CALL_SETTLE_MS)) continue;
      if (c.status && /progress|ringing|queued|initiated/i.test(c.status)) continue;
      if (gsNoteOpExists(`call:${c.id}`)) continue; // already noted (webhook or an earlier sweep): skip the API reads
      const summary = (await getCallSummary(c.id).catch(() => null)) ?? null;
      const res = syncTouchpointNote({
        kind: "call",
        callId: c.id,
        transactionId: lead.bookingId,
        repInitials: await openphoneUserInitials(c.userId),
        clientName: lead.clientName,
        direction: c.direction === "incoming" ? "incoming" : c.direction === "outgoing" ? "outgoing" : null,
        outcome: callOutcome(c, summary),
        summary,
        dateYmd: ymd(c.occurredAt!),
      });
      if (res.enqueued) queued++;
    }
  }
  return queued;
}
