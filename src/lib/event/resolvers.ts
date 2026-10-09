// Thin RESOLVER layer — gathers the non-pure FACTS an event's requirements/readiness need, by COMPOSING
// existing readers, then feeds the PURE cores (requirements.ts, readiness.ts, lifecycle.ts). No new SQL,
// no duplicated logic, no second risk system: risk findings come straight from the existing risk queue
// (src/lib/risk/store.ts getRiskQueue) and the existing per-event readiness (src/lib/risk/readiness.ts).
//
// getEventReadiness(id) is the end-to-end composition a caller uses to get, for one event: its EventView,
// its data-backed requirement set, its readiness condition (the independent axis), and its lifecycle state
// (now gated to READY by the requirements).

import { getRouteById, getUpcomingItemStops } from "@/lib/db/repo";
import { getShiftsForDate } from "@/lib/scheduling/store";
import { crewForRoute } from "@/lib/crewRules";
import { normalizeItem, peakItemDemand } from "@/lib/inventory/inventory";
import { getRiskQueue } from "@/lib/risk/store";
import type { RiskFinding, RiskCategory, RiskSeverity } from "@/lib/risk/types";
import { eventWeather, daysUntilDate } from "@/lib/weather";
import type { WeatherResult } from "@/lib/weather/types";
import { getEvent } from "./adapter";
import { canonicalEventId, eventIdEquals, type EventId } from "./id";
import { generateRequirements, type RequirementFacts, type StaffingFact, type InventoryConcurrencyFact } from "./requirements";
import { computeEventReadiness } from "./readiness";
import { deriveLifecycle } from "./lifecycle";
import type { EventReadinessResult, EventView, Requirement } from "./types";
import type { LifecycleState } from "./machine";

export interface EventReadinessBundle {
  view: EventView;
  requirements: Requirement[];
  readiness: EventReadinessResult;
  lifecycleState: LifecycleState;
  lifecycleReasons: string[];
  weather: WeatherResult | null;
}

export interface GetEventReadinessDeps {
  now?: Date;
  /** Injected weather resolver (tests). Defaults to the real eventWeather. */
  weather?: typeof eventWeather;
}

/**
 * End-to-end readiness for one event id. Returns null when the id doesn't resolve to a real event.
 * Async only because the weather module makes a network call (short-timeout, honest-fallback).
 */
export async function getEventReadiness(
  input: number | string,
  deps: GetEventReadinessDeps = {},
): Promise<EventReadinessBundle | null> {
  const id = canonicalEventId(input);
  if (id === null) return null;
  const view = getEvent(id);
  if (!view) return null;

  const now = deps.now ?? new Date();
  const date = view.ref.date;
  const daysUntilEvent = date ? daysUntilDate(date, now) : null;

  const staffing = resolveStaffing(id, view);
  const inventory = resolveInventoryConcurrency(id, view);
  const weatherFn = deps.weather ?? eventWeather;
  const weather = date ? await weatherFn({ dateISO: date, address: resolveAddress(id, view) }) : null;

  const facts: RequirementFacts = { daysUntilEvent, staffing, weather, inventory };
  const requirements = generateRequirements(view, facts);

  const riskFindings = resolveRiskFindings(id);
  const readiness = computeEventReadiness(requirements, riskFindings, {
    event: { eventId: id, date: date ?? "", label: view.ref.displayName ?? "", routeId: view.logistics.routeId ?? undefined },
    daysUntilEvent,
  });

  const derivation = deriveLifecycle(view, { requirements });
  return {
    view,
    requirements,
    readiness,
    lifecycleState: derivation.state,
    lifecycleReasons: derivation.reasons,
    weather,
  };
}

/** Resolve staffing facts for the event's primary route — required crew (crewRules) vs assigned (the
 *  app schedule's assignees + the Dispatch driver). verified = the schedule has been generated for this
 *  route/date. Returns null when there's no route to staff. */
