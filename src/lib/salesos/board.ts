// Sales OS board + table data. Both read the pipeline (open leads + signed wins, minus lost) and key
// off an effective status: a manual override (set by dragging on the board) if present, else a derived
// default from Goodshuffle signals. RULES derive the default; the human can override by moving a card.

import { getPipelineLeads, getLeadStatusMap, type BookingView, type LeadBoardStatus } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";

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

/** Derived default board status from Goodshuffle signals (used until a human moves the card). */
export function defaultStatus(b: BookingView): LeadBoardStatus {
  if (b.signed) return "signed";
  if (/lost|cancel|dead/i.test(b.statusLabel)) return "archived";
  const sent = !!b.quoteSentDate || /sent|proposal|quote|contract|review/i.test(b.statusLabel);
  return sent ? "quote_sent" : "new";
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

/** All pipeline leads as flat cards with their effective status — for the table view. */
export function salesLeadCards(): LeadCard[] {
  const today = todayInOpsTz();
  const overrides = getLeadStatusMap();
  return getPipelineLeads(today).map((b) => toCard(b, today, overrides.get(b.bookingId) ?? defaultStatus(b)));
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
