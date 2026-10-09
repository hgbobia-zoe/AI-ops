// deriveLifecycle tests — construct EventView fixtures (pure; no DB needed since deriveLifecycle takes the
// typed read-model directly) and assert the state is derived deterministically from FACTS, FACT wins, and
// the derived state is always one the machine recognizes (never fabricated).

import { describe, it, expect } from "vitest";
import type { EventId } from "./id";
import type {
  CommercialSlice,
  EventView,
  LogisticsSlice,
  LogisticsStop,
  OutcomeSlice,
} from "./types";
import { UNVERIFIED } from "./types";
import { deriveLifecycle, type LifecycleFacts } from "./lifecycle";
import { isLifecycleState } from "./machine";
import type { Requirement } from "./types";
import type { StopState } from "@/lib/types";

/** A minimal requirement factory for the READY-gate tests. */
function req(over: Partial<Requirement> & Pick<Requirement, "id" | "blocking" | "status">): Requirement {
  return {
    label: over.id,
    source: "test",
    owner: "test",
    deadline: null,
    resolution: "",
    ...over,
  };
}

const ID = "62232" as EventId;

function commercial(over: Partial<CommercialSlice> = {}): CommercialSlice {
  return {
    present: true,
    statusLabel: null,
    signed: false,
    grandTotal: null,
    contractTotal: null,
    amountPaid: null,
    amountDue: null,
    quoteSentAt: null,
    quoteOpenedAt: null,
    dateCreated: null,
    lossReason: null,
    archived: false,
    lineItems: null,
    ...over,
  };
}

function stop(kind: "delivery" | "pickup" | null, state: StopState, sequence: number): LogisticsStop {
  return {
    stopId: `S-${sequence}`,
    routeId: "R-1",
    truckId: "T-1",
    sequence,
    kind,
    state,
    plannedWindow: null,
    eta: null,
    arrivedAt: null,
    completedAt: null,
    items: null,
  };
}

function logistics(stops: LogisticsStop[]): LogisticsSlice {
  return {
    present: stops.length > 0,
    routeId: stops.length > 0 ? "R-1" : null,
    stops,
    primaryRouteOnly: true,
    earliestWindow: null,
  };
}

function outcome(over: Partial<OutcomeSlice> = {}): OutcomeSlice {
  return {
    present: false,
    routeId: null,
    totalStops: null,
    completedStops: null,
    allCompleted: null,
    closedAt: null,
    ...over,
  };
}

function view(parts: {
  commercial?: Partial<CommercialSlice>;
  stops?: LogisticsStop[];
  outcome?: Partial<OutcomeSlice>;
}): EventView {
  return {
    ref: { id: ID, displayName: "Test Event", date: "2026-07-04", dateSource: "booking", customer: "Jane", contactId: null, venue: null },
    commercial: commercial(parts.commercial),
    logistics: logistics(parts.stops ?? []),
    financials: { present: false, revenue: null, revenueStatus: UNVERIFIED },
    labor: { present: false, totalCost: null, entryCount: 0 },
    outcome: outcome(parts.outcome),
  };
}

function derive(parts: Parameters<typeof view>[0], facts?: LifecycleFacts) {
  return deriveLifecycle(view(parts), facts);
}

describe("deriveLifecycle — commercial tier (reuses salesos deterministicState)", () => {
  it("no quote sent -> OPPORTUNITY", () => {
    const r = derive({ commercial: { signed: false, quoteSentAt: null, statusLabel: "Lead" } });
    expect(r.state).toBe("OPPORTUNITY");
    expect(r.reasons.join(" ")).toMatch(/OPPORTUNITY/);
  });

  it("quote sent, not signed -> QUOTED", () => {
    const r = derive({ commercial: { signed: false, quoteSentAt: "2026-05-01T00:00:00Z", statusLabel: "Quote" } });
    expect(r.state).toBe("QUOTED");
  });

  it("signed, no route -> BOOKED", () => {
    const r = derive({ commercial: { signed: true, statusLabel: "Signed" } });
    expect(r.state).toBe("BOOKED");
    expect(r.signals.commercial.signed).toBe(true);
  });
});

