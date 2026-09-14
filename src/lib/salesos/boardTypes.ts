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
}
