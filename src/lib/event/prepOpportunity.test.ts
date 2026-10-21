import { describe, it, expect } from "vitest";
import { assessPrepOpportunities, type PrepFacts, type PrepTruckState, type PrepTomorrowRoute, type PrepCrew } from "./prepOpportunity";
import type { RiskFinding } from "@/lib/risk/types";

// "Today" is 2026-09-09; tomorrow (the prep target) is 2026-09-10. "now" is mid-afternoon today, so a
// feasible in-shift window still exists by default.
const TOMORROW = "2026-09-10";
const TZ = "America/New_York";
// A today instant, as Unix seconds, from an ET wall-clock hour.
const todayUnix = (h: number, m = 0) => Math.floor(Date.parse(`2026-09-09T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-04:00`) / 1000);
const NOW = new Date(todayUnix(14) * 1000); // 2 PM ET today

function truck(truckId: string, over: Partial<PrepTruckState> = {}): PrepTruckState {
  return { truckId, freeToday: true, freeReason: "all of today's routes done", returnVerified: true, ...over };
}
function route(truckId: string, over: Partial<PrepTomorrowRoute> = {}): PrepTomorrowRoute {
  return {
    routeId: `R-${truckId}`,
    truckId,
    eventId: `TX-${truckId}`,
    eventLabel: `Event ${truckId}`,
    date: TOMORROW,
    dispatchWindow: `${TOMORROW}T09:00:00-04:00`,
    stopCount: 3,
    itemCount: 20,
    needsLoad: true,
    blocker: null,
    ...over,
  };
}
function crew(over: Partial<PrepCrew> = {}): PrepCrew {
  // Default: 2 crew, shifts end 6 PM today (4h of runway from 2 PM now).
  return { verified: true, availableCount: 2, shiftEndUnix: [todayUnix(18), todayUnix(18)], ...over };
}
function facts(over: Partial<PrepFacts> = {}): PrepFacts {
  const t = over.trucks ?? new Map([["NPR-1", truck("NPR-1")]]);
  const r = over.routes ?? [route("NPR-1")];
  return {
    tomorrowDate: TOMORROW,
    warehouseCloseUnix: null,
    displayTz: TZ,
    trucks: t,
    routes: r,
    crew: crew(),
    ...over,
  };
}
const byType = (fs: RiskFinding[], t: string) => fs.filter((f) => f.riskType === t);
const forTruck = (fs: RiskFinding[], id: string) => fs.filter((f) => f.truckId === id);

