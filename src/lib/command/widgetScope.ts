// Command Center widget data-scope contract. Every widget declares its business time horizon, which
// date its numbers are based on, and whether it responds to the global date selector. This is the single
// source of truth the dashboard uses to LABEL each widget's scope, so a user never has to guess what
// period a number represents. The guiding rule: the global selector controls time-window-sensitive
// operational views (Upcoming Events, Quote Activity) and NOT annual/MTD/current-open reporting.

export type DateBasis =
  | "revenueDate" // booked/signed revenue dated to its event/period
  | "eventDate" // horizon measured by the event's date
  | "createdDate" // measured by when the quote was created/sent
  | "liveState" // a current snapshot (no date window)
  | "none";

export interface ScopeMeta {
  scope: string; // human-readable horizon shown in the header, e.g. "October MTD", "Current open"
  dateBasis: DateBasis;
  responsive: boolean; // true = responds to the global date selector
}

export const WIDGET_SCOPE = {
  revenue: { scope: "Month to date", dateBasis: "revenueDate", responsive: false },
  openQuotes: { scope: "Current open", dateBasis: "eventDate", responsive: false },
  bookedEvents: { scope: "This month", dateBasis: "eventDate", responsive: false },
  risks: { scope: "Current open", dateBasis: "liveState", responsive: false },
  fleet: { scope: "Today", dateBasis: "liveState", responsive: false },
  aiSessions: { scope: "Active", dateBasis: "liveState", responsive: false },
  upcomingEvents: { scope: "Selected range", dateBasis: "eventDate", responsive: true },
  revenuePerformance: { scope: "Annual", dateBasis: "revenueDate", responsive: false },
  // Quote Pipeline has two modes: Pipeline = current-open by eventDate (fixed); Activity = createdDate,
  // responsive to the global selector. The default (Pipeline) is reflected here.
  quotePipeline: { scope: "Current open", dateBasis: "eventDate", responsive: false },
  capacity: { scope: "Next 7 days", dateBasis: "eventDate", responsive: false },
  todaysOps: { scope: "Today", dateBasis: "liveState", responsive: false },
  needsAttention: { scope: "Current open", dateBasis: "liveState", responsive: false },
  topOpportunities: { scope: "Current open", dateBasis: "eventDate", responsive: false },
  nextActions: { scope: "Current open", dateBasis: "liveState", responsive: false },
} as const satisfies Record<string, ScopeMeta>;

export type WidgetKey = keyof typeof WIDGET_SCOPE;
