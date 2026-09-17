// Event Radar — configurable scoring weights, tier thresholds, geography and timing windows.
//
// Everything the qualification/timing engine keys off lives here, NOT scattered through the UI or the
// engine body. Weights are points a signal contributes to the 0–100 rental-fit score; thresholds map
// that score to a tier. Tuning Zoe's model = editing this file (or, later, overriding from settings).

import type { AttributeKey, EventCategory } from "./types";

export interface RadarConfig {
  /** Base points a category contributes toward rental fit (0 = neutral/unlikely to need rentals). */
  categoryWeight: Record<EventCategory, number>;
  /** Points each PRESENT rental attribute adds. */
  attributeWeight: Record<AttributeKey, number>;
  /** Attendance band thresholds (people) → points. Evaluated high-to-low; first match wins. */
  attendanceBands: { min: number; points: number; label: string }[];
  multiDayPoints: number; // multi-day event
  recurringPoints: number; // part of a known recurring series
  inRegionPoints: number; // within Zoe's DMV service area
  outOfAreaPenalty: number; // outside the service area (negative)
  virtualPenalty: number; // fully virtual (negative)
  tinyEventPenalty: number; // very small known attendance (negative)
  /** Rental-fit score → tier. Evaluated high-to-low. */
  tierThresholds: { min: number; tier: "HIGH" | "MEDIUM" | "LOW" }[];
  /** Indicative rental spend per attendee (dollars), by category — for the coarse value RANGE only.
   *  Applied as [low, high] multipliers × attendance. Never a revenue prediction. */
  valuePerAttendee: Partial<Record<EventCategory, { low: number; high: number }>>;
  /** Outreach timing: months before the event that define each engagement window. */
  timing: {
    planningWindowStartDays: number; // beyond this many days out → too early
    outreachWindowStartDays: number; // begin relationship outreach
    activelyShoppingDays: number; // typically choosing vendors by now
    imminentDays: number; // event is right up
  };
}

export const DEFAULT_RADAR_CONFIG: RadarConfig = {
  categoryWeight: {
    CONFERENCE: 22,
    TRADE_SHOW: 24,
    EXPO: 22,
    ASSOCIATION_MEETING: 18,
    GALA: 24,
    FUNDRAISER: 18,
    CORPORATE: 16,
    MEDICAL: 20,
    GOVERNMENT: 14,
    UNIVERSITY: 14,
    NONPROFIT: 14,
    AWARDS: 18,
    NETWORKING: 12,
    OUTDOOR_RECEPTION: 22,
    HOSPITALITY: 18,
    OTHER: 6,
  },
  attributeWeight: {
    reception: 10,
    exhibitors: 9,
    networking: 5,
    gala: 10,
    outdoor: 11,
    hospitality: 7,
    vip: 5,
    sponsor_activation: 6,
    virtual: 0, // handled via virtualPenalty
  },
  attendanceBands: [
    { min: 2000, points: 22, label: "2,000+ expected attendees" },
    { min: 750, points: 18, label: "750+ expected attendees" },
    { min: 300, points: 13, label: "300+ expected attendees" },
    { min: 100, points: 8, label: "100+ expected attendees" },
    { min: 1, points: 3, label: "small expected attendance" },
  ],
  multiDayPoints: 8,
  recurringPoints: 9,
  inRegionPoints: 8,
  outOfAreaPenalty: -40,
  virtualPenalty: -35,
  tinyEventPenalty: -18, // known attendance under tinyEventMax (see qualify.ts)
  tierThresholds: [
    { min: 70, tier: "HIGH" },
    { min: 45, tier: "MEDIUM" },
    { min: 20, tier: "LOW" },
  ],
  valuePerAttendee: {
    CONFERENCE: { low: 8, high: 25 },
    TRADE_SHOW: { low: 10, high: 30 },
    EXPO: { low: 10, high: 30 },
    GALA: { low: 20, high: 55 },
    AWARDS: { low: 18, high: 50 },
    FUNDRAISER: { low: 15, high: 45 },
    ASSOCIATION_MEETING: { low: 8, high: 24 },
    CORPORATE: { low: 12, high: 35 },
    MEDICAL: { low: 10, high: 28 },
    OUTDOOR_RECEPTION: { low: 25, high: 65 },
    HOSPITALITY: { low: 15, high: 40 },
  },
  timing: {
    planningWindowStartDays: 365,
    outreachWindowStartDays: 210, // ~7 months out
    activelyShoppingDays: 120, // ~4 months out
    imminentDays: 30,
  },
};

/** Attendance at/below this (when KNOWN) is a "very small event" negative signal. */
export const TINY_EVENT_MAX = 40;
