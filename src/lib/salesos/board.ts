// Sales OS board + table data. Both read the pipeline (open leads + signed wins, minus lost) and key
// off an effective status: a manual override (set by dragging on the board) if present, else a derived
// default from Goodshuffle signals. RULES derive the default; the human can override by moving a card.

import { getPipelineLeads, getLeadStatusMap, getAllCustomerStates, getLatestInboundForLead, getLastCommsAt, type BookingView, type LeadBoardStatus } from "@/lib/db/repo";
import { resolveDeterministic, fromStored } from "./stateService";
import { nextBestAction } from "./nba";
import { todayInOpsTz } from "@/lib/dates";

const FOLLOWUP_SILENCE_DAYS = 4; // quote sent + this many days with no contact → Need Follow-up

// Board columns (archived is intentionally NOT a column — archived cards drop off the board).
export type BoardStatus = "new" | "quote_sent" | "follow_up" | "action_needed" | "signed";
export const BOARD_COLUMNS: { key: BoardStatus; label: string }[] = [
  { key: "new", label: "New" },
  { key: "quote_sent", label: "Quote Sent" },
  { key: "follow_up", label: "Need Follow-up" },
  { key: "action_needed", label: "Action Needed" },
  { key: "signed", label: "Signed" },
];

export const STATUS_LABEL: Record<LeadBoardStatus, string> = {
  new: "New",
  quote_sent: "Quote Sent",
  follow_up: "Need Follow-up",
  action_needed: "Action Needed",
  signed: "Signed",
  archived: "Archived",
};

export interface LeadCard {
  id: string;
  eventName: string;
  clientName: string;
  value: number | null; // grand total (cents-safe dollars from the pull)
  netPaid: number | null;
  amountDue: number | null;
  remainingBalance: number | null;
  eventDate: string | null;
  dateCreated: string | null;
  quoteSentDate: string | null;
  statusLabel: string;
  daysToEvent: number | null;
  status: LeadBoardStatus; // effective board status
}

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

interface AutoSignals {
  state: string; // customer state machine value
  nbaAction: string; // next-best-action
  repliedMinutesAgo: number | null;
  daysSinceContact: number | null;
}

/** Automatic board status from the same signals the worklist uses. A manual drag overrides this.
 *  - signed → Signed; lost/cancelled → archived (off board)
 *  - customer just replied, an urgent next-action, or an objection/ready state → Action Needed
 *  - quote not sent → New
 *  - sent but dormant / silent past the follow-up window → Need Follow-up
 *  - otherwise (sent, waiting) → Quote Sent */
function autoStatus(b: BookingView, sig: AutoSignals): LeadBoardStatus {
  if (b.signed) return "signed";
  if (/lost|cancel|dead/i.test(b.statusLabel)) return "archived";

  const sent = !!b.quoteSentDate || /sent|proposal|quote|contract|review/i.test(b.statusLabel);
  const justReplied = sig.repliedMinutesAgo != null && sig.repliedMinutesAgo <= 1440;
  const urgentNba = sig.nbaAction === "CALL_NOW" || sig.nbaAction === "HANDLE_OBJECTION" || sig.nbaAction === "CLOSE" || sig.nbaAction === "ESCALATE";
  const actionState = sig.state === "PRICE_OBJECTION" || sig.state === "COMPETITOR_COMPARISON" || sig.state === "READY_TO_BOOK";
  if (justReplied || urgentNba || actionState) return "action_needed";

  if (!sent) return "new";
  if (sig.state === "DORMANT") return "follow_up";
  if (sig.daysSinceContact != null && sig.daysSinceContact >= FOLLOWUP_SILENCE_DAYS) return "follow_up";
  return "quote_sent";
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
  };
}

/** All pipeline leads as flat cards with their effective status (manual override else auto). */
export function salesLeadCards(): LeadCard[] {
  const today = todayInOpsTz();
  const overrides = getLeadStatusMap();
  const states = getAllCustomerStates();
  return getPipelineLeads(today).map((b) => {
    const override = overrides.get(b.bookingId);
    let status = override;
    if (!status) {
      const stored = states.get(b.bookingId);
      const state = stored ? fromStored(stored) : resolveDeterministic(b);
      const inbound = getLatestInboundForLead(b.bookingId);
      const repliedMinutesAgo = minutesSince(inbound?.occurredAt ?? inbound?.ts ?? null);
      const dte = b.eventDate ? daysBetween(today, b.eventDate) : null;
      const nba = nextBestAction({ state: state.state, value: b.grandTotal, daysToEvent: dte, repliedMinutesAgo });
      const lastAt = getLastCommsAt(b.bookingId);
      const daysSinceContact = lastAt ? daysBetween(lastAt.slice(0, 10), today) : b.quoteSentDate ? daysBetween(b.quoteSentDate.slice(0, 10), today) : null;
      status = autoStatus(b, { state: state.state, nbaAction: nba.action, repliedMinutesAgo, daysSinceContact });
    }
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
