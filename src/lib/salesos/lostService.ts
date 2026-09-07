// Lost Quotes tracker — service layer. Runs the deterministic win/loss engine over the full booking
// history and prepares the post-mortem list (recent lost quotes to review and tag). Stats/reasons are
// computed over ALL lost quotes; only the displayed list is trimmed for the page.

import { todayInOpsTz } from "@/lib/dates";
import { getAllBookings, getLostQuotes, type BookingView } from "@/lib/db/repo";
import {
  winLossStats,
  winRateBySize,
  winLossByYear,
  reasonBreakdown,
  lossInsights,
  type LostInput,
  type WinLossStats,
  type SizeBucket,
  type YearWinLoss,
  type ReasonCount,
  type Insight,
} from "./lost";

/** The reason vocabulary the team tags a lost quote with (event-rental / DMV market realities). */
export const LOSS_REASONS: string[] = [
  "Price — too expensive",
  "Went with a competitor",
  "Availability — we couldn't fulfill",
  "Date/event changed or cancelled",
  "Budget cut",
  "No response — ghosted",
  "Out of service area",
  "Duplicate / test",
  "Other",
];

const toInput = (b: BookingView): LostInput => ({
  signed: b.signed,
  statusLabel: b.statusLabel,
  grandTotal: b.grandTotal,
  eventDate: b.eventDate,
  lossReason: b.lossReason,
});

export interface LostQuoteView {
  id: string;
  eventName: string;
  clientName: string;
  eventDate: string | null;
  value: number | null;
  statusLabel: string;
  lossReason: string | null;
}

const toLostView = (b: BookingView): LostQuoteView => ({
  id: b.bookingId,
  eventName: b.eventName,
  clientName: b.clientName,
  eventDate: b.eventDate,
  value: b.grandTotal,
  statusLabel: b.statusLabel,
  lossReason: b.lossReason,
});

export interface LostQuotesOverview {
  today: string;
  stats: WinLossStats;
  sizeBuckets: SizeBucket[];
  byYear: YearWinLoss[];
  reasons: { tagged: ReasonCount[]; untaggedCount: number };
  insights: Insight[];
  lost: LostQuoteView[]; // recent lost quotes to review/tag (trimmed)
  lostTotal: number; // total lost quotes (list may be trimmed)
  listLimit: number;
}

const LIST_LIMIT = 150;

export function lostQuotesOverview(): LostQuotesOverview {
  const today = todayInOpsTz();
  const all = getAllBookings().map(toInput);
  const lostRows = getLostQuotes();

  const stats = winLossStats(all);
  const sizeBuckets = winRateBySize(all);
  const byYear = winLossByYear(all);
  const reasons = reasonBreakdown(lostRows.map(toInput));
  const insights = lossInsights(stats, sizeBuckets, reasons);

  return {
    today,
    stats,
    sizeBuckets,
    byYear,
    reasons,
    insights,
    lost: lostRows.slice(0, LIST_LIMIT).map(toLostView),
    lostTotal: lostRows.length,
    listLimit: LIST_LIMIT,
  };
}
