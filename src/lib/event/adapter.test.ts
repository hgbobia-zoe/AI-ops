// Event adapter reconstruction test. DATABASE_PATH is ":memory:" (vitest.config.ts) and vitest.setup.ts
// clears every table per file, so this seeds a throwaway DB via the REAL save functions, then asserts
// the read-only adapter reconstructs the canonical Event by joining what already exists — on the one
// GS project/transaction id, under all three of its column aliases.

import { describe, it, expect, beforeAll } from "vitest";
import { saveBookings, writeRoute, saveEventRevenue, saveCostEntries } from "@/lib/db/repo";
import { recordEventOutcome } from "@/lib/history/store";
import type { Route } from "@/lib/types";
import { getEvent, getEventRef, listEventRefs } from "./adapter";

// A full event: booking + routed stops + financials + labor + outcome, all keyed by GS id "62232".
const FULL = "62232";
// A logistics-only event: routed stops but no booking row.
const LOGI_ONLY = "77";
// A commercial-only event: a booking row but no route yet.
const BOOKING_ONLY = "88";

function routeFor(): Route {
  return {
    routeId: "R-62232",
    truckId: "T-1",
    date: "2026-07-04",
    status: "ready",
    gsRouteId: "GS-500",
    stops: [
      {
        stopId: "S-1",
        routeId: "R-62232",
        customerId: "CUST-1",
        sequence: 1,
        state: "Completed",
        custName: "Jane Smith",
        kind: "delivery",
        custPhone: "3015550100",
        address: "10 River Rd",
        plannedWindow: "2026-07-04T09:00:00.000Z",
        completedAt: "2026-07-04T09:30:00.000Z",
        items: [{ name: "40x60 Tent", quantity: 1 }],
        txId: "62232",
        contactId: "C-909",
      },
      {
        stopId: "S-2",
        routeId: "R-62232",
        customerId: "CUST-1",
        sequence: 2,
        state: "Completed",
        custName: "Jane Smith",
        kind: "pickup",
        custPhone: "3015550100",
        address: "10 River Rd",
        plannedWindow: "2026-07-05T08:00:00.000Z",
        txId: "62232",
        contactId: "C-909",
      },
    ],
  };
}

beforeAll(() => {
  saveBookings([
    {
      bookingId: FULL,
      eventName: "Smith Wedding",
      eventDate: "2026-07-04",
      statusLabel: "Signed",
      signed: true,
      grandTotal: 5000,
      contractTotal: 4800,
      amountPaid: 2500,
      amountDue: 2500,
      clientName: "Jane Smith",
      venue: "River Run Estate",
      archived: false,
    },
    {
      bookingId: BOOKING_ONLY,
      eventName: "Planning Only Gala",
      eventDate: "2026-08-01",
      statusLabel: "Quote",
      signed: false,
      grandTotal: 3000,
      clientName: "No Route Yet",
    },
  ]);

  writeRoute(routeFor());

  // A logistics-only event (routed stops, no booking).
  writeRoute({
    routeId: "R-77",
    truckId: "T-2",
    date: "2026-09-10",
    status: "ready",
    stops: [
      {
        stopId: "S-77",
        routeId: "R-77",
        customerId: "CUST-77",
        sequence: 1,
        state: "Waiting",
        custName: "Walkup Client",
        kind: "delivery",
        custPhone: "3015550177",
        address: "77 Market St",
        plannedWindow: "2026-09-10T10:00:00.000Z",
        txId: LOGI_ONLY,
        contactId: "C-77",
      },
    ],
  });

  saveEventRevenue([
    { eventId: FULL, date: "2026-07-04", label: "Smith Wedding", revenue: 5000, revenueStatus: "SIGNED", collected: null },
  ]);

  saveCostEntries([
    {
      type: "labor",
      class: "DIRECT",
      eventId: FULL,
      day: "2026-07-04",
      amount: 320,
      amountStatus: "ACTUAL",
      hours: 8,
      rate: 40,
      source: "derived",
      sourceRef: "test:62232:labor",
    },
  ]);

  recordEventOutcome({ eventId: FULL, routeId: "R-62232", date: "2026-07-04", totalStops: 2, completedStops: 2 });
});

