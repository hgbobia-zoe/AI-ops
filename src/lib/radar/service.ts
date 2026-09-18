// Event Radar — service layer. Reads FACTS from the store and runs the PURE engines over them to
// produce the fully-derived views the UI renders: qualification (score/tier/explanation), recurrence,
// timing. Nothing here is persisted — same facts always yield the same view. This is where "RULES
// CALCULATE" is assembled.

import { todayInOpsTz } from "@/lib/dates";
import { qualify } from "./qualify";
import { deriveRecurrence } from "./recurrence";
import { deriveTiming } from "./timing";
import {
  getEvents,
  getEvent,
  getOrganization,
  getSeries,
  getSeriesInstances,
  getPlannersForEvent,
  getOpportunityForEvent,
  type StoredEvent,
  type StoredOrganization,
  type StoredPlanner,
  type StoredOpportunity,
} from "./store";
import type { Qualification, RecurrenceView, TimingView, OpportunityTier } from "./types";

export interface RadarEventView {
  event: StoredEvent;
  qualification: Qualification;
  timing: TimingView;
}

export interface RadarEventDetail extends RadarEventView {
  organization: StoredOrganization | null;
  planners: StoredPlanner[];
  recurrence: RecurrenceView;
  opportunity: StoredOpportunity | null;
}

/** Derive the qualification + timing for one stored event. */
export function viewFor(event: StoredEvent, today: string = todayInOpsTz()): RadarEventView {
  const qualification = qualify({
    category: event.category,
    region: event.region,
    startDate: event.startDate,
    endDate: event.endDate,
    expectedAttendance: event.expectedAttendance,
    attendanceConfidence: event.attendanceConfidence,
    recurring: event.recurring,
    attributes: event.attributes,
  });
  const timing = deriveTiming({
    startDate: event.startDate,
    category: event.category,
    expectedAttendance: event.expectedAttendance,
    recurring: event.recurring,
    today,
  });
  return { event, qualification, timing };
}

export interface RadarBoard {
  today: string;
  rows: RadarEventView[]; // ranked: tier, then commercial-opportunity score, then soonest date
  metrics: {
    newlyDetected: number; // detected in the last 7 days
    highFit: number;
    plannersIdentified: number; // events with a known (verified/inferred) planner
    enteringOutreach: number; // in the OUTREACH_WINDOW or ACTIVELY_SHOPPING phase
    recurring: number;
    potentialOpportunities: number; // HIGH+MEDIUM not yet handed off
  };
  hasSeedData: boolean;
}

const TIER_RANK: Record<OpportunityTier, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNQUALIFIED: 0 };

/** The Event Radar board: every detected event with its derived intelligence, ranked, plus the
 *  operational dashboard metrics. */
export function radarBoard(today: string = todayInOpsTz()): RadarBoard {
  const events = getEvents();
  const rows = events
    .map((e) => viewFor(e, today))
    .sort(
      (a, b) =>
        TIER_RANK[b.qualification.tier] - TIER_RANK[a.qualification.tier] ||
        b.qualification.commercialOpportunityScore - a.qualification.commercialOpportunityScore ||
        (a.event.startDate ?? "9999").localeCompare(b.event.startDate ?? "9999"),
    );

  const sevenDaysAgo = Date.now() - 7 * 86_400_000;
  const metrics = {
    newlyDetected: rows.filter((r) => Date.parse(r.event.discoveredAt) >= sevenDaysAgo).length,
    highFit: rows.filter((r) => r.qualification.tier === "HIGH").length,
    plannersIdentified: rows.filter((r) => r.event.plannerStatus !== "UNKNOWN").length,
    enteringOutreach: rows.filter((r) => r.timing.phase === "OUTREACH_WINDOW" || r.timing.phase === "ACTIVELY_SHOPPING").length,
    recurring: rows.filter((r) => r.event.recurring).length,
    potentialOpportunities: rows.filter((r) => (r.qualification.tier === "HIGH" || r.qualification.tier === "MEDIUM") && r.event.salesStatus === "NONE").length,
  };

  return { today, rows, metrics, hasSeedData: events.some((e) => e.isSeed) };
}

/** Full detail for one event: facts + qualification + timing + recurrence + org + planners + handoff. */
export function radarEventDetail(id: string, today: string = todayInOpsTz()): RadarEventDetail | null {
  const event = getEvent(id);
  if (!event) return null;
  const base = viewFor(event, today);
  const organization = getOrganization(event.organizationId);
  const planners = getPlannersForEvent(event.id, event.organizationId);

  let recurrence: RecurrenceView;
  if (event.parentSeriesId) {
    const series = getSeries(event.parentSeriesId);
    const instances = getSeriesInstances(event.parentSeriesId).map((e) => ({ id: e.id, name: e.name, date: e.startDate, isSeed: e.isSeed }));
    recurrence = deriveRecurrence(series ? { id: series.id, name: series.name, cadence: series.cadence } : null, instances, today);
  } else {
    recurrence = { recurring: false, confidence: "NONE", history: [], predictedNext: null };
  }

  return { ...base, organization, planners, recurrence, opportunity: getOpportunityForEvent(id) };
}
