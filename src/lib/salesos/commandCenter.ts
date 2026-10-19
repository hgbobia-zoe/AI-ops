// Sales Command Center (Phase 7) — the operator's action queue. For every open lead it resolves the
// customer state (stored AI-refined state if we have one, else instant deterministic FACT state) and
// the next best action, then ranks them so the highest-value, most time-sensitive work is on top:
// a big deal that JUST replied outranks a small one sitting untouched — but the ranking is transparent.

import { getOpenLeads, getAllCustomerStates, getLatestInboundForLead, getLastCommsAt, getLeadStatusMap, type BookingView } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";
import { resolveDeterministic, fromStored } from "./stateService";
import { nextBestAction, type NbaResult } from "./nba";
import { STATE_LABEL, type ResolvedState } from "./state";
import { autoStatus, daysSinceContactDays, type LeadStatus } from "./boardTypes";

export interface QueueItem {
  id: string;
  clientName: string;
  eventName: string;
  value: number | null;
  eventDate: string | null;
  daysToEvent: number | null;
  state: ResolvedState;
  stateLabel: string;
  /** Effective board status (override else derived) — the signal the shared state filter keys off, so
   *  the worklist filters by the SAME classification as the board/table. Open-leads only here, so
   *  "signed" appears only when a lead was manually moved there. */
  boardStatus: LeadStatus;
  nba: NbaResult;
  repliedMinutesAgo: number | null;
  lastReplyPreview: string | null;
  venue: string | null; // address signals (searchable in the Sales OS views)
  location: string | null;
}

export interface CommandCenterView {
  today: string;
  items: QueueItem[];
  needAttention: number; // items with a real action (not WAIT/NO_ACTION)
  justReplied: number; // customers who replied in the last 24h
  totalPotential: number | null;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
function minutesSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
}

/** Build the ranked action queue across all open leads. */
export function salesCommandCenter(): CommandCenterView {
  const today = todayInOpsTz();
  const states = getAllCustomerStates();
  const overrides = getLeadStatusMap();
  const open = getOpenLeads(today);

  const items: QueueItem[] = open.map((b: BookingView) => {
    const stored = states.get(b.bookingId);
    const state = stored ? fromStored(stored) : resolveDeterministic(b);
    const inbound = getLatestInboundForLead(b.bookingId);
    const repliedMinutesAgo = minutesSince(inbound?.occurredAt ?? inbound?.ts ?? null);
    const daysToEvent = b.eventDate ? daysBetween(today, b.eventDate) : null;
    const nba = nextBestAction({ state: state.state, value: b.grandTotal, daysToEvent, repliedMinutesAgo });
    // Effective board status: a manual board override wins, else derive from the same signals the board
    // uses (one classifier in boardTypes), so the shared state filter means the same thing everywhere.
    const override = overrides.get(b.bookingId);
    const daysSinceContact = daysSinceContactDays(getLastCommsAt(b.bookingId), b.quoteSentDate, today);
    const boardStatus: LeadStatus = override ?? autoStatus(b, { state: state.state, nbaAction: nba.action, repliedMinutesAgo, daysSinceContact });
    return {
      id: b.bookingId,
      clientName: b.clientName,
      eventName: b.eventName,
      value: b.grandTotal,
      eventDate: b.eventDate,
      daysToEvent,
      state,
      stateLabel: STATE_LABEL[state.state],
      boardStatus,
      nba,
      repliedMinutesAgo,
      lastReplyPreview: inbound?.body?.slice(0, 120) ?? null,
      venue: b.venue,
      location: b.location,
    };
  });

  items.sort((a, b) => b.nba.priority - a.nba.priority || (a.daysToEvent ?? 9999) - (b.daysToEvent ?? 9999));

  let totalPotential: number | null = null;
  let needAttention = 0;
  let justReplied = 0;
  for (const it of items) {
    if (it.value != null) totalPotential = (totalPotential ?? 0) + it.value;
    if (it.nba.action !== "WAIT" && it.nba.action !== "NO_ACTION") needAttention++;
    if (it.repliedMinutesAgo != null && it.repliedMinutesAgo <= 1440) justReplied++;
  }

  return { today, items, needAttention, justReplied, totalPotential };
}
