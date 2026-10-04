// Event-level labor allocation — turns the ONE direct cost we actually have data for (driver labor)
// into per-event cost entries. Pure + tested. Deterministic (RULES CALCULATE):
//   driver's day cost = shift hours × pay rate → split evenly across the driver's routes → split
//   across each route's events by that event's share of the route's stops.
// When a rate or shift is missing, the entry is written UNAVAILABLE (never 0) so an event with
// expected-but-unknown labor reads as UNAVAILABLE contribution, not fake profit.

export type CostType = "labor" | "vehicle" | "fuel" | "subcontractor" | "sub_rental" | "consumables" | "event_expense" | "other";
export type CostClass = "DIRECT" | "OVERHEAD";
export type AmountStatus = "ACTUAL" | "ESTIMATED" | "UNAVAILABLE";

// Labor-attribution taxonomy (FI-Phase 1). A labor leaf declares WHICH bucket it is and HOW it was
// attributed — so an estimate is never shown as an actual, and non-customer labor never lands on a project.
/** Which cost pool a labor leaf belongs to. Only `customer` attaches to a project (event_id). */
export type CostBucket = "customer" | "travel" | "warehouse" | "prep" | "unallocated";
/** The attribution LEVEL for a customer leaf (§4): the real stop-level methods degrade to PLANNED today. */
export type AttribMethod = "ACTUAL_STOP" | "DERIVED_STOP" | "PLANNED" | "ESTIMATED" | "UNALLOCATED";
export type AttribConfidence = "HIGH" | "MEDIUM" | "LOW";
/** Which labor pool funded the leaf. `other` = unknown source kept honest, excluded from internal/temp. */
export type LaborWorkerKind = "internal" | "instawork" | "other";

export interface CostEntryInput {
  type: CostType;
  class: CostClass;
  eventId?: string;
  routeId?: string;
  day?: string;
  amount: number | null;
  amountStatus: AmountStatus;
  hours?: number | null;
  rate?: number | null;
  source: string;
  sourceRef: string;
  note?: string;
  // ── Labor-attribution fields (all nullable; legacy/non-labor rows leave them undefined) ──
  /** 'internal' | 'instawork' | 'other' — the labor pool. */
  workerKind?: LaborWorkerKind;
  /** Connecteam userId or Instawork worker/gig label — a LINK for lineage, not a new system of record. */
  workerRef?: string;
  /** staff_shifts.id / shift_assignments.id / gig id when available — lineage to the shift. */
  shiftId?: string;
  /** customer | travel | warehouse | prep | unallocated. */
  bucket?: CostBucket;
  /** The attribution method (how the customer split was derived). */
  method?: AttribMethod;
  /** HIGH | MEDIUM | LOW — confidence in the attribution (NOT in the dollars; that is amount_status). */
  confidence?: AttribConfidence;
}

export interface AllocStop {
  txId?: string;
}
export interface AllocRoute {
  routeId: string;
  date: string;
  driverId?: string;
  driverName?: string;
  stops: AllocStop[];
}
export interface AllocShift {
  userId: string;
  startUnix: number;
  endUnix: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function allocateDriverLabor(routes: AllocRoute[], shifts: AllocShift[], rateFor: (userId: string) => number | null, date: string): CostEntryInput[] {
  const out: CostEntryInput[] = [];

  // Group the day's routes by their assigned driver.
  const byDriver = new Map<string, AllocRoute[]>();
  for (const r of routes) if (r.driverId) byDriver.set(r.driverId, [...(byDriver.get(r.driverId) ?? []), r]);

  for (const [driverId, drRoutes] of byDriver) {
    const rate = rateFor(driverId);
    const shiftHours = shifts
      .filter((s) => String(s.userId) === String(driverId))
      .reduce((h, s) => h + Math.max(0, s.endUnix - s.startUnix) / 3600, 0);
    const perRouteHours = drRoutes.length > 0 ? shiftHours / drRoutes.length : 0;
    const available = rate != null && shiftHours > 0;

    for (const r of drRoutes) {
      const txStops = r.stops.filter((s) => s.txId);
      const eventStops = new Map<string, number>();
      for (const s of txStops) eventStops.set(s.txId!, (eventStops.get(s.txId!) ?? 0) + 1);
      const totalTx = txStops.length;
      if (totalTx === 0) continue; // no identified events on this route → nothing to allocate to

      for (const [eventId, cnt] of eventStops) {
        const eventHours = perRouteHours * (cnt / totalTx);
        out.push({
          type: "labor",
          class: "DIRECT",
          eventId,
          routeId: r.routeId,
          day: date,
          amount: available ? round2(eventHours * (rate as number)) : null,
          amountStatus: available ? "ACTUAL" : "UNAVAILABLE",
          hours: round2(eventHours),
          rate: rate ?? null,
          source: "connecteam",
          sourceRef: `driver-labor:${r.routeId}:${eventId}`,
          note: r.driverName ? `driver ${r.driverName}` : undefined,
        });
      }
    }
  }
  return out;
}
