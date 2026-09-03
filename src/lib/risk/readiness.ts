// Event Risk Engine (MVP2) — per-event readiness score (0-100).
//
// Deterministic: each weighted component starts full and is docked by the WORST finding that
// maps to it. A CRITICAL finding zeroes its component AND sets risk_level = CRITICAL, so a high
// numeric score can never hide an operational failure (the UI shows risk_level, not just score).

import { SEVERITY_RANK, type RiskFinding, type RiskSeverity, type RiskCategory } from "./types";

export interface ReadinessInput {
  eventId: string;
  date: string;
  label: string;
  routeId?: string;
}

export interface EventReadiness {
  eventId: string;
  date: string;
  label: string;
  routeId?: string;
  score: number;
  components: {
    staffing: number;
    driver: number;
    warehouse: number;
    schedule: number;
    information: number;
    communication: number;
    payment: number;
    special: number;
  };
  /** Worst severity among the event's findings, or "READY" when clean. */
  riskLevel: RiskSeverity | "READY";
}

type Component = keyof EventReadiness["components"];

const WEIGHTS: Record<Component, number> = {
  staffing: 25,
  driver: 20,
  warehouse: 15,
  schedule: 15,
  information: 10,
  communication: 5,
  payment: 5,
  special: 5,
};

const CATEGORY_TO_COMPONENT: Record<RiskCategory, Component> = {
  STAFFING: "staffing",
  DRIVER: "driver",
  WAREHOUSE: "warehouse",
  ROUTE: "schedule",
  SCHEDULE: "schedule",
  PICKUP: "schedule",
  INVENTORY: "schedule",
  EVENT_INFORMATION: "information",
  CUSTOMER_COMMUNICATION: "communication",
  PAYMENT: "payment",
  SETUP: "special",
  SPECIAL_REQUIREMENT: "special",
  OTHER: "schedule",
};

// Fraction of a component's weight removed by its worst finding.
const DEDUCTION: Record<RiskSeverity, number> = { CRITICAL: 1, HIGH: 0.7, MEDIUM: 0.4, LOW: 0.15 };

/** A finding belongs to an event when it's on the event's date and either matches its route or is day-level. */
function findingAffects(f: RiskFinding, ev: ReadinessInput): boolean {
  if (f.eventId && f.eventId === ev.eventId) return true;
  if (f.date !== ev.date) return false;
  if (f.routeId) return f.routeId === ev.routeId;
  return true; // day-level finding (no route) applies to every event that day
}

export function computeReadiness(events: ReadinessInput[], findings: RiskFinding[]): EventReadiness[] {
  return events.map((ev) => {
    // UNVERIFIED findings (e.g. Connecteam unreachable) are UNKNOWNS, not deficiencies — they must
    // never dock the score or set a risk level, or an infra outage would silently lower readiness.
    const mine = findings.filter((f) => findingAffects(f, ev) && !f.unverified);
    const worstByComponent = new Map<Component, RiskSeverity>();
    for (const f of mine) {
      const c = CATEGORY_TO_COMPONENT[f.category];
      const cur = worstByComponent.get(c);
      if (!cur || SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur]) worstByComponent.set(c, f.severity);
    }
    const components = {} as EventReadiness["components"];
    let score = 0;
    (Object.keys(WEIGHTS) as Component[]).forEach((c) => {
      const worst = worstByComponent.get(c);
      const val = Math.round(WEIGHTS[c] * (1 - (worst ? DEDUCTION[worst] : 0)));
      components[c] = val;
      score += val;
    });
    const worstOverall = mine.reduce<RiskSeverity | null>(
      (m, f) => (m === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[m] ? f.severity : m),
      null,
    );
    return {
      eventId: ev.eventId,
      date: ev.date,
      label: ev.label,
      routeId: ev.routeId,
      score,
      components,
      riskLevel: worstOverall ?? "READY",
    };
  });
}