describe("deriveLifecycle — trip states (FACT wins over everything)", () => {
  it("unsigned + lost status -> LOST", () => {
    const r = derive({ commercial: { signed: false, statusLabel: "Lost" } });
    expect(r.state).toBe("LOST");
    expect(r.signals.commercial.lost).toBe(true);
  });

  it("signed + cancelled status -> CANCELLED, even with a completed route present", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Cancelled" },
      stops: [stop("delivery", "Completed", 1), stop("pickup", "Completed", 2)],
      outcome: { present: true, allCompleted: true, totalStops: 2, completedStops: 2 },
    });
    expect(r.state).toBe("CANCELLED");
    expect(r.signals.commercial.cancelled).toBe(true);
  });

  it("unsigned + explicit cancel -> CANCELLED (distinct from a lost quote)", () => {
    const r = derive({ commercial: { signed: false, statusLabel: "Cancelled by client" } });
    expect(r.state).toBe("CANCELLED");
  });
});

describe("deriveLifecycle — planning tier (booked, pre-dispatch; READY gated by P3)", () => {
  it("booked with a route but all stops Waiting and NO requirement set -> PLANNING (never fabricates READY)", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Signed" },
      stops: [stop("delivery", "Waiting", 1), stop("pickup", "Waiting", 2)],
    });
    expect(r.state).toBe("PLANNING");
    // READY must not be fabricated without a real requirement set.
    expect(r.state).not.toBe("READY");
    expect(r.signals.readiness.requirementsProvided).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/no requirement set supplied/);
  });

  it("a booking-only event with no routes is BOOKED, never LIVE", () => {
    const r = derive({ commercial: { signed: true, statusLabel: "Signed" }, stops: [] });
    expect(r.state).toBe("BOOKED");
  });
});

describe("deriveLifecycle — READY gate (P3: all blocking requirements satisfied)", () => {
  const bookedRouted = {
    commercial: { signed: true, statusLabel: "Signed" },
    stops: [stop("delivery", "Waiting", 1), stop("pickup", "Waiting", 2)],
  };

  it("all blocking requirements OK -> READY", () => {
    const requirements = [
      req({ id: "contract_signed", blocking: true, status: "OK" }),
      req({ id: "route_exists", blocking: true, status: "OK" }),
      req({ id: "crew_sufficient", blocking: true, status: "OK" }),
      req({ id: "payment_deposit", blocking: false, status: "WARNING" }), // non-blocking never withholds READY
    ];
    const r = derive(bookedRouted, { requirements });
    expect(r.state).toBe("READY");
    expect(r.signals.readiness.readyGateMet).toBe(true);
  });

  it("a BLOCKED blocking requirement withholds READY -> PLANNING", () => {
    const requirements = [
      req({ id: "contract_signed", blocking: true, status: "OK" }),
      req({ id: "route_exists", blocking: true, status: "OK" }),
      req({ id: "crew_sufficient", blocking: true, status: "BLOCKED" }),
    ];
    const r = derive(bookedRouted, { requirements });
    expect(r.state).toBe("PLANNING");
    expect(r.reasons.join(" ")).toMatch(/not all satisfied/);
  });

  it("a blocking WARNING withholds READY; UNVERIFIED (unknown) does NOT", () => {
    const withWarning = derive(bookedRouted, {
      requirements: [req({ id: "delivery_window", blocking: true, status: "WARNING" }), req({ id: "route_exists", blocking: true, status: "OK" })],
    });
    expect(withWarning.state).toBe("PLANNING");

    const withUnverified = derive(bookedRouted, {
      requirements: [req({ id: "crew_sufficient", blocking: true, status: "UNVERIFIED" }), req({ id: "route_exists", blocking: true, status: "OK" })],
    });
    expect(withUnverified.state).toBe("READY");
  });

  it("an empty requirement set is never READY", () => {
    const r = derive(bookedRouted, { requirements: [] });
    expect(r.state).toBe("PLANNING");
    expect(r.signals.readiness.readyGateMet).toBe(false);
  });

  it("READY only applies pre-dispatch — a dispatched event ignores the gate", () => {
    const requirements = [req({ id: "route_exists", blocking: true, status: "OK" })];
    const r = derive(
      { commercial: { signed: true, statusLabel: "Signed" }, stops: [stop("delivery", "EnRoute", 1)] },
      { requirements },
    );
    expect(r.state).toBe("DISPATCHED");
  });
});

