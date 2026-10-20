// Client-safe Sales OS board types + constants — no DB/server imports, so client components (the
// Kanban board, the table) can import these without pulling server code into the bundle.

export type BoardStatus = "new" | "quote_sent" | "follow_up" | "action_needed" | "signed";
export type LeadStatus = BoardStatus | "archived";

export const BOARD_COLUMNS: { key: BoardStatus; label: string }[] = [
  { key: "new", label: "New" },
  { key: "quote_sent", label: "Quote Sent" },
  { key: "follow_up", label: "Need Follow-up" },
  { key: "action_needed", label: "Action Needed" },
  { key: "signed", label: "Signed" },
];

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  quote_sent: "Quote Sent",
  follow_up: "Need Follow-up",
  action_needed: "Action Needed",
  signed: "Signed",
  archived: "Archived",
};

/** The lead-state filters offered in the shared Sales OS header (Goodshuffle-style). Each maps 1:1 onto
 *  an existing board status — no new state is invented. "Need Follow-up" is intentionally omitted from
 *  the header per the product spec; it stays filterable from the Table's own richer status chips. */
export const STATE_FILTERS: { key: BoardStatus; label: string }[] = [
  { key: "new", label: "New" },
  { key: "quote_sent", label: "Quote Sent" },
  { key: "action_needed", label: "Action Needed" },
  { key: "signed", label: "Signed" },
];

export const FOLLOWUP_SILENCE_DAYS = 4; // quote sent + this many days with no contact → Need Follow-up

/** The minimal booking facts the auto-classifier reads (structural, so this stays client-safe). */
export interface AutoStatusFacts {
  signed: boolean;
  statusLabel: string;
  quoteSentDate: string | null;
}

/** Derived signals (shared with the worklist/command-center) that refine the auto status. */
export interface AutoStatusSignals {
  state: string; // customer state machine value
  nbaAction: string; // next-best-action
  repliedMinutesAgo: number | null;
  daysSinceContact: number | null;
}

function ymdDaysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Days since the lead was last touched (either direction), falling back to the quote-sent date.
 *  null when we have neither signal. Shared by the board and the worklist so both agree. */
export function daysSinceContactDays(lastCommsAt: string | null, quoteSentDate: string | null, today: string): number | null {
  if (lastCommsAt) return ymdDaysBetween(lastCommsAt.slice(0, 10), today);
  if (quoteSentDate) return ymdDaysBetween(quoteSentDate.slice(0, 10), today);
  return null;
}

/** Automatic board status from the same signals the worklist uses — THE single classifier behind the
 *  state filter (RULES CALCULATE). A manual drag overrides this upstream.
 *  - signed → Signed; lost/cancelled → archived (off board)
 *  - customer just replied, an urgent next-action, or an objection/ready state → Action Needed
 *  - quote not sent → New
 *  - sent but dormant / silent past the follow-up window → Need Follow-up
 *  - otherwise (sent, waiting) → Quote Sent */
export function autoStatus(b: AutoStatusFacts, sig: AutoStatusSignals): LeadStatus {
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

export interface LeadCard {
  id: string;
  eventName: string;
  clientName: string;
  value: number | null;
  netPaid: number | null;
  amountDue: number | null;
  remainingBalance: number | null;
  eventDate: string | null;
  dateCreated: string | null;
  quoteSentDate: string | null;
  statusLabel: string;
  daysToEvent: number | null;
  status: LeadStatus;
  venue: string | null; // address signals (searchable in the Sales OS views)
  location: string | null;
}
