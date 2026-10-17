import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishShiftInput, PublishShiftResult, Scheduler } from "@/lib/connecteam";
import type { Route } from "@/lib/types";

// Throwaway DB so staff_shifts + shift_assignments migrations run end-to-end (mirrors connecteamReconcile.test).
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-routesync-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  delete process.env.CONNECTEAM_API_KEY; // keep the tick "not configured" for the no-op test
  delete process.env.CONNECTEAM_AUTOSYNC_DISABLED;
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function mods() {
  const store = await import("./store");
  const sync = await import("./routeAutoSync");
  return { ...store, ...sync };
}

const DATE = "2026-12-10";
const START = `${DATE}T14:00:00.000Z`;
const END = `${DATE}T18:00:00.000Z`;
const SCHEDULER: Scheduler = { schedulerId: 7, name: "Job Scheduler", timezone: "America/New_York" };

function route(routeId: string, truckId = "E450"): Route {
  return { routeId, date: DATE, truckId, status: "planned", stops: [] } as unknown as Route;
}

describe("planRouteConnecteamCreate (pure)", () => {
  it("CREATES for a route shift whose crew are NOT in Connecteam; SKIPS when all already are", async () => {
    const { createShift, getShiftsForDate, planRouteConnecteamCreate } = await mods();
    createShift({ date: DATE, role: "driver", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rA", truckId: "E450", assignees: [500], source: "manual" });
    createShift({ date: DATE, role: "field", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rB", truckId: "E450", assignees: [600], source: "manual" });
    const shifts = getShiftsForDate(DATE);

    // 600 is in Connecteam, 500 is not.
    const plan = planRouteConnecteamCreate({ appShifts: shifts, connecteamUserIds: [600] });
    const createdIds = plan.creates.map((c) => c.shiftId);
    const shift500 = shifts.find((s) => s.assignees.includes(500))!;
    const shift600 = shifts.find((s) => s.assignees.includes(600))!;
    expect(createdIds).toContain(shift500.id); // nobody in Connecteam -> create
    expect(createdIds).not.toContain(shift600.id); // already in Connecteam -> skip
    expect(plan.skipped).toBe(1);
  });

  it("FLAGS a mixed-presence route shift instead of auto-writing (uncertain -> record-only)", async () => {
    const { createShift, getShiftsForDate, planRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "field", headcount: 2, startTime: START, endTime: END, windowKnown: true, routeId: "rMix", truckId: "E450", assignees: [700, 701], source: "manual" });
    const plan = planRouteConnecteamCreate({ appShifts: getShiftsForDate(DATE).filter((x) => x.id === s.id), connecteamUserIds: [700] });
    expect(plan.creates).toHaveLength(0);
    expect(plan.flags).toHaveLength(1);
    expect(plan.flags[0].shiftId).toBe(s.id);
  });

  it("DEFERS a create with no window, and ignores already-linked / non-route shifts", async () => {
    const { createShift, updateShift, getShiftById, planRouteConnecteamCreate } = await mods();
    const noWin = createShift({ date: DATE, role: "driver", headcount: 1, windowKnown: false, routeId: "rNoWin", truckId: "E450", assignees: [800], source: "manual" });
    const linked = createShift({ date: DATE, role: "driver", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rLinked", truckId: "E450", assignees: [801], source: "manual" });
    updateShift(linked.id, { connecteamShiftId: "ct-existing" });
    const dayLevel = createShift({ date: DATE, role: "prep", headcount: 1, startTime: START, endTime: END, windowKnown: true, assignees: [802], source: "manual" }); // no routeId
    const plan = planRouteConnecteamCreate({ appShifts: [getShiftById(noWin.id)!, getShiftById(linked.id)!, getShiftById(dayLevel.id)!], connecteamUserIds: [] });
    expect(plan.deferred.map((d) => d.shiftId)).toEqual([noWin.id]);
    expect(plan.creates).toHaveLength(0); // linked skipped, day-level (no route) skipped
  });
});

describe("applyRouteAutoAssign (DB path, idempotent)", () => {
  it("creates the route+role shift and adds the assignee; re-running is a no-op", async () => {
    const { applyRouteAutoAssign, getShiftsForDate } = await mods();
    const plan = { reachable: true, autoAssign: [{ userId: 900, name: "Nine", routeId: "rAA", fillRole: "field" as const, reasons: [] }], prompt: [] };
    const routesById = new Map<string, Route>([["rAA", route("rAA")]]);

    const r1 = applyRouteAutoAssign(plan, { date: DATE, routesById, nameOf: () => null });
    expect(r1.assigned).toBe(1);
    const after = getShiftsForDate(DATE).filter((s) => s.routeId === "rAA");
    expect(after).toHaveLength(1);
    expect(after[0].role).toBe("field");
    expect(after[0].assignees).toContain(900);

    // Re-run: person already on the seat -> skipped, no duplicate shift.
    const r2 = applyRouteAutoAssign(plan, { date: DATE, routesById, nameOf: () => null });
    expect(r2.assigned).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(getShiftsForDate(DATE).filter((s) => s.routeId === "rAA")).toHaveLength(1);
  });
});

describe("driver seniority routing → real assignment (DB)", () => {
  it("commits the senior driver to the specialty route and the newer driver to the easy route", async () => {
    const { applyRouteAutoAssign, getShiftsForDate } = await mods();
    const { resolveDriverSeniority } = await import("./driverSeniority");
    const T = 1_700_000_000; // same start time for both routes
    const plan = resolveDriverSeniority(
      [
        { userId: 11, name: "Senior", seniorityDate: "2019-01-01", eligibleRouteIds: ["rSpec", "rEasy"] },
        { userId: 12, name: "Newer", seniorityDate: "2024-01-01", eligibleRouteIds: ["rSpec", "rEasy"] },
      ],
      [
        { routeId: "rSpec", startUnix: T, driverGap: 1, difficulty: 3, specialty: true, reasons: ["large tent"] },
        { routeId: "rEasy", startUnix: T, driverGap: 1, difficulty: 0, specialty: false, reasons: [] },
      ],
    );
    const routesById = new Map<string, Route>([["rSpec", route("rSpec")], ["rEasy", route("rEasy")]]);
    const res = applyRouteAutoAssign({ reachable: true, autoAssign: plan.autoAssign, prompt: [] }, { date: DATE, routesById, nameOf: () => null });
    expect(res.assigned).toBe(2);
    const shifts = getShiftsForDate(DATE);
    expect(shifts.find((s) => s.routeId === "rSpec" && s.role === "driver")?.assignees).toContain(11); // senior → specialty
    expect(shifts.find((s) => s.routeId === "rEasy" && s.role === "driver")?.assignees).toContain(12); // newer → easy
  });
});

describe("applyRouteWindowRatchet (route grew → shift grows; shorter → holds)", () => {
  // A route whose stops span 9:00–17:00, so its own window is well past a short shift's 12:00 end.
  const wideRoute = (routeId: string): Route =>
    ({
      routeId,
      date: DATE,
      truckId: "E450",
      status: "planned",
      stops: [
        { sequence: 1, custName: "A", kind: "delivery", plannedWindow: `${DATE}T09:00:00.000Z` },
        { sequence: 2, custName: "B", kind: "delivery", plannedWindow: `${DATE}T17:00:00.000Z` },
      ],
    }) as unknown as Route;

  it("expands an unlinked route shift when the route runs longer, and announces it", async () => {
    const m = await mods();
    const { applyRouteWindowRatchet } = await import("./routeAutoSync");
    const short = m.createShift({ date: DATE, role: "driver", headcount: 1, startTime: `${DATE}T10:00:00.000Z`, endTime: `${DATE}T12:00:00.000Z`, windowKnown: true, routeId: "rGrow", truckId: "E450", assignees: [10], source: "manual" });

    const n = await applyRouteWindowRatchet({ date: DATE, routesById: new Map([["rGrow", wideRoute("rGrow")]]), scheduler: null, truckNameOf: () => "Truck", nameOf: () => "Al", actor: "test" });
    expect(n).toBe(1);
    const after = m.getShiftById(short.id)!;
    expect(Date.parse(after.endTime!)).toBeGreaterThan(Date.parse(`${DATE}T12:00:00.000Z`)); // grew to cover the longer route
  });

  it("HOLDS a shift that already covers the route (never shrinks)", async () => {
    const m = await mods();
    const { applyRouteWindowRatchet } = await import("./routeAutoSync");
    const wide = m.createShift({ date: DATE, role: "driver", headcount: 1, startTime: `${DATE}T06:00:00.000Z`, endTime: `${DATE}T23:00:00.000Z`, windowKnown: true, routeId: "rHold", truckId: "E450", assignees: [11], source: "manual" });

    const n = await applyRouteWindowRatchet({ date: DATE, routesById: new Map([["rHold", wideRoute("rHold")]]), scheduler: null, truckNameOf: () => "Truck", nameOf: () => "Al", actor: "test" });
    expect(n).toBe(0);
    const after = m.getShiftById(wide.id)!;
    expect(after.endTime).toBe(`${DATE}T23:00:00.000Z`); // unchanged
    expect(after.startTime).toBe(`${DATE}T06:00:00.000Z`);
  });
});

describe("applyRouteConnecteamCreate (silent + honest)", () => {
  it("creates a SILENT Connecteam shift and stores the returned id (idempotent link)", async () => {
    const { createShift, getShiftById, applyRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "driver", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rCreate", truckId: "E450", assignees: [1000], source: "manual" });

    const publish = vi.fn(async (_input: PublishShiftInput): Promise<PublishShiftResult> => ({ ok: true, shiftId: "ct-new-1" }));
    const res = await applyRouteConnecteamCreate(
      { creates: [{ shiftId: s.id }], flags: [], deferred: [], skipped: 0 },
      { scheduler: SCHEDULER, truckNameOf: () => "Truck", publish },
    );
    expect(res.created).toBe(1);
    expect(publish).toHaveBeenCalledOnce();
    const linked = getShiftById(s.id)!;
    expect(linked.connecteamShiftId).toBe("ct-new-1");
    expect(linked.connecteamSchedulerId).toBe(7);
    expect(linked.status).toBe("sent");
  });

  it("leaves the app shift UNLINKED when Connecteam rejects (honest, retry next cycle)", async () => {
    const { createShift, getShiftById, applyRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "driver", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rFail", truckId: "E450", assignees: [1100], source: "manual" });
    const publish = vi.fn(async (): Promise<PublishShiftResult> => ({ ok: false, error: "Connecteam HTTP 500" }));
    const res = await applyRouteConnecteamCreate({ creates: [{ shiftId: s.id }], flags: [], deferred: [], skipped: 0 }, { scheduler: SCHEDULER, truckNameOf: () => "Truck", publish });
    expect(res.failed).toBe(1);
    expect(res.created).toBe(0);
    expect(getShiftById(s.id)!.connecteamShiftId).toBeNull();
  });

  it("applies mixed-presence FLAGS as needs_review", async () => {
    const { createShift, getShiftById, applyRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "field", headcount: 2, startTime: START, endTime: END, windowKnown: true, routeId: "rFlag", truckId: "E450", assignees: [1200, 1201], source: "manual" });
    const res = await applyRouteConnecteamCreate({ creates: [], flags: [{ shiftId: s.id, note: "mixed" }], deferred: [], skipped: 0 }, { scheduler: SCHEDULER, truckNameOf: () => "Truck", publish: vi.fn() });
    expect(res.flagged).toBe(1);
    expect(getShiftById(s.id)!.syncStatus).toBe("needs_review");
  });
});

describe("runRouteAutoSyncTick — honest when not configured / killed", () => {
  it("is a safe no-op when Connecteam is not configured", async () => {
    const { runRouteAutoSyncTick } = await mods();
    const r = await runRouteAutoSyncTick();
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("not configured");
    expect(r.autoAssigned + r.ctCreated).toBe(0);
  });

  it("is disabled by the CONNECTEAM_AUTOSYNC_DISABLED kill switch", async () => {
    const { runRouteAutoSyncTick, connecteamAutosyncEnabled } = await mods();
    process.env.CONNECTEAM_API_KEY = "k";
    process.env.CONNECTEAM_AUTOSYNC_DISABLED = "1";
    expect(connecteamAutosyncEnabled()).toBe(false);
    const r = await runRouteAutoSyncTick();
    expect(r.detail).toBe("autosync disabled");
    delete process.env.CONNECTEAM_API_KEY;
    delete process.env.CONNECTEAM_AUTOSYNC_DISABLED;
  });
});
