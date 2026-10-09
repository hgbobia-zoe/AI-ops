// AI Event Manager tests — the deterministic FLOOR is correct + HONEST, and the registry entry is a
// READ/ANALYZE-only ops_exec agent with NO state-write / EXECUTE tool.
//
// The briefing core (buildBriefing) and the Q&A core (answerFromFacts) are PURE: we assemble a real
// EventReadinessBundle by running the actual engine pure functions (generateRequirements +
// computeEventReadiness + deriveLifecycle) over EventView fixtures — the same composition the resolver
// performs — so these tests exercise the true engine, not hand-faked facts. No DB, no network, NO AI
// provider: proving the floor is complete on its own.

import { describe, it, expect } from "vitest";
import type { EventId } from "./id";
import type { CommercialSlice, EventView, LogisticsSlice, LogisticsStop, OutcomeSlice } from "./types";
import { UNVERIFIED } from "./types";
import type { StopState } from "@/lib/types";
import type { WeatherResult } from "@/lib/weather/types";
import { generateRequirements, type RequirementFacts } from "./requirements";
import { computeEventReadiness } from "./readiness";
import { deriveLifecycle } from "./lifecycle";
import type { EventReadinessBundle } from "./resolvers";
import { buildBriefing, answerFromFacts } from "./manager";
import { AI_EMPLOYEES } from "@/lib/aiorg/registry";

const ID = "77001" as EventId;

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

function stop(kind: "delivery" | "pickup" | null, state: StopState, sequence: number, plannedWindow: string | null = null): LogisticsStop {
  return { stopId: `S-${sequence}`, routeId: "R-1", truckId: "T-1", sequence, kind, state, plannedWindow, eta: null, arrivedAt: null, completedAt: null, items: null };
}

function logistics(stops: LogisticsStop[], earliestWindow: string | null = null): LogisticsSlice {
  return { present: stops.length > 0, routeId: stops.length > 0 ? "R-1" : null, stops, primaryRouteOnly: true, earliestWindow };
}

function outcome(over: Partial<OutcomeSlice> = {}): OutcomeSlice {
  return { present: false, routeId: null, totalStops: null, completedStops: null, allCompleted: null, closedAt: null, ...over };
}

function makeView(parts: { commercial?: Partial<CommercialSlice>; stops?: LogisticsStop[]; earliestWindow?: string | null; date?: string | null }): EventView {
  return {
    ref: { id: ID, displayName: "Dixon Wedding", date: parts.date === undefined ? "2026-07-04" : parts.date, dateSource: "booking", customer: "Jane Dixon", contactId: null, venue: "Oak Barn" },
    commercial: commercial(parts.commercial),
    logistics: logistics(parts.stops ?? [], parts.earliestWindow ?? null),
    financials: { present: false, revenue: null, revenueStatus: UNVERIFIED },
    labor: { present: false, totalCost: null, entryCount: 0 },
    outcome: outcome(),
  };
}

/** Assemble a real bundle exactly as resolvers.getEventReadiness does — through the engine pure cores. */
function bundleFor(view: EventView, facts: RequirementFacts = {}): EventReadinessBundle {
  const date = view.ref.date;
  const requirements = generateRequirements(view, facts);
  const readiness = computeEventReadiness(requirements, [], {
    event: { eventId: view.ref.id, date: date ?? "", label: view.ref.displayName ?? "", routeId: view.logistics.routeId ?? undefined },
    daysUntilEvent: facts.daysUntilEvent ?? null,
  });
  const d = deriveLifecycle(view, { requirements });
  return { view, requirements, readiness, lifecycleState: d.state, lifecycleReasons: d.reasons, weather: facts.weather ?? null };
}

const OK_WEATHER: WeatherResult = {
  status: "OK",
  forecast: { dateISO: "2026-07-04", lat: 38, lon: -77, precipitationProbabilityMax: 5, precipitationSum: 0, temperatureMax: 78, temperatureMin: 60, windspeedMax: 6, weathercode: 0 },
};

describe("buildBriefing — honesty on a booking-only event (never ready/live)", () => {
  // Signed booking with NO route: the lifecycle can only be BOOKED, and the missing route BLOCKS readiness.
  const view = makeView({ commercial: { signed: true, statusLabel: "Signed", amountPaid: 0, amountDue: 5000 }, stops: [] });
  const bundle = bundleFor(view);
  const b = buildBriefing(bundle, { today: "2026-06-01" });

  it("reports the engine's lifecycle exactly — BOOKED, never READY or LIVE", () => {
    expect(b.lifecycle).toBe("BOOKED");
    expect(b.lifecycle).not.toBe("READY");
    expect(b.lifecycle).not.toBe("LIVE");
  });

  it("the condition is BLOCKED (a blocking requirement is unmet)", () => {
    expect(b.condition).toBe("BLOCKED");
  });

  it("primaryBlocker cites the real unmet route requirement", () => {
    expect(b.primaryBlocker).not.toBeNull();
    expect(b.primaryBlocker?.source).toBe("route_exists");
  });

  it("whyAtRisk entries each cite a real requirement id", () => {
    expect(b.whyAtRisk.length).toBeGreaterThan(0);
    expect(b.whyAtRisk.some((r) => r.includes("route_exists"))).toBe(true);
    for (const r of b.whyAtRisk) expect(/requirement:|source:/.test(r)).toBe(true);
  });

  it("recommends 'Plan a route' as a RECOMMENDATION (cited, never 'done')", () => {
    const plan = b.recommendedActions.find((a) => a.id === "route_exists");
    expect(plan).toBeTruthy();
    expect(plan?.label).toBe("Plan a route");
    expect(plan?.priority).toBe("blocking");
    expect(plan?.source).toContain("route_exists");
    // The reason is the requirement's own resolution — grounded, not invented.
    expect(plan?.reason).toBe(bundle.requirements.find((r) => r.id === "route_exists")?.resolution);
    // Nothing is phrased as completed.
    for (const a of b.recommendedActions) expect(/\bdone\b|\bcompleted\b/i.test(a.label)).toBe(false);
  });

  it("is COMPLETE with no AI provider — the summary is the deterministic floor", () => {
    expect(b.summarySource).toBe("deterministic");
    expect(b.summary.length).toBeGreaterThan(0);
    // House style: no dash glyphs or emoji slipped through humanize().
    expect(b.summary).not.toMatch(/[—–]/);
    expect(b.citations.length).toBeGreaterThan(0);
  });
});

