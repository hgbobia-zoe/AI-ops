// Sales OS board + table data. Both read the pipeline (open leads + signed wins, minus lost) and key
// off an effective status: a manual override (set by dragging on the board) if present, else a derived
// default from Goodshuffle signals. RULES derive the default; the human can override by moving a card.

import { getPipelineLeads, getLeadStatusMap, getAllCustomerStates, getLatestInboundForLead, getLastCommsAt, type BookingView, type LeadBoardStatus, type CustomerStateRow } from "@/lib/db/repo";
import { resolveDeterministic, fromStored } from "./stateService";
import { nextBestAction } from "./nba";
import { todayInOpsTz } from "@/lib/dates";
import { BOARD_COLUMNS, autoStatus, daysSinceContactDays, type BoardStatus, type LeadCard } from "./boardTypes";

export { BOARD_COLUMNS, STATUS_LABEL, autoStatus } from "./boardTypes";
export type { BoardStatus, LeadStatus, LeadCard } from "./boardTypes";

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

const minutesSince = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso.length > 10 ? iso : `${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : null;
};

/** The effective board status for a lead: a manual override if present, else the derived auto status
 *  from the same signals the worklist uses. ONE source of truth, so the board, table and the worklist's
 *  state filter all agree on what state a lead is in. */
export function deriveBoardStatus(b: BookingView, today: string, opts?: { override?: LeadBoardStatus; stored?: CustomerStateRow }): LeadBoardStatus {
  if (opts?.override) return opts.override;
  const state = opts?.stored ? fromStored(opts.stored) : resolveDeterministic(b);
  const inbound = getLatestInboundForLead(b.bookingId);
  const repliedMinutesAgo = minutesSince(inbound?.occurredAt ?? inbound?.ts ?? null);
  const dte = b.eventDate ? daysBetween(today, b.eventDate) : null;
  const nba = nextBestAction({ state: state.state, value: b.grandTotal, daysToEvent: dte, repliedMinutesAgo });
  const daysSinceContact = daysSinceContactDays(getLastCommsAt(b.bookingId), b.quoteSentDate, today);
  return autoStatus(b, { state: state.state, nbaAction: nba.action, repliedMinutesAgo, daysSinceContact });
}

function toCard(b: BookingView, today: string, status: LeadBoardStatus): LeadCard {
  const remainingBalance = b.grandTotal != null && b.amountPaid != null ? Math.max(0, b.grandTotal - b.amountPaid) : b.amountDue ?? null;
  return {
    id: b.bookingId,
    eventName: b.eventName,
    clientName: b.clientName,
    value: b.grandTotal,
    netPaid: b.amountPaid,
    amountDue: b.amountDue,
    remainingBalance,
    eventDate: b.eventDate,
    dateCreated: b.dateCreated,
    quoteSentDate: b.quoteSentDate,
    statusLabel: b.statusLabel,
    daysToEvent: b.eventDate ? daysBetween(today, b.eventDate) : null,
    status,
    venue: b.venue,
    location: b.location,
  };
}

/** All pipeline leads as flat cards with their effective status (manual override else auto). */
export function salesLeadCards(): LeadCard[] {
  const today = todayInOpsTz();
  const overrides = getLeadStatusMap();
  const states = getAllCustomerStates();
  return getPipelineLeads(today).map((b) => {
    const status = deriveBoardStatus(b, today, { override: overrides.get(b.bookingId), stored: states.get(b.bookingId) });
    return toCard(b, today, status);
  });
}

export interface BoardData {
  columns: { key: BoardStatus; label: string }[];
  cards: Record<BoardStatus, LeadCard[]>;
  counts: Record<BoardStatus, number>;
}

/** Cards grouped by board column (archived dropped), soonest event first — for the Kanban view. */
export function salesBoard(): BoardData {
  const cards: Record<BoardStatus, LeadCard[]> = { new: [], quote_sent: [], follow_up: [], action_needed: [], signed: [] };
  for (const c of salesLeadCards()) {
    if (c.status === "archived") continue;
    cards[c.status as BoardStatus].push(c);
  }
  for (const k of Object.keys(cards) as BoardStatus[]) {
    cards[k].sort((a, b) => (a.daysToEvent ?? 99999) - (b.daysToEvent ?? 99999) || (b.value ?? 0) - (a.value ?? 0));
  }
  const counts = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, cards[c.key].length])) as Record<BoardStatus, number>;
  return { columns: BOARD_COLUMNS, cards, counts };
}
