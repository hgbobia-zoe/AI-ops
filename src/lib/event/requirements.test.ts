// generateRequirements tests — PURE, fixture EventViews + resolved facts. Verifies DATA-BACKED ONLY:
// only attributes present produce requirements, every one cites a source + owner, statuses are computed
// from the facts, and no unbacked operational check (COI/permits/etc.) is ever emitted.

import { describe, it, expect } from "vitest";
import type { EventId } from "./id";
import type { CommercialSlice, EventView, LogisticsSlice, LogisticsStop, Requirement } from "./types";
import { UNVERIFIED } from "./types";
import { generateRequirements, isReadyGateSatisfied, type RequirementFacts, type StaffingFact } from "./requirements";
import type { WeatherResult } from "@/lib/weather/types";

const ID = "62232" as EventId;

function commercial(over: Partial<CommercialSlice> = {}): CommercialSlice {
  return {
    present: true,
    statusLabel: "Signed",
    signed: true,
    grandTotal: 5000,
    contractTotal: 5000,
    amountPaid: 2500,
    amountDue: 2500,
    quoteSentAt: null,
    quoteOpenedAt: null,
    dateCreated: null,
    lossReason: null,
    archived: false,
    lineItems: null,
    ...over,
  };
}

function stop(items: { name: string; quantity?: number }[] | null, over: Partial<LogisticsStop> = {}): LogisticsStop {
  return {
    stopId: "S-1",
    routeId: "R-1",
    truckId: "T-1",
    sequence: 1,
    kind: "delivery",
    state: "Waiting",
    plannedWindow: "2026-07-04T14:00:00Z",
    eta: null,
    arrivedAt: null,
    completedAt: null,
    items,
    ...over,
  };
}

function logistics(stops: LogisticsStop[], over: Partial<LogisticsSlice> = {}): LogisticsSlice {
  return {
    present: stops.length > 0,
    routeId: stops.length > 0 ? "R-1" : null,
    stops,
    primaryRouteOnly: true,
    earliestWindow: stops.find((s) => s.plannedWindow)?.plannedWindow ?? null,
    ...over,
  };
}

function view(parts: { commercial?: Partial<CommercialSlice>; logistics?: LogisticsSlice; date?: string | null }): EventView {
  return {
    ref: { id: ID, displayName: "Test", date: parts.date === undefined ? "2026-07-04" : parts.date, dateSource: "booking", customer: "Jane", contactId: null, venue: "The Barn" },
    commercial: commercial(parts.commercial),
    logistics: parts.logistics ?? logistics([stop([{ name: "Chairs", quantity: 100 }])]),
    financials: { present: false, revenue: null, revenueStatus: UNVERIFIED },
    labor: { present: false, totalCost: null, entryCount: 0 },
    outcome: { present: false, routeId: null, totalStops: null, completedStops: null, allCompleted: null, closedAt: null },
  };
}

const staffing = (over: Partial<StaffingFact> = {}): StaffingFact => ({
  verified: true,
  requiredCrew: 1,
  assignedCrew: 1,
  hasTent: false,
  tentReasons: [],
  driverAssigned: true,
  ...over,
});

function byId(reqs: Requirement[], id: string): Requirement | undefined {
  return reqs.find((r) => r.id === id);
}

