import { describe, it, expect } from "vitest";
import { saveLaborSnapshot, getLaborTrajectory } from "./laborHistory";

describe("labor trajectory — dedup + ordering", () => {
  it("writes on first + on change, skips identical, and returns oldest→newest", () => {
    const ws = "2026-08-30";
    // Planned only (early in the week — no actuals yet).
    expect(saveLaborSnapshot({ weekStart: ws, plannedHours: 100, plannedCost: 2000, actualHours: null, actualCost: null }, new Date("2026-08-30T08:00:00Z"))).toBe(true);
    // Same figures re-computed → no new snapshot.
    expect(saveLaborSnapshot({ weekStart: ws, plannedHours: 100, plannedCost: 2000, actualHours: null, actualCost: null }, new Date("2026-08-30T12:00:00Z"))).toBe(false);
    // Actuals start landing → change → new snapshot.
    expect(saveLaborSnapshot({ weekStart: ws, plannedHours: 100, plannedCost: 2000, actualHours: 40, actualCost: 820 }, new Date("2026-09-02T09:00:00Z"))).toBe(true);
    // Week closes out → actuals finalize.
    expect(saveLaborSnapshot({ weekStart: ws, plannedHours: 100, plannedCost: 2000, actualHours: 110, actualCost: 2250 }, new Date("2026-09-06T20:00:00Z"))).toBe(true);

    const traj = getLaborTrajectory(ws);
    expect(traj).toHaveLength(3);
    expect(traj.map((t) => t.actualCost)).toEqual([null, 820, 2250]); // planned → revised → actual
    expect(traj[0].capturedAt < traj[2].capturedAt).toBe(true);
  });

  it("keeps weeks separate", () => {
    saveLaborSnapshot({ weekStart: "2026-09-06", plannedHours: 50, plannedCost: 1000, actualHours: null, actualCost: null });
    expect(getLaborTrajectory("2026-09-06")).toHaveLength(1);
  });
});
