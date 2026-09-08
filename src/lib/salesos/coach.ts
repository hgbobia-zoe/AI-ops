// Coach bridge (Phase 10) — the contract between Zoe Sales OS and Custodian, the live call-coaching
// desktop app. Two directions, both grounded in real Zoe data:
//   • coachBrief(lead): the 15-second briefing (state + next-best-action + call brief + prior contact)
//     handed to the coach BEFORE/DURING a call so its coaching is Zoe-specific, not generic.
//   • applyCoachDebrief(input): the coach's post-call recap flows back through the SAME debrief path a
//     Quo call takes — onto the lead's timeline, into the state machine, and (queued) to Goodshuffle
//     notes. This lets a call coached in Custodian close the loop even when it wasn't a Quo call.
// Auth is a shared COACH_API_TOKEN (bearer), never a user session — Custodian is a machine client.

import { randomUUID } from "node:crypto";
import {
  getBookingById,
  getBookingByPhoneDigits,
  insertCommsEventIfNew,
  enqueueGsOp,
  type BookingView,
} from "@/lib/db/repo";
import { getLead } from "./service";
import { resolveDeterministic, fromStored, debriefCall } from "./stateService";
import { getCustomerState } from "@/lib/db/repo";
import { nextBestAction } from "./nba";
import { callBriefFor } from "./callBrief";
import { STATE_LABEL } from "./state";
import { logSalesEventBy } from "./audit";
import { salesOsNoteLine, initialsOf } from "./noteFormat";
import { decideCallNote } from "./callNote";
import { todayInOpsTz } from "@/lib/dates";

/** Is this request carrying the shared coach token? Fail-closed: with no token configured, the bridge
 *  is OFF (401) — unlike the ingest endpoints, this one is never fail-open, since it exposes lead data. */
export function coachAuthOk(req: Request): boolean {
  const want = (process.env.COACH_API_TOKEN ?? "").trim();
  if (!want) return false;
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const header = (req.headers.get("x-coach-token") ?? "").trim();
  return bearer === want || header === want;
}

export function coachBridgeConfigured(): boolean {
  return !!(process.env.COACH_API_TOKEN ?? "").trim();
}

