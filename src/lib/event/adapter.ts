// Read-only Event adapter — assembles the canonical Event from EXISTING reads only.
//
// Governing law: RULES CALCULATE. This layer introduces NO new persisted state, NO lifecycle writes,
// NO AI, and NO new SQL. It COMPOSES the repo/reader functions that already exist, joining them on the
// one canonical id (the GS project/transaction id). An Event exists ONLY if a `bookings` row AND/OR
// routed stops exist for the id — it is never fabricated. A fact a source can't back comes back
// null / present:false, and the types say so.
//
// Composition map (every call below is an existing reader — no logic is duplicated here):
//   • commercial  ← getBookingById            (bookings)            — authoritative event date + $ facts
//   • logistics   ← getEventStub + getRouteById(routes/stops)       — the primary route's stops for the tx
//   • financials  ← getEventFinancialsInRange  (event_financials)   — date-ranged reader, filtered by id
//   • labor       ← getProjectLaborLineage     (cost_entries)       — keyed directly by event_id
//   • outcome     ← getEventOutcome            (event_outcomes)     — keyed directly by event_id

import {
  getBookingById,
  getEventStub,
  getRouteById,
  getEventFinancialsInRange,
  getPipelineBookingsInRange,
  getProjectLaborLineage,
  type BookingView,
} from "@/lib/db/repo";
import { getEventOutcome } from "@/lib/history/store";
import { canonicalEventId, eventIdEquals, type EventId } from "./id";
import {
  UNVERIFIED,
  type CommercialSlice,
  type EventRef,
  type EventView,
  type FinancialsSlice,
  type LaborSlice,
  type LogisticsSlice,
  type LogisticsStop,
  type OutcomeSlice,
} from "./types";