describe("buildBriefing — a fully satisfied event reads READY + NORMAL", () => {
  const view = makeView({
    commercial: { signed: true, statusLabel: "Signed", amountPaid: 2500, amountDue: 0 },
    stops: [stop("delivery", "Waiting", 1, "2026-07-04T09:00:00Z"), stop("pickup", "Waiting", 2)],
    earliestWindow: "2026-07-04T09:00:00Z",
  });
  const facts: RequirementFacts = {
    staffing: { verified: true, requiredCrew: 2, assignedCrew: 2, hasTent: false, tentReasons: [], driverAssigned: true },
    weather: OK_WEATHER,
    daysUntilEvent: 10,
  };
  const bundle = bundleFor(view, facts);
  const b = buildBriefing(bundle, { today: "2026-06-24" });

  it("lifecycle is READY (the P3 blocking gate is satisfied) and condition NORMAL", () => {
    expect(b.lifecycle).toBe("READY");
    expect(b.condition).toBe("NORMAL");
  });

  it("no primary blocker and no 'at risk' reasons when everything is satisfied", () => {
    expect(b.primaryBlocker).toBeNull();
    expect(b.whyAtRisk).toEqual([]);
  });
});

describe("answerFromFacts — bounded Q&A, grounded or honestly 'unknown'", () => {
  const bookingOnly = bundleFor(makeView({ commercial: { signed: true, statusLabel: "Signed" }, stops: [] }));
  const routed = bundleFor(
    makeView({ commercial: { signed: true, statusLabel: "Signed" }, stops: [stop("delivery", "Waiting", 1, "2026-07-04T09:00:00Z")], earliestWindow: "2026-07-04T09:00:00Z" }),
    { staffing: { verified: true, requiredCrew: 1, assignedCrew: 1, hasTent: false, tentReasons: [], driverAssigned: true }, weather: OK_WEATHER },
  );

  it("'is a driver assigned?' with no route -> unknown (no fabricated state)", () => {
    const a = answerFromFacts(bookingOnly, "Is a driver assigned?");
    expect(a.grounded).toBe(false);
    expect(a.answer.toLowerCase()).toContain("unknown");
  });

  it("'is a driver assigned?' on a routed event -> grounded yes, cited", () => {
    const a = answerFromFacts(routed, "is a driver assigned?");
    expect(a.grounded).toBe(true);
    expect(a.answer.toLowerCase()).toContain("yes");
    expect(a.citations.length).toBeGreaterThan(0);
  });

  it("'what's the weather?' answers from the weather requirement", () => {
    const a = answerFromFacts(routed, "what is the weather looking like?");
    expect(a.answer.toLowerCase()).toContain("weather");
    expect(a.citations.some((c) => c.ref.includes("weather"))).toBe(true);
  });

  it("'are we ready to go?' is grounded in the lifecycle", () => {
    const a = answerFromFacts(routed, "are we ready to go?");
    expect(a.grounded).toBe(true);
    expect(a.citations.some((c) => c.ref.includes("deriveLifecycle"))).toBe(true);
  });

  it("an unsupported question -> honest unknown, not a guess", () => {
    const a = answerFromFacts(routed, "what is on the catering menu?");
    expect(a.grounded).toBe(false);
    expect(a.answer.toLowerCase()).toContain("unknown");
    expect(a.citations).toEqual([]);
  });
});

describe("registry — Event Manager is a READ/ANALYZE-only ops_exec agent (no state-write/EXECUTE)", () => {
  const em = AI_EMPLOYEES.find((e) => e.id === "event-manager");

  it("exists as ops_exec, owned by Hermann+Cindy", () => {
    expect(em).toBeTruthy();
    expect(em?.department).toBe("ops_exec");
    expect(em?.owner).toBe("Hermann+Cindy");
  });

  it("has NO state-write / EXECUTE tool — every tool is READ, ANALYZE, or APPROVAL_REQUIRED", () => {
    expect(em?.toolbox.length).toBeGreaterThan(0);
    for (const t of em!.toolbox) {
      expect(t.perm).not.toBe("EXECUTE");
      expect(["READ", "ANALYZE", "APPROVAL_REQUIRED"]).toContain(t.perm);
    }
  });

  it("exposes no EXTERNAL / WORKFLOW write tool, and any comms tool is APPROVAL_REQUIRED", () => {
    for (const t of em!.toolbox) {
      expect(t.category).not.toBe("EXTERNAL");
      expect(t.category).not.toBe("WORKFLOW");
      if (t.category === "COMMS_SEND") expect(t.perm).toBe("APPROVAL_REQUIRED");
    }
  });

  it("is honestly backed as 'partial' (engine live, surfacing blade not built)", () => {
    expect(em?.backing).toBe("partial");
  });
});
