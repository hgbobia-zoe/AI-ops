import { describe, it, expect } from "vitest";
import { summarizeConnecteamSchedule, connecteamScheduleHeadline } from "./connecteamSchedule";
import type { CrewMember, CrewRole, CrewShift } from "@/lib/connecteam";

function member(userId: number, name: string, role: CrewRole, title?: string): CrewMember {
  return { userId, name, role, title };
}

function shift(p: Partial<CrewShift> & { id: string; assignees: CrewMember[] }): CrewShift {
  return {
    schedulerId: 1,
    schedulerName: "Job Scheduler",
    startUnix: 1_760_000_000,
    endUnix: 1_760_028_800, // +8h
    timezone: "America/New_York",
    isOpen: false,
    title: "Delivery",
    jobId: undefined,
    address: undefined,
    ...p,
  };
}

describe("summarizeConnecteamSchedule", () => {
  it("reports UNKNOWN (never a fabricated zero) when Connecteam is unreachable", () => {
    const s = summarizeConnecteamSchedule({ ok: false, shifts: [] });
    expect(s.reachable).toBe(false);
    expect(s.totalScheduled).toBe(0);
    expect(s.people).toEqual([]);
    expect(s.byRole).toEqual({ driver: 0, warehouse: 0, prep: 0, other: 0 });
  });

  it("counts every scheduled person across all roles, including the catch-all 'other' (the undercount bug)", () => {
    const summary = summarizeConnecteamSchedule({
      ok: true,
      shifts: [
        shift({ id: "a", assignees: [member(1, "Joel D", "driver", "Driver")] }),
        shift({ id: "b", assignees: [member(2, "Adrane W", "warehouse", "Warehouse Associate")] }),
        // An office/unusual title lands in "other" — the old headline dropped these entirely.
        shift({ id: "c", assignees: [member(3, "Lisa M", "other", "Operations Coordinator")] }),
      ],
    });
    expect(summary.reachable).toBe(true);
    expect(summary.totalScheduled).toBe(3);
    expect(summary.byRole).toEqual({ driver: 1, warehouse: 1, prep: 0, other: 1 });
    expect(summary.people.map((p) => p.name)).toEqual(["Adrane W", "Joel D", "Lisa M"]);
  });

  it("collapses a person on several shifts into one row carrying all windows, earliest first", () => {
    const summary = summarizeConnecteamSchedule({
      ok: true,
      shifts: [
        shift({ id: "pm", assignees: [member(1, "Joel D", "driver")], startUnix: 200, endUnix: 300 }),
        shift({ id: "am", assignees: [member(1, "Joel D", "driver")], startUnix: 100, endUnix: 150 }),
      ],
    });
    expect(summary.totalScheduled).toBe(1);
    const joel = summary.people[0];
    expect(joel.windows.map((w) => w.start)).toEqual([100, 200]);
  });

  it("counts open (unassigned) shifts but adds no person for them", () => {
    const summary = summarizeConnecteamSchedule({
      ok: true,
      shifts: [
        shift({ id: "open1", assignees: [], isOpen: true }),
        shift({ id: "open2", assignees: [], isOpen: true }),
        shift({ id: "filled", assignees: [member(1, "Joel D", "driver")] }),
      ],
    });
    expect(summary.openShiftCount).toBe(2);
    expect(summary.totalScheduled).toBe(1);
  });

  it("drops a shift's window when its times are not usable, but still keeps the person", () => {
    const summary = summarizeConnecteamSchedule({
      ok: true,
      shifts: [shift({ id: "x", assignees: [member(5, "No Time", "prep")], startUnix: 500, endUnix: 400 })],
    });
    expect(summary.totalScheduled).toBe(1);
    expect(summary.people[0].windows).toEqual([]);
  });
});

describe("connecteamScheduleHeadline", () => {
  it("is honest (not 'nobody') when unreachable", () => {
    const h = connecteamScheduleHeadline(summarizeConnecteamSchedule({ ok: false, shifts: [] }));
    expect(h).toContain("unverified");
    expect(h).not.toContain("nobody scheduled for this day");
  });

  it("names the accurate total and every role present (other shown only when there are any)", () => {
    const h = connecteamScheduleHeadline(
      summarizeConnecteamSchedule({
        ok: true,
        shifts: [
          shift({ id: "a", assignees: [member(1, "D1", "driver")] }),
          shift({ id: "b", assignees: [member(2, "P1", "prep")] }),
          shift({ id: "c", assignees: [member(3, "O1", "other")] }),
        ],
      }),
    );
    expect(h).toBe("Connecteam today: 3 scheduled (1 driver, 1 prep, 1 other).");
  });

  it("omits the 'other' clause when there are none", () => {
    const h = connecteamScheduleHeadline(
      summarizeConnecteamSchedule({
        ok: true,
        shifts: [shift({ id: "a", assignees: [member(1, "D1", "driver"), member(2, "D2", "driver")] })],
      }),
    );
    expect(h).toBe("Connecteam today: 2 scheduled (2 drivers, 0 prep).");
  });

  it("says nobody scheduled only when truly empty and reachable", () => {
    const h = connecteamScheduleHeadline(summarizeConnecteamSchedule({ ok: true, shifts: [] }));
    expect(h).toContain("nobody scheduled");
  });
});
