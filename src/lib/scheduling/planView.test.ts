import { describe, it, expect } from "vitest";
import { summarizePlan, computeStaffingHealth, moveEligibility } from "./planView";
import type { StaffingPlan, PlannedAssignment } from "./optimize";

function plan(p: Partial<StaffingPlan> & { assignments: PlannedAssignment[] }): StaffingPlan {
  return {
    date: "2026-10-04",
    currentTempHours: null,
    planTempHours: null,
    currentTempCount: 0,
    planTempCount: 0,
    tempHoursSaved: null,
    tempCountSaved: 0,
    betterThanCurrent: false,
    alreadyOptimal: true,
    note: "",
    ...p,
  };
}

function internal(shiftId: string, routeId: string): PlannedAssignment {
  return { shiftId, routeId, role: "driver", kind: "internal", userId: 1, name: "A", hours: 8, whyThisRoute: "", whyTemp: null, wasCommitted: true, moved: false, fromRouteId: null };
}
function temp(shiftId: string, routeId: string): PlannedAssignment {
  return { shiftId, routeId, role: "field", kind: "temp", userId: null, name: "Temp", hours: 6, whyThisRoute: "", whyTemp: "Internal crew exhausted for this window", wasCommitted: false, moved: false, fromRouteId: null };
}

describe("summarizePlan", () => {
  it("rolls up internal placed, gap, Instawork required and mean readiness", () => {
    const s = summarizePlan({
      routes: 2,
      peopleNeeded: 4,
      coverage: { internalTotal: 3 },
      plan: plan({ assignments: [internal("d1", "r1"), internal("d2", "r2"), temp("f1", "r1")], planTempCount: 1, tempHoursSaved: 2 }),
      estInstaworkCost: 240,
      readinessScores: [100, 70],
    });
    expect(s.routes).toBe(2);
    expect(s.peopleNeeded).toBe(4);
    expect(s.internalAvailable).toBe(3);
    expect(s.internalAssigned).toBe(2);
    expect(s.staffingGap).toBe(1);
    expect(s.instaworkRequired).toBe(1);
    expect(s.readinessPct).toBe(85);
    expect(s.estInstaworkCost).toBe(240);
    expect(s.tempHoursSaved).toBe(2);
  });

  it("readinessPct is null when there are no shifts to score, and keeps an unknown cost null", () => {
    const s = summarizePlan({ routes: 0, peopleNeeded: 0, coverage: { internalTotal: 0 }, plan: plan({ assignments: [] }), estInstaworkCost: null, readinessScores: [] });
    expect(s.readinessPct).toBeNull();
    expect(s.estInstaworkCost).toBeNull();
  });
});

describe("computeStaffingHealth", () => {
  it("returns null when there are no shifts", () => {
    expect(computeStaffingHealth({ hasShifts: false, redExceptions: 0, planTempCount: 0, currentGapTotal: 0, readinessLevels: [] })).toBeNull();
  });
  it("ACTION_REQUIRED when any RED exception is open (beats everything)", () => {
    expect(computeStaffingHealth({ hasShifts: true, redExceptions: 1, planTempCount: 0, currentGapTotal: 0, readinessLevels: ["READY"] })).toBe("ACTION_REQUIRED");
  });
  it("INSTAWORK_REQUIRED when the optimizer leaves temp seats", () => {
    expect(computeStaffingHealth({ hasShifts: true, redExceptions: 0, planTempCount: 2, currentGapTotal: 2, readinessLevels: ["BLOCKED"] })).toBe("INSTAWORK_REQUIRED");
  });
  it("PARTIALLY_STAFFED when a non-temp gap remains and no RED", () => {
    expect(computeStaffingHealth({ hasShifts: true, redExceptions: 0, planTempCount: 0, currentGapTotal: 1, readinessLevels: ["UNVERIFIED"] })).toBe("PARTIALLY_STAFFED");
  });
  it("READY when fully staffed and every shift is READY", () => {
    expect(computeStaffingHealth({ hasShifts: true, redExceptions: 0, planTempCount: 0, currentGapTotal: 0, readinessLevels: ["READY", "READY"] })).toBe("READY");
  });
  it("FULLY_STAFFED when staffed but not every shift is READY yet", () => {
    expect(computeStaffingHealth({ hasShifts: true, redExceptions: 0, planTempCount: 0, currentGapTotal: 0, readinessLevels: ["READY", "UNVERIFIED"] })).toBe("FULLY_STAFFED");
  });
});

describe("moveEligibility", () => {
  const win = { startMs: 1000, endMs: 2000 };

  it("good-fit: qualified prep, free window", () => {
    expect(moveEligibility({ workerRole: "prep", targetRole: "field", routeWindow: win, workerBusyWindows: [] }).fit).toBe("good-fit");
  });
  it("qualification-mismatch: office/other cannot fill a field seat", () => {
    expect(moveEligibility({ workerRole: "other", targetRole: "field", routeWindow: win, workerBusyWindows: [] }).fit).toBe("qualification-mismatch");
  });
  it("exceeds-availability: qualified but busy overlapping the route window", () => {
    expect(moveEligibility({ workerRole: "prep", targetRole: "field", routeWindow: win, workerBusyWindows: [[1500, 2500]] }).fit).toBe("exceeds-availability");
  });
  it("good-fit when the window is unknown (no overlap to check) but qualified", () => {
    expect(moveEligibility({ workerRole: "prep", targetRole: "field", routeWindow: null, workerBusyWindows: [[1500, 2500]] }).fit).toBe("good-fit");
  });
  it("a non-overlapping busy window is still a good fit", () => {
    expect(moveEligibility({ workerRole: "prep", targetRole: "field", routeWindow: win, workerBusyWindows: [[2000, 3000]] }).fit).toBe("good-fit");
  });
});
