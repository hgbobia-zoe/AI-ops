// Lost Quotes tracker — service layer. Runs the deterministic win/loss engine over the full booking
// history and prepares the post-mortem list (recent lost quotes to review and tag). Stats/reasons are
// computed over ALL lost quotes; only the displayed list is trimmed for the page.

import { todayInOpsTz } from "@/lib/dates";
import { getAllBookings, getLostQuotes, type BookingView } from "@/lib/db/repo";
import { lossFlagState, lossReasonFlagsEnabled, type LossFlagState } from "./lossReasonFlag";
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

export interface LossTracking {
  enabled: boolean;
  waiting: number; // inside the grace period
  flagged: number; // asked, still no reason
  noted: number; // reason written in GS notes (not tagged yet)
  tagged: number; // tracked and tagged in the app
}

export interface LostQuoteView {
  id: string;
  eventName: string;
  clientName: string;
  eventDate: string | null;
  value: number | null;
  statusLabel: string;
  lossReason: string | null;
  flag: LossFlagState; // lost-reason tracker state ("untracked" = lost before tracking began)
  lossNoteText: string | null; // the reason as written in the GS notes, when that is how it was given
}

const toLostView = (b: BookingView, nowMs: number): LostQuoteView => ({
  id: b.bookingId,
  eventName: b.eventName,
  clientName: b.clientName,
  eventDate: b.eventDate,
  value: b.grandTotal,
  statusLabel: b.statusLabel,
  lossReason: b.lossReason,
  flag: lossFlagState(b, nowMs),
  lossNoteText: b.lossNoteText ?? null,
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
  tracking: LossTracking;
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

  // Tracked quotes (newly lost, waiting on a reason) first so they are never trimmed off the list.
  const nowMs = Date.now();
  const tracked = lostRows.filter((b) => b.lossTrackAt);
  const listRows = [...tracked.sort((a, b) => (b.lossTrackAt ?? "").localeCompare(a.lossTrackAt ?? "")), ...lostRows.filter((b) => !b.lossTrackAt)];
  const tracking: LossTracking = { enabled: lossReasonFlagsEnabled(), waiting: 0, flagged: 0, noted: 0, tagged: 0 };
  for (const b of tracked) {
    const st = lossFlagState(b, nowMs);
    if (st === "waiting" || st === "due") tracking.waiting++;
    else if (st === "flagged") tracking.flagged++;
    else if (st === "noted") tracking.noted++;
    else if (st === "tagged") tracking.tagged++;
  }

  return {
    today,
    stats,
    sizeBuckets,
    byYear,
    reasons,
    insights,
    lost: listRows.slice(0, LIST_LIMIT).map((b) => toLostView(b, nowMs)),
    lostTotal: lostRows.length,
    listLimit: LIST_LIMIT,
    tracking,
  };
}