describe("generateRequirements — data-backed catalog", () => {
  it("every requirement cites a real source + owner and a resolution", () => {
    const reqs = generateRequirements(view({}), { staffing: staffing(), weather: { status: "BEYOND_HORIZON" } });
    for (const r of reqs) {
      expect(r.source).toBeTruthy();
      expect(r.owner).toBeTruthy();
      expect(r.resolution).toBeTruthy();
    }
  });

  it("NEVER emits unbacked operational checks (COI / permits / venue access / final call / surface)", () => {
    const ids = generateRequirements(view({}), { staffing: staffing() }).map((r) => r.id);
    for (const forbidden of ["coi", "insurance", "permit", "venue_access", "final_confirmation", "surface", "staking", "inventory_overbooking"]) {
      expect(ids.some((id) => id.includes(forbidden))).toBe(false);
    }
  });

  it("contract signed: OK when signed, BLOCKED (blocking) when not", () => {
    expect(byId(generateRequirements(view({ commercial: { signed: true } }), {}), "contract_signed")?.status).toBe("OK");
    const unsigned = byId(generateRequirements(view({ commercial: { signed: false } }), {}), "contract_signed");
    expect(unsigned?.status).toBe("BLOCKED");
    expect(unsigned?.blocking).toBe(true);
  });

  it("payment: OK when something paid, WARNING (non-blocking) when nothing paid and a balance is due", () => {
    expect(byId(generateRequirements(view({ commercial: { amountPaid: 1000, amountDue: 4000 } }), {}), "payment_deposit")?.status).toBe("OK");
    const unpaid = byId(generateRequirements(view({ commercial: { amountPaid: 0, amountDue: 5000 } }), {}), "payment_deposit");
    expect(unpaid?.status).toBe("WARNING");
    expect(unpaid?.blocking).toBe(false);
  });

  it("route_exists BLOCKED when there is no route", () => {
    const reqs = generateRequirements(view({ logistics: logistics([]) }), {});
    const route = byId(reqs, "route_exists");
    expect(route?.status).toBe("BLOCKED");
    // No logistics-dependent requirements when there's no route.
    expect(byId(reqs, "delivery_window")).toBeUndefined();
    expect(byId(reqs, "driver_assigned")).toBeUndefined();
  });

  it("delivery_window WARNING (blocking) when no window is set", () => {
    const noWin = logistics([stop([{ name: "Chairs" }], { plannedWindow: null })], { earliestWindow: null });
    const r = byId(generateRequirements(view({ logistics: noWin }), { staffing: staffing() }), "delivery_window");
    expect(r?.status).toBe("WARNING");
    expect(r?.blocking).toBe(true);
  });

  it("crew: OK when staffed, BLOCKED when short, UNVERIFIED (non-blocking in gate) when unresolved", () => {
    expect(byId(generateRequirements(view({}), { staffing: staffing({ requiredCrew: 2, assignedCrew: 2 }) }), "crew_sufficient")?.status).toBe("OK");
    expect(byId(generateRequirements(view({}), { staffing: staffing({ requiredCrew: 3, assignedCrew: 1 }) }), "crew_sufficient")?.status).toBe("BLOCKED");
    expect(byId(generateRequirements(view({}), { staffing: staffing({ verified: false }) }), "crew_sufficient")?.status).toBe("UNVERIFIED");
    // No staffing fact at all -> still an honest UNVERIFIED crew requirement (route present).
    expect(byId(generateRequirements(view({}), {}), "crew_sufficient")?.status).toBe("UNVERIFIED");
  });

  it("driver_assigned WARNING (non-blocking) when unassigned", () => {
    const r = byId(generateRequirements(view({}), { staffing: staffing({ driverAssigned: false }) }), "driver_assigned");
    expect(r?.status).toBe("WARNING");
    expect(r?.blocking).toBe(false);
  });

  it("tent_crew ONLY when the event has a tent (attribute-gated)", () => {
    expect(byId(generateRequirements(view({}), { staffing: staffing({ hasTent: false }) }), "tent_crew")).toBeUndefined();
    const withTent = byId(
      generateRequirements(view({}), { staffing: staffing({ hasTent: true, requiredCrew: 2, assignedCrew: 2, tentReasons: ["tent → 2 crew"] }) }),
      "tent_crew",
    );
    expect(withTent?.status).toBe("OK");
    expect(withTent?.blocking).toBe(true);
  });

  it("weather: OK benign, WARNING on risk, UNVERIFIED (non-blocking) beyond horizon / unavailable", () => {
    const benign: WeatherResult = { status: "OK", forecast: { dateISO: "2026-07-04", lat: 0, lon: 0, precipitationProbabilityMax: 5, precipitationSum: 0, temperatureMax: 75, temperatureMin: 60, windspeedMax: 5, weathercode: 0 } };
    const stormy: WeatherResult = { status: "OK", forecast: { dateISO: "2026-07-04", lat: 0, lon: 0, precipitationProbabilityMax: 90, precipitationSum: 1, temperatureMax: 75, temperatureMin: 60, windspeedMax: 35, weathercode: 95 } };
    expect(byId(generateRequirements(view({}), { weather: benign }), "weather_reviewed")?.status).toBe("OK");
    expect(byId(generateRequirements(view({}), { weather: stormy }), "weather_reviewed")?.status).toBe("WARNING");
    const unv = byId(generateRequirements(view({}), { weather: { status: "BEYOND_HORIZON" } }), "weather_reviewed");
    expect(unv?.status).toBe("UNVERIFIED");
    expect(unv?.blocking).toBe(false);
    // No weather fact -> UNVERIFIED (still emitted because the event has a date).
    expect(byId(generateRequirements(view({}), {}), "weather_reviewed")?.status).toBe("UNVERIFIED");
    // No date -> no weather requirement at all.
    expect(byId(generateRequirements(view({ date: null }), {}), "weather_reviewed")).toBeUndefined();
  });

  it("inventory concurrency: WARNING when shared with other events, else OK (never over-booking)", () => {
    const facts: RequirementFacts = { inventory: { items: [{ name: "40x60 Tent", peakQty: 3, peakDate: "2026-07-04", sharedWithOtherEvents: true }] } };
    const r = byId(generateRequirements(view({}), facts), "inventory_concurrency");
    expect(r?.status).toBe("WARNING");
    expect(r?.blocking).toBe(false);
    expect(r?.resolution).toMatch(/UNVERIFIED/); // honest: owned capacity unverified
  });
});

describe("isReadyGateSatisfied", () => {
  const mk = (over: Partial<Requirement> & Pick<Requirement, "id" | "blocking" | "status">): Requirement => ({
    label: over.id, source: "s", owner: "o", deadline: null, resolution: "", ...over,
  });

  it("true only when all blocking requirements are OK (or UNVERIFIED)", () => {
    expect(isReadyGateSatisfied([mk({ id: "a", blocking: true, status: "OK" }), mk({ id: "b", blocking: false, status: "WARNING" })])).toBe(true);
    expect(isReadyGateSatisfied([mk({ id: "a", blocking: true, status: "OK" }), mk({ id: "c", blocking: true, status: "UNVERIFIED" })])).toBe(true);
  });

  it("false when a blocking requirement is BLOCKED or WARNING", () => {
    expect(isReadyGateSatisfied([mk({ id: "a", blocking: true, status: "BLOCKED" })])).toBe(false);
    expect(isReadyGateSatisfied([mk({ id: "a", blocking: true, status: "WARNING" })])).toBe(false);
  });

  it("false for an empty / no-blocking set (never 'ready' with nothing to satisfy)", () => {
    expect(isReadyGateSatisfied([])).toBe(false);
    expect(isReadyGateSatisfied([mk({ id: "a", blocking: false, status: "OK" })])).toBe(false);
  });
});
