import { describe, it, expect } from "vitest";
import { eligibilityFor, type AssignmentWindow } from "./eligibility";
import type { CrewShift, UnavailabilityBlock } from "@/lib/connecteam";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
// All times Unix seconds. Use a fixed base day so windows are easy to read.
const H = 3600;
const DAY = Date.UTC(2026, 9, 5) / 1000; // 2026-10-05 00:00 UTC
const at = (hour: number): number => DAY + hour * H;

function shift(userId: number, startHour: number, endHour: number): CrewShift {
  return {
    id: `cs-${userId}-${startHour}`,
    schedulerId: 1,
    schedulerName: "Job",
    startUnix: at(startHour),
    endUnix: at(endHour),
    timezone: "America/New_York",
    isOpen: false,
    title: "Work",
    assignees: [{ userId, name: `#${userId}`, role: "driver" }],
  };
}

function block(startHour: number, endHour: number, kind: "unavailability" | "timeOff" = "unavailability", reason?: string): UnavailabilityBlock {
  return { userId: 1, kind, startUnix: at(startHour), endUnix: at(endHour), reason };
}

const assign = (userId: number, shiftId: string, startHour: number, endHour: number): AssignmentWindow => ({
  userId,
  shiftId,
  start: at(startHour),
  end: at(endHour),
});

const WORKER = 1;
const base = {
  userId: WORKER,
  dayShifts: [] as CrewShift[],
  assignments: [] as AssignmentWindow[],
  unavailability: [] as UnavailabilityBlock[],
  availabilityKnown: true,
};

describe("eligibilityFor", () => {
  it("AVAILABLE when nothing is scheduled and no block", () => {
    const r = eligibilityFor({ ...base, routeWindow: { start: at(10), end: at(14) } });
    expect(r.state).toBe("AVAILABLE");
    expect(r.eligible).toBe(true);
    expect(r.preferred).toBe(false);
  });

  it("SCHEDULED_UNASSIGNED (preferred) when a Connecteam shift covers the window and there is no Zoe route", () => {
    const r = eligibilityFor({
      ...base,
      routeWindow: { start: at(10), end: at(14) },
      dayShifts: [shift(WORKER, 8, 17)], // scheduled 8–17 covers 10–14
    });
    expect(r.state).toBe("SCHEDULED_UNASSIGNED");
    expect(r.eligible).toBe(true);
    expect(r.preferred).toBe(true); // the whole point: a scheduled-but-free worker is the top pick, not "busy"
    expect(r.scheduleWindow).toEqual({ start: at(8), end: at(17) });
  });

  it("ASSIGNED (not eligible) when already on another Zoe route overlapping the window", () => {
    const r = eligibilityFor({
      ...base,
      routeWindow: { start: at(10), end: at(14) },
      assignments: [assign(WORKER, "other-route", 9, 13)],
    });
    expect(r.state).toBe("ASSIGNED");
    expect(r.eligible).toBe(false);
  });

  it("ASSIGNED (not eligible) when already on THIS route", () => {
    const r = eligibilityFor({
      ...base,
      routeWindow: { start: at(10), end: at(14) },
      assignments: [assign(WORKER, "this-route", 10, 14)],
      thisShiftId: "this-route",
    });
    expect(r.state).toBe("ASSIGNED");
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toContain("already on this route");
  });

  // The real Marquis Crossen case: unavailability 9:00–15:00 on 2026-10-05.
  it("UNAVAILABLE for a morning route that overlaps the block, but ELIGIBLE for the afternoon", () => {
    const marquisBlock = [block(9, 15)]; // 9am–3pm, exactly his real block

    const morning = eligibilityFor({ ...base, routeWindow: { start: at(9), end: at(13) }, unavailability: marquisBlock });
    expect(morning.state).toBe("UNAVAILABLE");
    expect(morning.eligible).toBe(false);
    expect(morning.block).toEqual({ start: at(9), end: at(15), kind: "unavailability", reason: undefined });

    const afternoon = eligibilityFor({ ...base, routeWindow: { start: at(16), end: at(20) }, unavailability: marquisBlock });
    expect(afternoon.state).toBe("AVAILABLE");
    expect(afternoon.eligible).toBe(true);
  });

  it("UNAVAILABLE wins over a work shift (marked off beats scheduled)", () => {
    const r = eligibilityFor({
      ...base,
      routeWindow: { start: at(10), end: at(14) },
      dayShifts: [shift(WORKER, 8, 17)],
      unavailability: [block(9, 15, "timeOff", "PTO")],
    });
    expect(r.state).toBe("UNAVAILABLE");
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toContain("PTO");
  });

  it("SCHEDULE_CONFLICT (still eligible) when the work window only partially covers the route", () => {
    const r = eligibilityFor({
      ...base,
      routeWindow: { start: at(10), end: at(16) },
      dayShifts: [shift(WORKER, 8, 12)], // scheduled 8–12, route runs to 16 → partial
    });
    expect(r.state).toBe("SCHEDULE_CONFLICT");
    expect(r.eligible).toBe(true); // soft signal, not a hard block — dispatcher is informed, not prevented
  });

  it("flags availability as unknown when the feed did not answer, but stays eligible (never fabricates free)", () => {
    const r = eligibilityFor({ ...base, routeWindow: { start: at(10), end: at(14) }, availabilityKnown: false });
    expect(r.availabilityKnown).toBe(false);
    expect(r.eligible).toBe(true);
    expect(r.reasons.join(" ")).toContain("unverified");
  });

  it("does not check conflicts when the route window is unknown, but still flags it", () => {
    const r = eligibilityFor({ ...base, routeWindow: null, dayShifts: [shift(WORKER, 8, 17)] });
    expect(r.eligible).toBe(true);
    expect(r.state).toBe("SCHEDULED_UNASSIGNED"); // scheduled today, window not set
    expect(r.reasons.join(" ")).toContain("route window not set");
  });

  it("another worker's shift/block never affects this worker", () => {
    const r = eligibilityFor({
      ...base,
      routeWindow: { start: at(10), end: at(14) },
      dayShifts: [shift(999, 8, 17)], // someone else scheduled
      assignments: [assign(999, "x", 10, 14)], // someone else assigned
    });
    expect(r.state).toBe("AVAILABLE");
    expect(r.eligible).toBe(true);
  });
});
