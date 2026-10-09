// Timeline generator tests — PURE, fixture EventViews. Verifies the milestone SET diverges by attributes
// (tent vs simple delivery), status is computed deterministically from a fixed "today" + the passed P3
// requirements, and the requirement→deadline mapping feeds real deadlines back to P3.

import { describe, it, expect } from "vitest";
import type { EventId } from "./id";
import type { CommercialSlice, EventView, LogisticsSlice, LogisticsStop, Requirement, RequirementStatus } from "./types";
import { UNVERIFIED } from "./types";
import { TIMELINE_POLICY, generateTimeline, requirementDeadlines, withDeadlines } from "./timeline";

const ID = "62232" as EventId;

function commercial(over: Partial<CommercialSlice> = {}): CommercialSlice {
  return {
    present: true, statusLabel: "Signed", signed: true, grandTotal: 5000, contractTotal: 5000,
    amountPaid: 2500, amountDue: 2500, quoteSentAt: null, quoteOpenedAt: null, dateCreated: null,
    lossReason: null, archived: false, lineItems: null, ...over,
  };
}

function stop(items: { name: string; quantity?: number }[] | null, over: Partial<LogisticsStop> = {}): LogisticsStop {
  return {
    stopId: "S-1", routeId: "R-1", truckId: "T-1", sequence: 1, kind: "delivery", state: "Waiting",
    plannedWindow: "2026-07-04T14:00:00Z", eta: null, arrivedAt: null, completedAt: null, items, ...over,
  };
}

function logistics(stops: LogisticsStop[]): LogisticsSlice {
  return {
    present: stops.length > 0, routeId: stops.length > 0 ? "R-1" : null, stops, primaryRouteOnly: true,
    earliestWindow: stops.find((s) => s.plannedWindow)?.plannedWindow ?? null,
  };
}

function view(parts: { stops?: LogisticsStop[]; lineItems?: string[] | null; date?: string | null } = {}): EventView {
  return {
    ref: { id: ID, displayName: "Test", date: parts.date === undefined ? "2026-07-04" : parts.date, dateSource: "booking", customer: "Jane", contactId: null, venue: "The Barn" },
    commercial: commercial({ lineItems: parts.lineItems ?? null }),
    logistics: logistics(parts.stops ?? [stop([{ name: "Chairs", quantity: 100 }])]),
    financials: { present: false, revenue: null, revenueStatus: UNVERIFIED },
    labor: { present: false, totalCost: null, entryCount: 0 },
    outcome: { present: false, routeId: null, totalStops: null, completedStops: null, allCompleted: null, closedAt: null },
  };
}

function req(id: string, status: RequirementStatus, blocking = true): Requirement {
  return { id, label: id, status, source: "s", owner: "o", deadline: null, blocking, resolution: "" };
}

describe("generateTimeline — set diverges by attributes", () => {
  it("a tent event gets earlier, more milestones (planning −30, dedicated inventory+weather check)", () => {
    const tent = generateTimeline(view({ stops: [stop([{ name: "40x60 Tent" }, { name: "Chairs" }])] }));
    const ids = tent.map((m) => m.id);
    expect(ids).toContain("inventory_weather");
    expect(tent.find((m) => m.id === "planning")?.offsetDays).toBe(TIMELINE_POLICY.tent.planning); // −30
    expect(tent.find((m) => m.id === "staffing_review")?.requirementIds).toContain("tent_crew");
  });

  it("a simple chair delivery gets a shorter track (planning −10, no separate inventory/weather milestone)", () => {
    const simple = generateTimeline(view({ stops: [stop([{ name: "Chairs" }])] }));
    const ids = simple.map((m) => m.id);
    expect(ids).not.toContain("inventory_weather");
    expect(simple.find((m) => m.id === "planning")?.offsetDays).toBe(TIMELINE_POLICY.simple.planning); // −10
    // weather folds into final confirmation for a simple delivery
    expect(simple.find((m) => m.id === "final_confirm")?.requirementIds).toContain("weather_reviewed");
    // no tent ⇒ staffing review doesn't ask for tent crew
    expect(simple.find((m) => m.id === "staffing_review")?.requirementIds).not.toContain("tent_crew");
  });

  it("the tent profile has strictly more milestones than the simple one", () => {
    const tent = generateTimeline(view({ stops: [stop([{ name: "Sailcloth Tent" }])] }));
    const simple = generateTimeline(view({ stops: [stop([{ name: "Chairs" }])] }));
    expect(tent.length).toBeGreaterThan(simple.length);
  });

  it("dates are the event date shifted by the offset; undated events are all 'na'", () => {
    const tent = generateTimeline(view({ stops: [stop([{ name: "Tent" }])], date: "2026-07-04" }));
    expect(tent.find((m) => m.id === "planning")?.date).toBe("2026-06-04"); // −30 days
    expect(tent.find((m) => m.id === "event_day")?.date).toBe("2026-07-04");
    expect(tent.find((m) => m.id === "pickup_closeout")?.date).toBe("2026-07-05"); // +1 day

    const undated = generateTimeline(view({ date: null }));
    expect(undated.every((m) => m.date === null && m.status === "na")).toBe(true);
  });
});

