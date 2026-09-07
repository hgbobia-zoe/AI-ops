// AI Sales OS (Phase 1) — service layer. Reads OPEN leads from the bookings table and runs the
// deterministic engine (calc.ts) over each: lifecycle stage, next-best-action, priority score.
// Everything is a fact-derived recommendation for a HUMAN to act on — the system never contacts a
// customer on its own (approval-based comms is a later phase).
//
// Phase-1 honesty: hasCommsIntegration is FALSE — we can't see replies or calls yet, so every "went
// quiet" read is an inference from elapsed time. The UI shows that caveat.

import { todayInOpsTz } from "@/lib/dates";
import { getOpenLeads, getBookingById, type BookingView } from "@/lib/db/repo";
import {
  deriveSalesState,
  nextBestAction,
  priorityScore,
  DEFAULT_THRESHOLDS,
  type LeadSignals,
  type SalesStage,
  type NextAction,
  type PriorityScore,
} from "./calc";

/** Whole days from `fromYmd` to `toYmd` (positive when `to` is later). Date-only, UTC — no TZ drift. */
function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export interface LeadView {
  id: string;
  eventName: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  eventDate: string | null;
  statusLabel: string;
  value: number | null; // potential $ (grand_total)
  amountPaid: number | null;
  amountDue: number | null;
  quoteSentDate: string | null;
  dateCreated: string | null;
  signals: LeadSignals;
  stage: SalesStage;
  action: NextAction;
  priority: PriorityScore;
}

/** Build a LeadView (signals + derived stage/action/score) from one booking row, relative to `today`. */
export function toLeadView(b: BookingView, today: string): LeadView {
  const everSent = !!b.quoteSentDate;
  const ageAnchor = b.quoteSentDate ?? b.dateCreated ?? null;
  const signals: LeadSignals = {
    daysToEvent: b.eventDate ? daysBetween(today, b.eventDate) : null,
    quoteAgeDays: ageAnchor ? daysBetween(ageAnchor, today) : null,
    everSent,
    hasPhone: b.clientPhone.trim().length > 0,
    hasEmail: b.clientEmail.trim().length > 0,
    value: b.grandTotal,
  };
  const stage = deriveSalesState(signals, DEFAULT_THRESHOLDS);
  return {
    id: b.bookingId,
    eventName: b.eventName,
    clientName: b.clientName,
    clientPhone: b.clientPhone,
    clientEmail: b.clientEmail,
    eventDate: b.eventDate,
    statusLabel: b.statusLabel,
    value: b.grandTotal,
    amountPaid: b.amountPaid,
    amountDue: b.amountDue,
    quoteSentDate: b.quoteSentDate,
    dateCreated: b.dateCreated,
    signals,
    stage,
    action: nextBestAction(stage, signals),
    priority: priorityScore(stage, signals),
  };
}

export interface SalesLeadsOverview {
  today: string;
  leads: LeadView[]; // sorted by priority desc, then soonest event
  counts: Record<SalesStage, number>;
  totalOpen: number;
  totalPotential: number | null; // sum of known potential $
  actNowCount: number; // leads whose action urgency is "now"
  hasCommsIntegration: boolean; // Phase 1: false — no inbound/reply visibility yet
}

const EMPTY_COUNTS = (): Record<SalesStage, number> => ({ unsent: 0, awaiting: 0, follow_up: 0, cold: 0, closing: 0 });

/** The Sales OS worklist: every open lead, ranked by what to do next. */
export function salesLeads(): SalesLeadsOverview {
  const today = todayInOpsTz();
  const leads = getOpenLeads(today)
    .map((b) => toLeadView(b, today))
    .sort((a, b) => b.priority.score - a.priority.score || (a.eventDate ?? "9999").localeCompare(b.eventDate ?? "9999"));

  const counts = EMPTY_COUNTS();
  let totalPotential: number | null = null;
  let actNowCount = 0;
  for (const l of leads) {
    counts[l.stage]++;
    if (l.value != null) totalPotential = (totalPotential ?? 0) + l.value;
    if (l.action.urgency === "now") actNowCount++;
  }

  return {
    today,
    leads,
    counts,
    totalOpen: leads.length,
    totalPotential,
    actNowCount,
    hasCommsIntegration: false,
  };
}

/** One lead by Goodshuffle project id, or null if unknown. */
export function getLead(id: string): LeadView | null {
  const b = getBookingById(id);
  return b ? toLeadView(b, todayInOpsTz()) : null;
}