describe("assessPrepOpportunities — operational prep-window detection (12 cases)", () => {
  // 1. Tomorrow's truck not prepared, today's driver+truck free, time remains → prep_window_open.
  it("1: free truck + crew + time remaining → prep_window_open (unverified, actionable)", () => {
    const f = assessPrepOpportunities(facts(), {}, NOW);
    const open = byType(f, "prep_window_open");
    expect(open).toHaveLength(1);
    expect(open[0].category).toBe("OPPORTUNITY");
    expect(open[0].unverified).toBe(true); // never asserts the truck is unloaded
    expect(open[0].owner).toBe("Warehouse / Ops");
    expect(open[0].deadline).toBeTruthy();
    expect(open[0].recommendedAction).toMatch(/load/i);
    expect(open[0].metadata?.confidence).toBe("moderate");
  });

  // 2. Same but crew already at/past shift-end → NO actionable rec (missed, never infeasible work).
  it("2a: crew shift already ended → prep_window_missed, no open rec (honors OT/shift limit)", () => {
    const f = assessPrepOpportunities(facts({ crew: crew({ shiftEndUnix: [todayUnix(13)], availableCount: 1 }) }), {}, NOW);
    expect(byType(f, "prep_window_open")).toHaveLength(0);
    expect(byType(f, "prep_window_missed")).toHaveLength(1);
  });
  it("2b: loading would run past shift-end (in-shift-only) → missed, not an actionable load-now", () => {
    // 90-min load but only 60 min to shift-end → latest-safe-start is in the past → missed.
    const f = assessPrepOpportunities(
      facts({ routes: [route("NPR-1", { stopCount: 1, itemCount: 0 })], crew: crew({ shiftEndUnix: [todayUnix(14, 30)], availableCount: 1 }) }),
      { loadBaseMinutes: 60, loadMinutesPerStop: 0, loadMinutesPerItem: 0 },
      NOW,
    );
    expect(byType(f, "prep_window_open")).toHaveLength(0);
    expect(byType(f, "prep_window_missed")).toHaveLength(1);
  });

  // 3. No "loaded" signal exists, so "already prepared" can't be asserted. Instead: once the truck is NOT
  //    free (its route started / today not done), NO open opportunity exists.
  it("3: truck not free today (still running a route) → no finding at all", () => {
    const f = assessPrepOpportunities(
      facts({ trucks: new Map([["NPR-1", truck("NPR-1", { freeToday: false, freeReason: "route in progress" })]]) }),
      {},
      NOW,
    );
    expect(f).toEqual([]);
  });

  // 4. Required inventory unavailable/not allocatable → surface the real blocking dependency, not a load rec.
  it("4: a data-backed blocker → threatened finding naming the blocker, no load-now rec", () => {
    const f = assessPrepOpportunities(
      facts({ routes: [route("NPR-1", { blocker: { label: "inventory not allocatable", detail: "3 tables double-booked on 09-10" } })] }),
      {},
      NOW,
    );
    expect(byType(f, "prep_window_open")).toHaveLength(0);
    const th = byType(f, "prep_window_threatened");
    expect(th).toHaveLength(1);
    expect(th[0].recommendedAction).toMatch(/inventory not allocatable/i);
    expect(th[0].metadata?.blocker).toBeTruthy();
  });

  // 5. Route completed but NO reliable return signal → do not treat "returned" as fact; reflect uncertainty.
  it("5: free inferred from status (no warehouse-arrival tap) → low confidence + honest unknown note", () => {
    const f = assessPrepOpportunities(
      facts({ trucks: new Map([["NPR-1", truck("NPR-1", { returnVerified: false, freeReason: "route marked done (return not confirmed)" })]]) }),
      {},
      NOW,
    );
    const open = byType(f, "prep_window_open");
    expect(open).toHaveLength(1);
    expect(open[0].metadata?.confidence).toBe("low");
    expect(String(open[0].metadata?.whatsUnknown)).toMatch(/return is not confirmed/i);
  });

  // 6. Several trucks need prep, limited crew capacity → rank/limit; don't assume unlimited capacity.
  it("6: 3 free trucks but only 1 crew → 1 open (earliest dispatch), 2 threatened (capacity-limited)", () => {
    const trucks = new Map([
      ["A", truck("A")],
      ["B", truck("B")],
      ["C", truck("C")],
    ]);
    const routes = [
      route("A", { dispatchWindow: `${TOMORROW}T11:00:00-04:00` }),
      route("B", { dispatchWindow: `${TOMORROW}T08:00:00-04:00` }), // earliest dispatch → highest priority
      route("C", { dispatchWindow: `${TOMORROW}T14:00:00-04:00` }),
    ];
    const f = assessPrepOpportunities(facts({ trucks, routes, crew: crew({ availableCount: 1, shiftEndUnix: [todayUnix(20)] }) }), {}, NOW);
    const open = byType(f, "prep_window_open");
    expect(open).toHaveLength(1);
    expect(open[0].truckId).toBe("B"); // the earliest-dispatching truck wins the single crew slot
    expect(byType(f, "prep_window_threatened").filter((x) => x.metadata?.capacityLimited)).toHaveLength(2);
  });

  // 7. Repeated trigger → stable signature so reconcileRisks dedupes to one record.
  it("7: identical facts twice → identical stable signature (dedup), one per truck", () => {
    const a = assessPrepOpportunities(facts(), {}, NOW);
    const b = assessPrepOpportunities(facts(), {}, NOW);
    expect(a[0].signature).toBe(b[0].signature);
    expect(a[0].signature).toBe(`prep_window|${TOMORROW}|NPR-1`);
    expect(forTruck(a, "NPR-1")).toHaveLength(1);
  });

  // 8. Event changes after a rec → recomputed (bigger load shrinks the window / can flip the bucket).
  it("8: event grows (more stops/items) → recomputed, same signature, larger load estimate", () => {
    const small = assessPrepOpportunities(facts({ routes: [route("NPR-1", { stopCount: 1, itemCount: 5 })] }), {}, NOW);
    const big = assessPrepOpportunities(facts({ routes: [route("NPR-1", { stopCount: 8, itemCount: 200 })] }), {}, NOW);
    expect(big[0].signature).toBe(small[0].signature);
    expect(Number(big[0].metadata?.loadMinutes)).toBeGreaterThan(Number(small[0].metadata?.loadMinutes));
  });

  // 9. "Completed" resolves only on verified evidence (route started / window closed), never on ack.
  //    The pure rule's contribution: it stops emitting an OPEN finding once the truck is no longer free
  //    (route started) — reconcileRisks then resolves it. Acknowledge is not modeled here (status only).
  it("9: once the route starts (truck not free) the OPEN finding disappears → reconcile can resolve it", () => {
    const open = assessPrepOpportunities(facts(), {}, NOW);
    expect(byType(open, "prep_window_open")).toHaveLength(1);
    const started = assessPrepOpportunities(
      facts({ trucks: new Map([["NPR-1", truck("NPR-1", { freeToday: false, freeReason: "tomorrow route started early" })]]) }),
      {},
      NOW,
    );
    expect(started).toEqual([]); // nothing emitted → the open record is no longer "seen" → resolvable
  });

  // 10. End-of-day: a window that was open earlier is MISSED when evaluated after the cutoff (the sweep).
  it("10: same facts, later clock (after cutoff) → prep_window_missed (end-of-day sweep catches it)", () => {
    const base = facts({ crew: crew({ shiftEndUnix: [todayUnix(17)], availableCount: 1 }) });
    const early = assessPrepOpportunities(base, {}, new Date(todayUnix(14) * 1000));
    expect(byType(early, "prep_window_open")).toHaveLength(1);
    const late = assessPrepOpportunities(base, {}, new Date(todayUnix(16, 45) * 1000)); // past latest safe start
    expect(byType(late, "prep_window_open")).toHaveLength(0);
    expect(byType(late, "prep_window_missed")).toHaveLength(1);
  });

  // 11. Route/event cancelled → obsolete rec closed/updated: the pure rule simply emits nothing for a
  //     truck with no tomorrow route, so reconcileRisks resolves any prior finding.
  it("11: tomorrow route removed (cancelled) → no finding for that truck", () => {
    const f = assessPrepOpportunities(facts({ routes: [] }), {}, NOW);
    expect(f).toEqual([]);
  });

  // 12. Stale/unavailable data → communicate uncertainty (low confidence / unknown), never invent readiness.
  it("12: Connecteam unreachable (crew unverified) → low-confidence threatened, no actionable load-now", () => {
    const f = assessPrepOpportunities(facts({ crew: crew({ verified: false, availableCount: 0, shiftEndUnix: [] }) }), {}, NOW);
    expect(byType(f, "prep_window_open")).toHaveLength(0);
    const th = byType(f, "prep_window_threatened");
    expect(th).toHaveLength(1);
    expect(th[0].metadata?.confidence).toBe("low");
    expect(th[0].unverified).toBe(true);
    expect(String(th[0].metadata?.whatsUnknown)).toMatch(/Connecteam unreachable/i);
  });

  // Extra guard: a pickup-only route (no load needed) is never flagged.
  it("pickup-only route (needsLoad=false) → no finding", () => {
    const f = assessPrepOpportunities(facts({ routes: [route("NPR-1", { needsLoad: false })] }), {}, NOW);
    expect(f).toEqual([]);
  });
});