describe("deriveLifecycle — logistics tier (routed + active) by stop state", () => {
  it("a stop en route (nothing arrived) -> DISPATCHED", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Signed" },
      stops: [stop("delivery", "EnRoute", 1), stop("pickup", "Waiting", 2)],
    });
    expect(r.state).toBe("DISPATCHED");
    expect(r.signals.logistics.anyDispatched).toBe(true);
  });

  it("route status active (stops still Waiting) -> DISPATCHED", () => {
    const r = derive(
      { commercial: { signed: true, statusLabel: "Signed" }, stops: [stop("delivery", "Waiting", 1)] },
      { routeStatus: "active" },
    );
    expect(r.state).toBe("DISPATCHED");
  });

  it("delivery crew on-site (Arrived) -> SETUP", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Signed" },
      stops: [stop("delivery", "Arrived", 1), stop("pickup", "Waiting", 2)],
    });
    expect(r.state).toBe("SETUP");
  });

  it("delivery completed, pickup not started -> LIVE", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Signed" },
      stops: [stop("delivery", "Completed", 1), stop("pickup", "Waiting", 2)],
    });
    expect(r.state).toBe("LIVE");
  });

  it("pickup leg in motion -> PICKUP", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Signed" },
      stops: [stop("delivery", "Completed", 1), stop("pickup", "EnRoute", 2)],
    });
    expect(r.state).toBe("PICKUP");
  });
});

describe("deriveLifecycle — closeout tier (outcome present)", () => {
  it("route closed, every stop completed -> CLOSED", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Signed" },
      stops: [stop("delivery", "Completed", 1), stop("pickup", "Completed", 2)],
      outcome: { present: true, allCompleted: true, totalStops: 2, completedStops: 2 },
    });
    expect(r.state).toBe("CLOSED");
  });

  it("route closed but not every stop completed -> CLOSEOUT", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Signed" },
      stops: [stop("delivery", "Completed", 1), stop("pickup", "Exception", 2)],
      outcome: { present: true, allCompleted: false, totalStops: 2, completedStops: 1 },
    });
    expect(r.state).toBe("CLOSEOUT");
  });

  it("postevent-closed fact forces CLOSED", () => {
    const r = derive(
      { commercial: { signed: true, statusLabel: "Signed" }, stops: [stop("delivery", "Completed", 1)] },
      { posteventClosed: true },
    );
    expect(r.state).toBe("CLOSED");
  });
});

describe("deriveLifecycle — totality & honesty", () => {
  it("always returns a state the machine recognizes", () => {
    const fixtures: Parameters<typeof view>[0][] = [
      { commercial: { signed: false, statusLabel: null } },
      { commercial: { signed: true }, stops: [stop(null, "Arrived", 1)] },
      { commercial: { signed: true }, stops: [stop("delivery", "HeadingBack", 1)] },
      { commercial: { present: false, signed: null as unknown as boolean }, stops: [stop("delivery", "EnRoute", 1)] },
    ];
    for (const f of fixtures) {
      const r = deriveLifecycle(view(f));
      expect(isLifecycleState(r.state)).toBe(true);
    }
  });

  it("an un-kinded routed event still derives a logistics phase from the aggregate", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Signed" },
      stops: [stop(null, "Arrived", 1)],
    });
    expect(r.state).toBe("SETUP");
  });

  it("surfaces the raw signals so an AI layer can explain without re-deriving", () => {
    const r = derive({
      commercial: { signed: true, statusLabel: "Signed" },
      stops: [stop("delivery", "Completed", 1), stop("pickup", "Waiting", 2)],
    });
    expect(r.signals.logistics.deliveryCompleted).toBe(true);
    expect(r.signals.logistics.pickupStarted).toBe(false);
    expect(r.signals.commercial.commercialState).toBe("BOOKED");
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});
