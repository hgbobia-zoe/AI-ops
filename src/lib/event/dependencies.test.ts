// Event dependency-model tests — PURE, fixture EventViews + resolved P3 requirement sets. Verifies the
// per-transition precondition gates, the honest UNVERIFIED handling (not satisfied, not a hard blocker),
// that the →READY gate deps match P3's blocking-requirement gate, and that canAdvance reports the next
// forward step's missing gates without performing a transition.

import { describe, it, expect } from "vitest";
import type { EventId } from "./id";
import type { CommercialSlice, EventView, LogisticsSlice, LogisticsStop, OutcomeSlice, Requirement, RequirementStatus } from "./types";
import { UNVERIFIED } from "./types";
import {
  DEPENDENCIES,
  canAdvance,
  dependencyKey,
  resolveDependencies,
  unmetDependencies,
} from "./dependencies";

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
    quoteSentAt: "2026-05-01T00:00:00Z",
    quoteOpenedAt: null,
    dateCreated: null,
    lossReason: null,
    archived: false,
    lineItems: null,
    ...over,
  };
}

function stop(over: Partial<LogisticsStop> = {}): LogisticsStop {
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
    items: [{ name: "Chairs", quantity: 100 }],
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

function outcome(over: Partial<OutcomeSlice> = {}): OutcomeSlice {
  return { present: false, routeId: null, totalStops: null, completedStops: null, allCompleted: null, closedAt: null, ...over };
}

function view(parts: { commercial?: Partial<CommercialSlice>; logistics?: LogisticsSlice; outcome?: OutcomeSlice; date?: string | null } = {}): EventView {
  return {
    ref: { id: ID, displayName: "Test", date: parts.date === undefined ? "2026-07-04" : parts.date, dateSource: "booking", customer: "Jane", contactId: null, venue: "The Barn" },
    commercial: commercial(parts.commercial),
    logistics: parts.logistics ?? logistics([stop()]),
    financials: { present: false, revenue: null, revenueStatus: UNVERIFIED },
    labor: { present: false, totalCost: null, entryCount: 0 },
    outcome: parts.outcome ?? outcome(),
  };
}

// A minimal requirement builder.
function req(id: string, status: RequirementStatus, blocking: boolean, over: Partial<Requirement> = {}): Requirement {
  return { id, label: id, status, source: "s", owner: "o", deadline: null, blocking, resolution: `${id}:${status}`, ...over };
}

function depById(deps: { id: string }[], id: string) {
  return deps.find((d) => d.id === id);
}

describe("DEPENDENCIES table", () => {
  it("is keyed by the three gated forward transitions", () => {
    expect(Object.keys(DEPENDENCIES).sort()).toEqual(["→CLOSED", "→DISPATCHED", "→READY"]);
    expect(dependencyKey("DISPATCHED")).toBe("→DISPATCHED");
    expect(dependencyKey("READY")).toBe("→READY");
    expect(dependencyKey("CLOSED")).toBe("→CLOSED");
    // Ungated forward steps have no key.
    expect(dependencyKey("PLANNING")).toBeNull();
    expect(dependencyKey("SETUP")).toBeNull();
  });
});

describe("→DISPATCHED dependencies", () => {
  const reqs = (over: { route?: RequirementStatus; driver?: RequirementStatus } = {}) => [
    req("route_exists", over.route ?? "OK", true),
    req("driver_assigned", over.driver ?? "OK", false),
  ];

  it("all met ⇒ no blocking unmet dependencies (except the UNVERIFIED owned-inventory, which never blocks)", () => {
    const resolved = resolveDependencies("DISPATCHED", view(), { requirements: reqs() });
    // route + truck + driver satisfied, owned-inventory unverified
    expect(depById(resolved, "route_planned")?.status).toBe("SATISFIED");
    expect(depById(resolved, "truck_assigned")?.status).toBe("SATISFIED");
    expect(depById(resolved, "driver_assigned")?.status).toBe("SATISFIED");
    expect(depById(resolved, "inventory_confirmed")?.status).toBe("UNVERIFIED");

    const unmet = unmetDependencies("DISPATCHED", view(), { requirements: reqs() });
    expect(unmet).toEqual([]); // UNVERIFIED owned-inventory is surfaced, not a blocker
  });

  it("missing driver blocks →DISPATCHED (driver requirement WARNING ⇒ UNMET)", () => {
    const unmet = unmetDependencies("DISPATCHED", view(), { requirements: reqs({ driver: "WARNING" }) });
    expect(unmet.map((d) => d.id)).toContain("driver_assigned");
    expect(depById(unmet, "driver_assigned")?.status).toBe("UNMET");
  });

  it("missing truck blocks →DISPATCHED (EventView fact)", () => {
    const noTruck = logistics([stop({ truckId: "" })]);
    const unmet = unmetDependencies("DISPATCHED", view({ logistics: noTruck }), { requirements: reqs() });
    expect(unmet.map((d) => d.id)).toContain("truck_assigned");
  });

  it("owned-inventory confirmation is ALWAYS UNVERIFIED — never satisfied, never a blocker", () => {
    const resolved = resolveDependencies("DISPATCHED", view(), { requirements: reqs() });
    const inv = depById(resolved, "inventory_confirmed");
    expect(inv?.status).toBe("UNVERIFIED");
    expect(inv?.blocking).toBe(true); // intent is blocking…
    expect(unmetDependencies("DISPATCHED", view(), { requirements: reqs() }).map((d) => d.id)).not.toContain("inventory_confirmed"); // …but unknown ≠ deficiency
  });

  it("a requirement not generated for the event resolves to UNVERIFIED (never asserted)", () => {
    const resolved = resolveDependencies("DISPATCHED", view(), { requirements: [req("route_exists", "OK", true)] });
    expect(depById(resolved, "driver_assigned")?.status).toBe("UNVERIFIED");
    expect(unmetDependencies("DISPATCHED", view(), { requirements: [req("route_exists", "OK", true)] }).map((d) => d.id)).not.toContain("driver_assigned");
  });
});

describe("→READY gate deps match P3's blocking-requirement gate", () => {
  it("expands into one dependency per BLOCKING requirement; OK/UNVERIFIED pass, BLOCKED/WARNING are unmet", () => {
    const requirements = [
      req("contract_signed", "OK", true),
      req("route_exists", "OK", true),
      req("crew_sufficient", "UNVERIFIED", true), // unknown — surfaced, not a blocker
      req("delivery_window", "BLOCKED", true), // hard deficiency
      req("payment_deposit", "WARNING", false), // non-blocking — not part of the gate
    ];
    const resolved = resolveDependencies("READY", view(), { requirements });
    // one dep per BLOCKING requirement (payment_deposit is non-blocking ⇒ excluded)
    expect(resolved.map((d) => d.id).sort()).toEqual(["ready:contract_signed", "ready:crew_sufficient", "ready:delivery_window", "ready:route_exists"]);
    expect(depById(resolved, "ready:crew_sufficient")?.status).toBe("UNVERIFIED");

    const unmet = unmetDependencies("READY", view(), { requirements });
    // only the BLOCKED blocking requirement is a blocker; UNVERIFIED is not
    expect(unmet.map((d) => d.id)).toEqual(["ready:delivery_window"]);
  });

  it("matches isReadyGateSatisfied: all blocking OK/UNVERIFIED ⇒ zero unmet", () => {
    const requirements = [req("contract_signed", "OK", true), req("crew_sufficient", "UNVERIFIED", true)];
    expect(unmetDependencies("READY", view(), { requirements })).toEqual([]);
  });

  it("an empty / no-blocking requirement set yields a single UNMET gate (never ready with nothing to satisfy)", () => {
    expect(unmetDependencies("READY", view(), { requirements: [] }).map((d) => d.id)).toEqual(["ready_gate"]);
    expect(unmetDependencies("READY", view(), { requirements: [req("x", "OK", false)] }).map((d) => d.id)).toEqual(["ready_gate"]);
  });
});

describe("→CLOSED dependencies — honest UNVERIFIED reconciliation", () => {
  it("equipment reconciliation is UNVERIFIED (no owned master) and never auto-satisfied, nor a blocker", () => {
    const resolved = resolveDependencies("CLOSED", view(), {});
    const rec = depById(resolved, "equipment_reconciled");
    expect(rec?.status).toBe("UNVERIFIED");
    expect(unmetDependencies("CLOSED", view(), {}).map((d) => d.id)).not.toContain("equipment_reconciled");
  });

  it("issues recorded is UNVERIFIED (no capture source) and non-blocking", () => {
    const resolved = resolveDependencies("CLOSED", view(), {});
    expect(depById(resolved, "issues_recorded")?.status).toBe("UNVERIFIED");
    expect(depById(resolved, "issues_recorded")?.blocking).toBe(false);
  });

  it("pickup + financial closeout are data-backed", () => {
    // route closed, all completed, paid in full ⇒ both satisfied
    const closed = view({
      commercial: { amountDue: 0, amountPaid: 5000 },
      outcome: outcome({ present: true, allCompleted: true, closedAt: "2026-07-05T00:00:00Z" }),
    });
    const resolved = resolveDependencies("CLOSED", closed, {});
    expect(depById(resolved, "pickup_completed")?.status).toBe("SATISFIED");
    expect(depById(resolved, "financial_closeout")?.status).toBe("SATISFIED");
    expect(unmetDependencies("CLOSED", closed, {})).toEqual([]);

    // unpaid balance + pickup stop not done ⇒ both unmet
    const open = view({
      commercial: { amountDue: 1000, amountPaid: 4000 },
      logistics: logistics([stop({ kind: "pickup", state: "Waiting" })]),
    });
    const unmet = unmetDependencies("CLOSED", open, {}).map((d) => d.id);
    expect(unmet).toContain("pickup_completed");
    expect(unmet).toContain("financial_closeout");
  });
});

describe("canAdvance — reports the next forward step's gate without transitioning", () => {
  it("a booked event with no route advances →PLANNING, an ungated step (no blockers)", () => {
    const booked = view({ logistics: logistics([]) });
    const res = canAdvance(booked, { requirements: [] });
    expect(res.nextState).toBe("PLANNING");
    expect(res.blockedBy).toEqual([]); // PLANNING carries no dependency gate
  });

  it("a booked, routed event missing a blocking requirement is blocked at →READY", () => {
    const requirements = [req("contract_signed", "OK", true), req("route_exists", "OK", true), req("crew_sufficient", "BLOCKED", true)];
    const res = canAdvance(view(), { requirements });
    expect(res.nextState).toBe("READY");
    expect(res.blockedBy.map((d) => d.id)).toEqual(["ready:crew_sufficient"]);
  });

  it("a READY event's next step is →DISPATCHED and surfaces its gate (e.g. missing driver)", () => {
    // Make the event derive to READY: all blocking requirements OK.
    const readyReqs = [req("contract_signed", "OK", true), req("route_exists", "OK", true), req("crew_sufficient", "OK", true)];
    const res = canAdvance(view(), {
      // pass BOTH the READY gate reqs (so current state = READY) and the dispatch-relevant ones
      requirements: [...readyReqs, req("driver_assigned", "WARNING", false)],
    });
    expect(res.nextState).toBe("DISPATCHED");
    expect(res.blockedBy.map((d) => d.id)).toContain("driver_assigned");
  });

  it("a terminal event cannot advance", () => {
    const lost = view({ commercial: { signed: false, statusLabel: "Lost", quoteSentAt: "2026-05-01T00:00:00Z" } });
    const res = canAdvance(lost, {});
    expect(res.nextState).toBeNull();
    expect(res.blockedBy).toEqual([]);
  });
});