function nonEmpty(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

/** The two grain readers an Event is reconstructed from: the commercial booking row (if any) and the
 *  logistics stub (earliest routed stop's date/label/route for the tx, if any). */
function loadBases(id: EventId): {
  booking: BookingView | null;
  stub: { date: string; label: string; routeId?: string } | null;
} {
  return { booking: getBookingById(id), stub: getEventStub(id) };
}

/** Build the logistics slice: the PRIMARY (earliest-dated) route's stops that belong to this event.
 *  Multi-route aggregation is a later phase (see LogisticsSlice docs) — flagged via primaryRouteOnly. */
function buildLogistics(id: EventId, routeId: string | undefined): LogisticsSlice {
  const route = routeId ? getRouteById(routeId) : null;
  if (!route) {
    return { present: false, routeId: routeId ?? null, stops: [], primaryRouteOnly: true, earliestWindow: null };
  }
  const stops: LogisticsStop[] = route.stops
    .filter((s) => eventIdEquals(s.txId, id))
    .map((s) => ({
      stopId: s.stopId,
      routeId: route.routeId,
      truckId: route.truckId,
      sequence: s.sequence,
      kind: s.kind ?? null,
      state: s.state,
      plannedWindow: s.plannedWindow ?? null,
      eta: s.eta ?? null,
      arrivedAt: s.arrivedAt ?? null,
      completedAt: s.completedAt ?? null,
      items: s.items ?? null,
    }));
  const windows = stops.map((s) => s.plannedWindow).filter((w): w is string => !!w).sort();
  return {
    present: stops.length > 0,
    routeId: route.routeId,
    stops,
    primaryRouteOnly: true,
    earliestWindow: windows[0] ?? null,
  };
}

function buildCommercial(booking: BookingView | null): CommercialSlice {
  if (!booking) {
    return {
      present: false,
      statusLabel: null,
      signed: null,
      grandTotal: null,
      contractTotal: null,
      amountPaid: null,
      amountDue: null,
      quoteSentAt: null,
      quoteOpenedAt: null,
      dateCreated: null,
      lossReason: null,
      archived: null,
      lineItems: null,
    };
  }
  return {
    present: true,
    statusLabel: nonEmpty(booking.statusLabel),
    signed: booking.signed,
    grandTotal: booking.grandTotal,
    contractTotal: booking.contractTotal,
    amountPaid: booking.amountPaid,
    amountDue: booking.amountDue,
    quoteSentAt: booking.quoteSentAt,
    quoteOpenedAt: booking.quoteOpenedAt,
    dateCreated: booking.dateCreated,
    lossReason: booking.lossReason,
    archived: booking.archived,
    lineItems: booking.lineItems,
  };
}

/** Financials via the date-ranged reader, filtered to this id. Needs at least one candidate date to
 *  query with (Phase 1 reuses only date-ranged readers for event_financials); absent otherwise. */
function buildFinancials(id: EventId, candidateDates: string[]): FinancialsSlice {
  const dates = candidateDates.filter((d) => !!d).sort();
  if (dates.length === 0) {
    return { present: false, revenue: null, revenueStatus: UNVERIFIED };
  }
  const rows = getEventFinancialsInRange(dates[0], dates[dates.length - 1]);
  const row = rows.find((r) => eventIdEquals(r.eventId, id));
  if (!row) return { present: false, revenue: null, revenueStatus: UNVERIFIED };
  return { present: true, revenue: row.revenue, revenueStatus: row.revenueStatus };
}

function buildLabor(id: EventId): LaborSlice {
  const leaves = getProjectLaborLineage(id);
  if (leaves.length === 0) return { present: false, totalCost: null, entryCount: 0 };
  const priced = leaves.filter((l) => l.amount != null);
  const totalCost = priced.length > 0 ? priced.reduce((sum, l) => sum + (l.amount as number), 0) : null;
  return { present: true, totalCost, entryCount: leaves.length };
}

function buildOutcome(id: EventId): OutcomeSlice {
  const o = getEventOutcome(id);
  if (!o) {
    return { present: false, routeId: null, totalStops: null, completedStops: null, allCompleted: null, closedAt: null };
  }
  return {
    present: true,
    routeId: o.routeId,
    totalStops: o.totalStops,
    completedStops: o.completedStops,
    allCompleted: o.allCompleted,
    closedAt: o.closedAt,
  };
}

function buildRef(
  id: EventId,
  booking: BookingView | null,
  stub: { date: string; label: string; routeId?: string } | null,
  logistics: LogisticsSlice,
): EventRef {
  // Date precedence: bookings.event_date is authoritative; fall back to the logistics date only when
  // there is no booking date at all. dateSource records which was used (honesty for later drift checks).
  const bookingDate = nonEmpty(booking?.eventDate ?? null);
  const logisticsDate = nonEmpty(stub?.date ?? null);
  const date = bookingDate ?? logisticsDate;
  const dateSource: EventRef["dateSource"] = bookingDate ? "booking" : logisticsDate ? "logistics" : null;

  const stubLabel = nonEmpty(stub?.label ?? null);
  const displayName = nonEmpty(booking?.eventName ?? null) ?? stubLabel;
  const customer = nonEmpty(booking?.clientName ?? null) ?? stubLabel;

  return {
    id,
    displayName,
    date,
    dateSource,
    // contactId is a stop-level fact — read it off this event's primary route (no new SQL).
    contactId: resolveContactId(logistics.routeId ?? stub?.routeId, id),
    customer,
    venue: nonEmpty(booking?.venue ?? null),
  };
}

/** The GS client contactID for this event, read off its primary route's matching stop. null when no
 *  routed stop carries one. Composes getRouteById (no new SQL). */
function resolveContactId(routeId: string | undefined, id: EventId): string | null {
  if (!routeId) return null;
  const route = getRouteById(routeId);
  if (!route) return null;
  const stop = route.stops.find((s) => eventIdEquals(s.txId, id));
  return nonEmpty(stop?.contactId ?? null);
}

/**
 * The canonical Event id for an input, or null when it can't be normalized AND resolved to anything
 * real. "Real" = a bookings row and/or routed stops exist for the id. Returns the normalized id so
 * callers can key derived tables by exactly the same value the adapter joins on.
 */
function resolveExistingId(input: number | string): EventId | null {
  const id = canonicalEventId(input);
  if (id === null) return null;
  const { booking, stub } = loadBases(id);
  return booking || stub ? id : null;
}

/** The identity + headline of an Event (light): no financials/labor/outcome composition. null when the
 *  id doesn't resolve to a real booking or routed stop. */
export function getEventRef(input: number | string): EventRef | null {
  const id = canonicalEventId(input);
  if (id === null) return null;
  const { booking, stub } = loadBases(id);
  if (!booking && !stub) return null;
  const logistics = buildLogistics(id, stub?.routeId);
  return buildRef(id, booking, stub, logistics);
}

/** The full composed Event (ref + every slice), or null when the id doesn't resolve to a real booking
 *  or routed stop. Pure composition of existing readers — no fabrication. */
export function getEvent(input: number | string): EventView | null {
  const id = canonicalEventId(input);
  if (id === null) return null;
  const { booking, stub } = loadBases(id);
  if (!booking && !stub) return null;

  const logistics = buildLogistics(id, stub?.routeId);
  const ref = buildRef(id, booking, stub, logistics);
  const commercial = buildCommercial(booking);
  const candidateDates = [nonEmpty(booking?.eventDate ?? null), nonEmpty(stub?.date ?? null)].filter(
    (d): d is string => !!d,
  );
  const financials = buildFinancials(id, candidateDates);
  const labor = buildLabor(id);
  const outcome = buildOutcome(id);

  return { ref, commercial, logistics, financials, labor, outcome };
}

/**
 * Enumerate the known events in a date window as `EventRef`s, soonest first, from REAL `bookings` rows
 * (never fabricated). Reuses `getPipelineBookingsInRange`, so the enumeration reflects that reader's
 * contract: dated bookings in [start,end], cancelled/lost EXCLUDED by its status filter. Pass
 * `includeArchived` to include completed/closed-won (archived) events as that reader defines it.
 *
 * Note (honest boundary): a cancelled/lost or undated event is not enumerated here, but `getEvent(id)`
 * / `getEventRef(id)` still resolve it by id (they use the unfiltered `getBookingById`). listEventRefs
 * is the window enumeration of the live/won pipeline, not an all-statuses scan.
 */
export function listEventRefs(opts: { window: { start: string; end: string }; includeArchived?: boolean }): EventRef[] {
  const { start, end } = opts.window;
  const bookings = getPipelineBookingsInRange(start, end, { includeArchived: opts.includeArchived });
  const refs: EventRef[] = [];
  for (const b of bookings) {
    const id = canonicalEventId(b.bookingId);
    if (id === null) continue;
    const stub = getEventStub(id);
    const logistics = buildLogistics(id, stub?.routeId);
    refs.push(buildRef(id, b, stub, logistics));
  }
  return refs;
}

export { resolveExistingId };