const last10 = (phone?: string | null): string | null => {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

export interface CoachBrief {
  leadId: string;
  eventName: string;
  clientName: string;
  clientFirstName: string;
  eventDate: string | null;
  daysToEvent: number | null;
  statusLabel: string;
  state: string; // machine value (e.g. PRICE_OBJECTION)
  stateLabel: string; // human ("Pushing back on price")
  stateConfidence: number;
  stateSource: string; // derived | inbound_reply | ...
  nextBestAction: string | null; // objective — what to accomplish on the call
  doNot: string | null; // the anti-pattern to avoid (premium methodology)
  opening: string;
  primaryQuestion: string;
  watchFor: string[];
  blocker: string | null;
  priorContact: string | null; // the Goodshuffle contact log (truncated) — real history, not invented
}

/** Assemble a lead's coach brief — the same state + NBA + call-brief the Sales OS lead page shows,
 *  packed for the coach. Returns null when the lead isn't found. Never fabricates: prior contact is the
 *  actual Goodshuffle log, and the state carries its real confidence + source. */
export function coachBrief(leadId: string): CoachBrief | null {
  const lead = getLead(leadId);
  const booking = getBookingById(leadId);
  if (!lead || !booking) return null;

  const stored = getCustomerState(leadId);
  const cstate = stored ? fromStored(stored) : resolveDeterministic(booking);
  const nba = nextBestAction({ state: cstate.state, value: lead.value, daysToEvent: lead.signals.daysToEvent, repliedMinutesAgo: null });
  const brief = callBriefFor(cstate.state, lead.clientName);
  const first = (lead.clientName || "").trim().split(/\s+/)[0] || "there";

  return {
    leadId,
    eventName: lead.eventName,
    clientName: lead.clientName,
    clientFirstName: first,
    eventDate: lead.eventDate,
    daysToEvent: lead.signals.daysToEvent,
    statusLabel: lead.statusLabel,
    state: cstate.state,
    stateLabel: STATE_LABEL[cstate.state],
    stateConfidence: cstate.confidence,
    stateSource: cstate.source,
    nextBestAction: nba?.objective ?? null,
    doNot: nba?.doNot ?? null,
    opening: brief.opening,
    primaryQuestion: brief.primaryQuestion,
    watchFor: brief.watchFor,
    blocker: brief.blocker,
    priorContact: (lead.internalNotes ?? "").trim().slice(0, 4000) || null,
  };
}

/** Resolve a lead by explicit id first, then by the customer phone number (last 10 digits). */
export function coachResolveLead(leadId?: string | null, phone?: string | null): BookingView | null {
  if (leadId) {
    const b = getBookingById(leadId);
    if (b) return b;
  }
  const d = last10(phone);
  return d ? getBookingByPhoneDigits(d) : null;
}

export interface CoachDebriefInput {
  leadId?: string | null;
  phone?: string | null; // customer number, if leadId unknown
  sessionId?: string | null; // Custodian session id — idempotency key for the timeline row
  transcript?: string | null;
  summary?: string | null; // Custodian's executive summary
  durationSec?: number | null;
  agentInitials?: string | null; // rep initials (Custodian knows the signed-in rep)
  agentName?: string | null;
}

export interface CoachDebriefResult {
  ok: boolean;
  leadId: string | null;
  matched: boolean;
  onTimeline: boolean;
  stateUpdated: boolean;
  noteQueued: boolean;
  reason?: string;
}

/** Apply a coach's post-call recap: timeline + state machine + queued Goodshuffle note. Mirrors the Quo
 *  call path (ingestCallEvent) but sourced from Custodian. Deterministic gating — a call with no real
 *  conversation text won't move the state machine (stays "Insufficient Data"). */
export async function applyCoachDebrief(input: CoachDebriefInput): Promise<CoachDebriefResult> {
  const booking = coachResolveLead(input.leadId, input.phone);
  if (!booking) return { ok: true, leadId: null, matched: false, onTimeline: false, stateUpdated: false, noteQueued: false, reason: "no matching lead" };
  const leadId = booking.bookingId;

  const transcript = (input.transcript ?? "").trim() || null;
  const summary = (input.summary ?? "").trim() || null;
  const text = transcript ?? summary;
  const initials = (input.agentInitials ?? "").trim() || initialsOf(input.agentName ?? null);

  // Timeline row (deduped on the Custodian session id, so a re-post is a no-op).
  const providerId = `coach:${(input.sessionId ?? "").trim() || randomUUID()}`;
  const onTimeline = text
    ? !!insertCommsEventIfNew({
        providerId,
        leadId,
        direction: "outbound", // the rep placed/handled the coached call
        channel: "call",
        fromPhone: null,
        toPhone: booking.clientPhone || null,
        body: (summary ?? text).slice(0, 500),
        actor: initials,
        occurredAt: new Date().toISOString(),
      })
    : false;

  // State machine — only a genuine conversation moves it (a summary means Custodian saw a real call).
  const isConversation = !!summary || (transcript != null && (input.durationSec ?? 0) >= 45);
  let stateUpdated = false;
  if (onTimeline && isConversation && text) {
    logSalesEventBy("CALL_DEBRIEF", leadId, initials ?? "Coach", { source: transcript ? "transcript" : "summary", via: "custodian" });
    try {
      await debriefCall(leadId, text);
      stateUpdated = true;
    } catch {
      /* best-effort */
    }
  }

  // Goodshuffle note — the same conversation/voicemail rule the Quo path uses, queued for the office pull.
  let noteQueued = false;
  if (onTimeline) {
    const comment = decideCallNote({ eventType: "call.completed", direction: "outgoing", durationSec: input.durationSec ?? null, summary });
    if (comment) {
      enqueueGsOp({ op: "note_append", transactionId: leadId, label: "call debriefed (coach)", payload: { line: salesOsNoteLine(initials, comment, todayInOpsTz()) } });
      noteQueued = true;
    }
  }

  return { ok: true, leadId, matched: true, onTimeline, stateUpdated, noteQueued };
}