export function resolveStaffing(id: EventId, view: EventView): StaffingFact | null {
  const routeId = view.logistics.routeId;
  if (!routeId || !view.logistics.present) return null;
  const route = getRouteById(routeId);
  if (!route) return null;

  const need = crewForRoute(route.stops.map((s) => s.items ?? []));

  const routeShifts = getShiftsForDate(route.date).filter((s) => s.routeId === routeId);
  const verified = routeShifts.length > 0;
  const assignees = new Set<number>();
  for (const sh of routeShifts) for (const a of sh.assignees) assignees.add(a);
  const driverAssigned = !!route.driverId;
  // The Dispatch driver counts as crew even if not in a shift row (distinct id when numeric).
  if (driverAssigned && route.driverId && !assignees.has(Number(route.driverId))) assignees.add(Number(route.driverId) || -1);

  return {
    verified,
    requiredCrew: need.crew,
    assignedCrew: assignees.size,
    hasTent: need.hasTent,
    tentReasons: need.reasons,
    driverAssigned,
  };
}

/** Resolve the concurrency SIGNAL for this event's items (never an over-booking verdict — owned master is
 *  absent by design). Composes getUpcomingItemStops + peakItemDemand. sharedWithOtherEvents = the item's
 *  peak day carries it for MORE than one event. Returns null when the event has no dated items. */
export function resolveInventoryConcurrency(id: EventId, view: EventView): InventoryConcurrencyFact | null {
  const date = view.ref.date;
  if (!date) return null;
  const myItems = new Set<string>();
  for (const s of view.logistics.stops) for (const it of s.items ?? []) {
    const k = normalizeItem(it.name || "");
    if (k) myItems.add(k);
  }
  if (myItems.size === 0) return null;

  const allStops = getUpcomingItemStops(date).filter((s) => s.date === date);
  const peaks = peakItemDemand(allStops);
  // Distinct events carrying each normalized item on this date.
  const eventsByItem = new Map<string, Set<string>>();
  for (const s of allStops) {
    for (const it of s.items) {
      const k = normalizeItem(it.name || "");
      if (!k || !myItems.has(k)) continue;
      const set = eventsByItem.get(k) ?? new Set<string>();
      set.add(s.eventId);
      eventsByItem.set(k, set);
    }
  }

  const items = [...myItems].map((k) => {
    const peak = peaks.find((p) => normalizeItem(p.name) === k);
    const events = eventsByItem.get(k) ?? new Set<string>();
    // "Shared" = this item appears for at least one OTHER event on the date.
    const otherEvents = [...events].filter((e) => !eventIdEquals(e, id)).length > 0;
    return {
      name: peak?.name ?? k,
      peakQty: peak?.peakQty ?? 0,
      peakDate: peak?.peakDate ?? date,
      sharedWithOtherEvents: otherEvents,
    };
  });
  return { items };
}

/** Risk findings for this event, taken straight from the existing risk queue (no re-assessment, no new
 *  risk system). Maps the persisted StoredRisk back to a RiskFinding for computeEventReadiness; `unverified`
 *  is inferred from the risk type (…_unverified) so infra-outage unknowns never dock readiness. */
export function resolveRiskFindings(id: EventId): RiskFinding[] {
  return getRiskQueue().map((r) => ({
    signature: r.signature,
    riskType: r.riskType,
    category: r.category as RiskCategory,
    severity: r.severity as RiskSeverity,
    title: r.title,
    description: r.description,
    date: r.date ?? "",
    eventId: r.eventId,
    routeId: r.routeId,
    unverified: /unverified$/i.test(r.riskType),
  }));
}

/** Best address to geocode for weather: the primary route's matching stop address, else the booking's
 *  venue. Composes getRouteById (no new SQL). */
function resolveAddress(id: EventId, view: EventView): string | null {
  const routeId = view.logistics.routeId;
  if (routeId) {
    const route = getRouteById(routeId);
    const stop = route?.stops.find((s) => eventIdEquals(s.txId, id));
    if (stop?.address) return stop.address;
  }
  return view.ref.venue;
}