describe("adapter.getEvent — full reconstruction", () => {
  it("joins every existing source onto one canonical Event", () => {
    const ev = getEvent(FULL)!;
    expect(ev).not.toBeNull();

    // Ref: authoritative booking date, display, customer, secondary contact key, venue.
    expect(ev.ref.id).toBe("62232");
    expect(ev.ref.date).toBe("2026-07-04");
    expect(ev.ref.dateSource).toBe("booking");
    expect(ev.ref.displayName).toBe("Smith Wedding");
    expect(ev.ref.customer).toBe("Jane Smith");
    expect(ev.ref.contactId).toBe("C-909");
    expect(ev.ref.venue).toBe("River Run Estate");

    // Commercial slice (bookings).
    expect(ev.commercial.present).toBe(true);
    expect(ev.commercial.signed).toBe(true);
    expect(ev.commercial.grandTotal).toBe(5000);
    expect(ev.commercial.amountDue).toBe(2500);

    // Logistics slice (primary route's stops that match the tx).
    expect(ev.logistics.present).toBe(true);
    expect(ev.logistics.routeId).toBe("R-62232");
    expect(ev.logistics.stops).toHaveLength(2);
    expect(ev.logistics.primaryRouteOnly).toBe(true);
    expect(ev.logistics.earliestWindow).toBe("2026-07-04T09:00:00.000Z");

    // Financials slice (event_financials).
    expect(ev.financials.present).toBe(true);
    expect(ev.financials.revenue).toBe(5000);
    expect(ev.financials.revenueStatus).toBe("SIGNED");

    // Labor slice (cost_entries).
    expect(ev.labor.present).toBe(true);
    expect(ev.labor.totalCost).toBe(320);
    expect(ev.labor.entryCount).toBe(1);

    // Outcome slice (event_outcomes).
    expect(ev.outcome.present).toBe(true);
    expect(ev.outcome.allCompleted).toBe(true);
    expect(ev.outcome.completedStops).toBe(2);
  });

  it("resolves the SAME event across all three id aliases (number, zero-padded, +prefixed)", () => {
    const byString = getEvent("62232")!;
    const byNumber = getEvent(62232)!;
    const byPadded = getEvent("062232")!;
    expect(byNumber.ref.id).toBe(byString.ref.id);
    expect(byPadded.ref.id).toBe(byString.ref.id);
    expect(byNumber.commercial.grandTotal).toBe(5000);
  });
});

describe("adapter — honest presence flags (no fabrication)", () => {
  it("a logistics-only event has no commercial/financials, date falls back to logistics", () => {
    const ev = getEvent(LOGI_ONLY)!;
    expect(ev).not.toBeNull();
    expect(ev.commercial.present).toBe(false);
    expect(ev.commercial.grandTotal).toBeNull();
    expect(ev.logistics.present).toBe(true);
    expect(ev.ref.date).toBe("2026-09-10");
    expect(ev.ref.dateSource).toBe("logistics");
    expect(ev.financials.present).toBe(false);
    expect(ev.financials.revenueStatus).toBe("UNVERIFIED");
    expect(ev.labor.present).toBe(false);
    expect(ev.labor.totalCost).toBeNull();
    expect(ev.outcome.present).toBe(false);
  });

  it("a booking-only event has no logistics/financials/outcome yet", () => {
    const ev = getEvent(BOOKING_ONLY)!;
    expect(ev.commercial.present).toBe(true);
    expect(ev.ref.dateSource).toBe("booking");
    expect(ev.logistics.present).toBe(false);
    expect(ev.logistics.stops).toHaveLength(0);
    expect(ev.financials.present).toBe(false);
    expect(ev.outcome.present).toBe(false);
  });

  it("an unknown id resolves to null (an Event is never fabricated)", () => {
    expect(getEvent("does-not-exist")).toBeNull();
    expect(getEvent(999999)).toBeNull();
    expect(getEventRef("")).toBeNull();
  });
});

describe("adapter.getEventRef + listEventRefs", () => {
  it("getEventRef returns the light identity for a real id", () => {
    const ref = getEventRef(62232)!;
    expect(ref.id).toBe("62232");
    expect(ref.displayName).toBe("Smith Wedding");
    expect(ref.contactId).toBe("C-909");
  });

  it("listEventRefs enumerates real bookings in the window (live/won pipeline), soonest first", () => {
    const refs = listEventRefs({ window: { start: "2026-01-01", end: "2026-12-31" } });
    const ids = refs.map((r) => r.id);
    expect(ids).toContain("62232");
    expect(ids).toContain("88");
    // Dated soonest-first (getPipelineBookingsInRange orders by event_date).
    expect(ids.indexOf("62232")).toBeLessThan(ids.indexOf("88"));
  });

  it("listEventRefs does not fabricate events outside the window", () => {
    const refs = listEventRefs({ window: { start: "2027-01-01", end: "2027-12-31" } });
    expect(refs).toHaveLength(0);
  });
});