describe("generateTimeline — deterministic status from a fixed today + requirements", () => {
  const items = [{ name: "Chairs" }];
  it("mapped requirements all OK ⇒ 'done'", () => {
    const tl = generateTimeline(view({ stops: [stop(items)] }), {
      today: "2026-06-25",
      requirements: [req("contract_signed", "OK"), req("route_exists", "OK"), req("payment_deposit", "OK", false)],
    });
    expect(tl.find((m) => m.id === "planning")?.status).toBe("done");
  });

  it("past date with an unmet BLOCKING requirement ⇒ 'overdue'", () => {
    const tl = generateTimeline(view({ stops: [stop(items)] }), {
      today: "2026-07-01", // past planning (−10 = 2026-06-24) and staffing (−5 = 2026-06-29)
      requirements: [req("crew_sufficient", "BLOCKED"), req("driver_assigned", "WARNING", false)],
    });
    expect(tl.find((m) => m.id === "staffing_review")?.status).toBe("overdue");
  });

  it("future milestone with unsatisfied requirements ⇒ 'upcoming'; today ⇒ 'due'", () => {
    const tl = generateTimeline(view({ stops: [stop(items)] }), {
      today: "2026-06-24", // == planning date (−10)
      requirements: [req("contract_signed", "BLOCKED"), req("route_exists", "OK")],
    });
    expect(tl.find((m) => m.id === "planning")?.status).toBe("due"); // today, not all mapped reqs OK
    // final_confirm's mapped reqs weren't generated ⇒ calendar-only, future (−2) ⇒ upcoming
    expect(tl.find((m) => m.id === "final_confirm")?.status).toBe("upcoming");
  });

  it("calendar-only milestones (event day / closeout) are date-based: past ⇒ done, future ⇒ upcoming", () => {
    const afterEvent = generateTimeline(view({ stops: [stop(items)] }), { today: "2026-07-10" });
    expect(afterEvent.find((m) => m.id === "event_day")?.status).toBe("done");
    expect(afterEvent.find((m) => m.id === "pickup_closeout")?.status).toBe("done");
    const beforeEvent = generateTimeline(view({ stops: [stop(items)] }), { today: "2026-06-01" });
    expect(beforeEvent.find((m) => m.id === "event_day")?.status).toBe("upcoming");
  });
});

describe("requirement → deadline mapping", () => {
  it("maps each requirement to the EARLIEST milestone date that requires it", () => {
    const tent = generateTimeline(view({ stops: [stop([{ name: "40x60 Tent" }])], date: "2026-07-04" }));
    const map = requirementDeadlines(tent);
    // contract_signed is first due at planning (−30 = 2026-06-04)
    expect(map["contract_signed"]).toBe("2026-06-04");
    // crew_sufficient first due at staffing review (−14 = 2026-06-20)
    expect(map["crew_sufficient"]).toBe("2026-06-20");
    // delivery_window appears at final_confirm (−3) AND dispatch_check (−1); earliest wins
    expect(map["delivery_window"]).toBe("2026-07-01");
  });

  it("withDeadlines fills P3's null deadline from the timeline without mutating the input", () => {
    const tl = generateTimeline(view({ stops: [stop([{ name: "Chairs" }])], date: "2026-07-04" }));
    const reqs = [req("contract_signed", "OK"), req("crew_sufficient", "UNVERIFIED")];
    const withDl = withDeadlines(reqs, tl);
    expect(reqs[0].deadline).toBeNull(); // original untouched
    expect(withDl[0].deadline).toBe("2026-06-24"); // simple planning −10
    expect(withDl[1].deadline).toBe("2026-06-29"); // simple staffing −5
  });

  it("undated events produce an empty deadline map", () => {
    const tl = generateTimeline(view({ date: null }));
    expect(requirementDeadlines(tl)).toEqual({});
  });
});
