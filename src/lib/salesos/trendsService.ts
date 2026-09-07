// Sales Trends — service layer. Runs the season / event-type / area cuts over the full booking
// history for the Trends view.

import { getAllBookings } from "@/lib/db/repo";
import { seasonTrends, typeTrends, areaTrends, type MonthTrend, type TypeTrend, type AreaTrend, type TrendInput } from "./trends";

export interface TrendsOverview {
  season: MonthTrend[];
  types: TypeTrend[];
  areas: AreaTrend[];
  hasLocationData: boolean; // location is only populated after a pull that captures it
}

export function salesTrends(): TrendsOverview {
  const deals: TrendInput[] = getAllBookings().map((b) => ({
    signed: b.signed,
    statusLabel: b.statusLabel,
    grandTotal: b.grandTotal,
    eventDate: b.eventDate,
    eventName: b.eventName,
    location: b.location,
  }));
  return {
    season: seasonTrends(deals),
    types: typeTrends(deals),
    areas: areaTrends(deals),
    hasLocationData: deals.some((d) => d.location && d.location.trim().length > 0),
  };
}