// ── STAFFING-AWARE escalation — the Smith (2026-10-22) false-alarm fix ───────────────────────────────
// A small load (0 stops/items → 45 min) with a shift ending 3 PM today puts "now" (2 PM) inside the
// closing window: remaining = (15:00 − 45m) − 14:00 = 15 min, i.e. ≤ threatenedMinutes/2 → HIGH on the
// clock. The ONLY difference between these cases is whether a PREP crew is on shift.
describe("assessPrepOpportunities — staffing-aware prep window (Smith false-alarm fix)", () => {
  const smallRoute = (over: Partial<PrepTomorrowRoute> = {}) => route("NPR-1", { stopCount: 0, itemCount: 0, ...over });

  it("STAFFED + window closing on the clock → does NOT escalate to HIGH (stays LOW, open/informational)", () => {
    const f = assessPrepOpportunities(
      facts({
        routes: [smallRoute()],
        crew: crew({ shiftEndUnix: [todayUnix(15)], availableCount: 2, prepOnShiftCount: 2 }), // Adrane + Alain on
      }),
      {},
      NOW,
    );
    // No HIGH, no "threatened" page — it is being worked by the on-shift prep crew.
    expect(f.filter((x) => x.severity === "HIGH")).toHaveLength(0);
    expect(byType(f, "prep_window_threatened")).toHaveLength(0);
    const open = byType(f, "prep_window_open");
    expect(open).toHaveLength(1);
    expect(open[0].severity).toBe("LOW");
    expect(open[0].metadata?.prepStaffed).toBe(true);
    expect(open[0].metadata?.prepOnShiftCount).toBe(2);
    // Honest copy: states prep is STAFFED, not that loading is done.
    expect(String(open[0].metadata?.whatsUnknown)).toMatch(/prep is staffed/i);
    expect(open[0].recommendedAction).toMatch(/prep crew is on shift/i);
  });

  it("UNSTAFFED + window closing on the clock → DOES escalate (threatened HIGH), honest copy", () => {
    const f = assessPrepOpportunities(
      facts({
        routes: [smallRoute()],
        crew: crew({ shiftEndUnix: [todayUnix(15)], availableCount: 1, prepOnShiftCount: 0 }), // a driver, no prep crew
      }),
      {},
      NOW,
    );
    const th = byType(f, "prep_window_threatened");
    expect(th).toHaveLength(1);
    expect(th[0].severity).toBe("HIGH");
    expect(th[0].metadata?.prepStaffed).toBe(false);
    expect(String(th[0].metadata?.whatsUnknown)).toMatch(/no prep crew is on shift/i);
    expect(th[0].recommendedAction).toMatch(/no prep crew is on shift/i);
  });

  it("STAFFED comfortable window → stays LOW (clock never nudges a staffed load up to MEDIUM)", () => {
    // remaining = (16:00 − 45m) − 14:00 = 75 min → below threatenedMinutes*2 (90) → MEDIUM when UNSTAFFED.
    const base = { routes: [smallRoute()] as PrepTomorrowRoute[] };
    const staffed = assessPrepOpportunities(
      facts({ ...base, crew: crew({ shiftEndUnix: [todayUnix(16)], availableCount: 2, prepOnShiftCount: 2 }) }),
      {},
      NOW,
    );
    const unstaffed = assessPrepOpportunities(
      facts({ ...base, crew: crew({ shiftEndUnix: [todayUnix(16)], availableCount: 1, prepOnShiftCount: 0 }) }),
      {},
      NOW,
    );
    expect(byType(staffed, "prep_window_open")[0].severity).toBe("LOW"); // staffed → not nudged up
    expect(byType(unstaffed, "prep_window_open")[0].severity).toBe("MEDIUM"); // unstaffed → the clock nudges it
  });

  it("omitted prepOnShiftCount is treated as UNSTAFFED → preserves pre-staffing clock-only behavior", () => {
    const f = assessPrepOpportunities(
      facts({ routes: [smallRoute()], crew: crew({ shiftEndUnix: [todayUnix(15)], availableCount: 1 }) }), // no prepOnShiftCount
      {},
      NOW,
    );
    expect(byType(f, "prep_window_threatened").filter((x) => x.severity === "HIGH")).toHaveLength(1);
  });
});
