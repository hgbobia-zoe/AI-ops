// Competitive Bid Review — service layer. Builds the decided-deal history (won/lost with a value)
// from all bookings and runs the deterministic bid engine over it. This is Zoe's own DMV-market
// record — the honest basis for "priced to win?".

import { getAllBookings } from "@/lib/db/repo";
import { outcomeOf } from "./lost";
import { bidReview, type BidReview, type DecidedDeal } from "./bidReview";

/** Every decided (won or lost) deal that carries a usable value — the comparison pool. */
export function decidedHistory(): DecidedDeal[] {
  const out: DecidedDeal[] = [];
  for (const b of getAllBookings()) {
    const o = outcomeOf(b);
    if (o === "open") continue;
    if (typeof b.grandTotal !== "number" || b.grandTotal <= 0) continue;
    out.push({ value: b.grandTotal, won: o === "won", month: b.eventDate ? Number(b.eventDate.slice(5, 7)) : null });
  }
  return out;
}

export interface BidReviewResult extends BidReview {
  historyCount: number; // total decided deals in the comparison pool (for transparency)
}

export function reviewBid(value: number, month?: number): BidReviewResult {
  const history = decidedHistory();
  return { ...bidReview({ value, month }, history), historyCount: history.length };
}
