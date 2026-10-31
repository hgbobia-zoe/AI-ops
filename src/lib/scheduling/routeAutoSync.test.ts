import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrewMember, CrewShift, PublishShiftInput, PublishShiftResult, Scheduler } from "@/lib/connecteam";
import type { Route } from "@/lib/types";
import { formatYmdLong } from "@/lib/dates";

// Capture the Slack bot cards so a test can assert their fields (e.g. the Day) without a webhook. appUrl is
// re-exported so the announcement's link still renders.
type BotCard = { title?: string; fields?: Array<{ label: string; value: string }> };
const { announces } = vi.hoisted(() => ({ announces: [] as BotCard[] }));
vi.mock("@/lib/notify/aiBots", () => ({
  botAnnounce: (_channel: string, card: BotCard) => {
    announces.push(card);
    return Promise.resolve();
  },
  appUrl: (p: string) => `https://app.test${p}`,
}));

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

const START_UNIX = Math.floor(Date.parse(START) / 1000);
const END_UNIX = Math.floor(Date.parse(END) / 1000);

function ctMember(userId: number): CrewMember {
  return { userId, name: `U${userId}`, role: "other" };
}

/** A live Connecteam shift for the push-matcher tests. Defaults: the START..END window, one assignee. */
function crewShift(assigneeIds: number[], over: Partial<CrewShift> = {}): CrewShift {
  return {
    id: "ct-x",
    schedulerId: 7,
    schedulerName: "Job Scheduler",
    startUnix: START_UNIX,
    endUnix: END_UNIX,
    timezone: "America/New_York",
    isOpen: false,
    title: "Zoe Event Rentals",
    assignees: assigneeIds.map(ctMember),
    ...over,
  };
}

describe("planRouteConnecteamCreate (pure)", () => {
  it("CREATES for a route shift whose crew are NOT in Connecteam; ADOPTS the worker's existing shift", async () => {
    const { createShift, getShiftsForDate, planRouteConnecteamCreate } = await mods();
    createShift({ date: DATE, role: "driver", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rA", truckId: "E450", assignees: [500], source: "manual" });
    createShift({ date: DATE, role: "field", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rB", truckId: "E450", assignees: [600], source: "manual" });
    const shifts = getShiftsForDate(DATE);

    // 600 already has a Connecteam shift that day; 500 does not.
    const plan = planRouteConnecteamCreate({ appShifts: shifts, crew: [crewShift([600], { id: "ct-600" })] });
    const shift500 = shifts.find((s) => s.assignees.includes(500))!;
    const shift600 = shifts.find((s) => s.assignees.includes(600))!;
    expect(plan.creates.map((c) => c.shiftId)).toContain(shift500.id); // nobody in Connecteam -> create
    expect(plan.creates.map((c) => c.shiftId)).not.toContain(shift600.id); // already in Connecteam -> adopt, never create a duplicate
    expect(plan.adopts.map((a) => a.shiftId)).toContain(shift600.id);
    expect(plan.adopts.find((a) => a.shiftId === shift600.id)!.connecteamShiftId).toBe("ct-600");
  });

  it("FLAGS (never creates) a route shift that holds ASSET-PREP crew — prep is not truck crew (the Raquel fix)", async () => {
    const { createShift, getShiftsForDate, planRouteConnecteamCreate } = await mods();
    // A field (delivery-helper) route seat whose assignee is an Event Asset Processor ("prep"). Nobody is in
    // Connecteam yet, so without the 4th chokepoint this would silently CREATE a truck shift (wrong pay).
    const s = createShift({ date: DATE, role: "field", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rPrep", truckId: "E450", assignees: [4242], source: "manual" });
    const plan = planRouteConnecteamCreate({
      appShifts: getShiftsForDate(DATE).filter((x) => x.id === s.id),
      crew: [],
      crewRoleOf: (u) => (u === 4242 ? "prep" : null),
    });
    expect(plan.creates).toHaveLength(0);
    expect(plan.adopts).toHaveLength(0);
    expect(plan.flags.map((f) => f.shiftId)).toContain(s.id); // held for a human, not cemented into Connecteam
  });

  it("still CREATES for a WAREHOUSE associate on a field seat (they ride as a delivery helper)", async () => {
    const { createShift, getShiftsForDate, planRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "field", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rWh", truckId: "E450", assignees: [4343], source: "manual" });
    const plan = planRouteConnecteamCreate({
      appShifts: getShiftsForDate(DATE).filter((x) => x.id === s.id),
      crew: [],
      crewRoleOf: (u) => (u === 4343 ? "warehouse" : null),
    });
    expect(plan.creates.map((c) => c.shiftId)).toContain(s.id); // Warehouse Associate is truck crew → mirror it
    expect(plan.flags).toHaveLength(0);
  });

  it("does NOT block when the crew role is unknown (null → never fabricate an exclusion)", async () => {
    const { createShift, getShiftsForDate, planRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "driver", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rUnk", truckId: "E450", assignees: [4444], source: "manual" });
    const plan = planRouteConnecteamCreate({
      appShifts: getShiftsForDate(DATE).filter((x) => x.id === s.id),
      crew: [],
      crewRoleOf: () => null, // roster unreachable / title unknown
    });
    expect(plan.creates.map((c) => c.shiftId)).toContain(s.id);
    expect(plan.flags).toHaveLength(0);
  });

  it("FLAGS a mixed-presence route shift instead of auto-writing (uncertain -> record-only)", async () => {
    const { createShift, getShiftsForDate, planRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "field", headcount: 2, startTime: START, endTime: END, windowKnown: true, routeId: "rMix", truckId: "E450", assignees: [700, 701], source: "manual" });
    // 700 is on a Connecteam shift but 701 is not — no single shift holds both, so it stays mixed (flagged).
    const plan = planRouteConnecteamCreate({ appShifts: getShiftsForDate(DATE).filter((x) => x.id === s.id), crew: [crewShift([700], { id: "ct-700" })] });
    expect(plan.creates).toHaveLength(0);
    expect(plan.adopts).toHaveLength(0);
    expect(plan.flags).toHaveLength(1);
    expect(plan.flags[0].shiftId).toBe(s.id);
  });

  it("DEFERS a create with no window, and ignores already-linked / non-route shifts", async () => {
    const { createShift, updateShift, getShiftById, planRouteConnecteamCreate } = await mods();
    const noWin = createShift({ date: DATE, role: "driver", headcount: 1, windowKnown: false, routeId: "rNoWin", truckId: "E450", assignees: [800], source: "manual" });
    const linked = createShift({ date: DATE, role: "driver", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rLinked", truckId: "E450", assignees: [801], source: "manual" });
    updateShift(linked.id, { connecteamShiftId: "ct-existing" });
    const dayLevel = createShift({ date: DATE, role: "prep", headcount: 1, startTime: START, endTime: END, windowKnown: true, assignees: [802], source: "manual" }); // no routeId
    const plan = planRouteConnecteamCreate({ appShifts: [getShiftById(noWin.id)!, getShiftById(linked.id)!, getShiftById(dayLevel.id)!], crew: [] });
    expect(plan.deferred.map((d) => d.shiftId)).toEqual([noWin.id]);
    expect(plan.creates).toHaveLength(0); // linked skipped, day-level (no route) skipped
    expect(plan.adopts).toHaveLength(0);
  });

  it("ADOPTS + no-shrink: UPDATES the worker's longer existing Connecteam shift instead of creating a truncated duplicate", async () => {
    const { createShift, getShiftById, planRouteConnecteamCreate, applyRouteConnecteamCreate } = await mods();
    // The app's per-route window is a truncated leg (14:00–18:00Z); the worker's real Connecteam shift runs
    // longer (14:00–21:30Z), like Lisa's "9:00a–3:30p Zoe Event Rentals" vs the app's "Field — …" leg.
    const CT_END = Math.floor(Date.parse(`${DATE}T21:30:00.000Z`) / 1000);
    const s = createShift({ date: DATE, role: "field", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rDup", truckId: "E450", assignees: [2000], source: "manual" });
    const existing = crewShift([2000], { id: "ct-existing-9", startUnix: START_UNIX, endUnix: CT_END });

    const plan = planRouteConnecteamCreate({ appShifts: [getShiftById(s.id)!], crew: [existing] });
    expect(plan.creates).toHaveLength(0); // NOT duplicated
    expect(plan.adopts).toHaveLength(1);
    expect(plan.adopts[0].connecteamShiftId).toBe("ct-existing-9");
    expect(plan.adopts[0].startUnix).toBe(START_UNIX); // same start
    expect(plan.adopts[0].endUnix).toBe(CT_END); // union keeps the LONGER human end (no-shrink / wrong-time fix)

    const publishUpdate = vi.fn(async (): Promise<PublishShiftResult> => ({ ok: true, shiftId: "ct-existing-9" }));
    const publish = vi.fn(async (): Promise<PublishShiftResult> => ({ ok: true, shiftId: "SHOULD-NOT-HAPPEN" }));
    const res = await applyRouteConnecteamCreate(plan, { scheduler: SCHEDULER, truckNameOf: () => "Truck", publish, publishUpdate });

    expect(res.adopted).toBe(1);
    expect(res.created).toBe(0);
    expect(publish).not.toHaveBeenCalled(); // never creates a second Connecteam shift
    expect(publishUpdate).toHaveBeenCalledOnce();
    const arg = publishUpdate.mock.calls[0][0] as PublishShiftInput & { shiftId: string };
    expect(arg.shiftId).toBe("ct-existing-9");
    expect(arg.endUnix).toBe(CT_END); // pushed the unioned (longer) window, not the truncated app end
    const linked = getShiftById(s.id)!;
    expect(linked.connecteamShiftId).toBe("ct-existing-9"); // app shift now LINKED to the existing one
    expect(linked.status).toBe("sent");
    expect(Date.parse(linked.endTime!)).toBe(CT_END * 1000); // and extended to the unioned end
    expect(linked.syncStatus).toBe("synced"); // re-baselined -> won't re-flag as a conflict
  });
});

describe("applyRouteAutoAssign (DB path, idempotent)", () => {
  it("creates the route+role shift and adds the assignee; re-running is a no-op", async () => {
    const { applyRouteAutoAssign, getShiftsForDate } = await mods();
    const plan = { reachable: true, autoAssign: [{ userId: 900, name: "Nine", routeId: "rAA", fillRole: "field" as const, reasons: [] }], prompt: [] };
    const routesById = new Map<string, Route>([["rAA", route("rAA")]]);

    const r1 = applyRouteAutoAssign(plan, { date: DATE, routesById, nameOf: () => null });
    expect(r1.assigned).toBe(1);
    // Returns the assignment detail for the Slack narration (who/role/route), carrying the decision reasons.
    expect(r1.assignments).toHaveLength(1);
    expect(r1.assignments[0]).toMatchObject({ userId: 900, name: "Nine", routeId: "rAA", fillRole: "field" });
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

describe("applyRouteWindowRatchet (shift follows the route; hours never auto-shrink)", () => {
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

  it("MOVES a shift later (keeps its hours) when Goodshuffle slid the route later", async () => {
    const m = await mods();
    const { applyRouteWindowRatchet } = await import("./routeAutoSync");
    // A route whose stops now sit in the late afternoon — well after a morning shift's 13:00 end.
    const laterRoute = (routeId: string): Route =>
      ({
        routeId,
        date: DATE,
        truckId: "E450",
        status: "planned",
        stops: [
          { sequence: 1, custName: "A", kind: "delivery", plannedWindow: `${DATE}T15:00:00.000Z` },
          { sequence: 2, custName: "B", kind: "delivery", plannedWindow: `${DATE}T18:00:00.000Z` },
        ],
      }) as unknown as Route;
    const s = m.createShift({ date: DATE, role: "driver", headcount: 1, startTime: `${DATE}T09:00:00.000Z`, endTime: `${DATE}T13:00:00.000Z`, windowKnown: true, routeId: "rLater", truckId: "E450", assignees: [12], source: "manual" });
    const beforeDur = Date.parse(s.endTime!) - Date.parse(s.startTime!);

    const n = await applyRouteWindowRatchet({ date: DATE, routesById: new Map([["rLater", laterRoute("rLater")]]), scheduler: null, truckNameOf: () => "Truck", nameOf: () => "Al", actor: "test" });
    expect(n).toBe(1);
    const after = m.getShiftById(s.id)!;
    // The block slid later to follow the route…
    expect(Date.parse(after.startTime!)).toBeGreaterThan(Date.parse(`${DATE}T09:00:00.000Z`));
    // …and the worker's hours were preserved, never auto-cut.
    expect(Date.parse(after.endTime!) - Date.parse(after.startTime!)).toBeGreaterThanOrEqual(beforeDur);
  });
});

describe("applyRouteConnecteamCreate (silent + honest)", () => {
  it("creates a SILENT Connecteam shift and stores the returned id (idempotent link)", async () => {
    const { createShift, getShiftById, applyRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "driver", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rCreate", truckId: "E450", assignees: [1000], source: "manual" });

    const publish = vi.fn(async (): Promise<PublishShiftResult> => ({ ok: true, shiftId: "ct-new-1" }));
    const res = await applyRouteConnecteamCreate(
      { creates: [{ shiftId: s.id }], adopts: [], flags: [], deferred: [], skipped: 0 },
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
    const res = await applyRouteConnecteamCreate({ creates: [{ shiftId: s.id }], adopts: [], flags: [], deferred: [], skipped: 0 }, { scheduler: SCHEDULER, truckNameOf: () => "Truck", publish });
    expect(res.failed).toBe(1);
    expect(res.created).toBe(0);
    expect(getShiftById(s.id)!.connecteamShiftId).toBeNull();
  });

  it("applies mixed-presence FLAGS as needs_review", async () => {
    const { createShift, getShiftById, applyRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "field", headcount: 2, startTime: START, endTime: END, windowKnown: true, routeId: "rFlag", truckId: "E450", assignees: [1200, 1201], source: "manual" });
    const res = await applyRouteConnecteamCreate({ creates: [], adopts: [], flags: [{ shiftId: s.id, note: "mixed" }], deferred: [], skipped: 0 }, { scheduler: SCHEDULER, truckNameOf: () => "Truck", publish: vi.fn() });
    expect(res.flagged).toBe(1);
    expect(getShiftById(s.id)!.syncStatus).toBe("needs_review");
  });

  it("announces the DAY on a created Connecteam shift so the alert is trackable (bug: window had no date)", async () => {
    const { createShift, getShiftsForDate, planRouteConnecteamCreate, applyRouteConnecteamCreate } = await mods();
    const s = createShift({ date: DATE, role: "driver", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rDay", truckId: "E450", assignees: [9100], source: "manual" });
    const plan = planRouteConnecteamCreate({ appShifts: getShiftsForDate(DATE).filter((x) => x.id === s.id), crew: [] });
    announces.length = 0;
    const publish = vi.fn(async (): Promise<PublishShiftResult> => ({ ok: true, shiftId: "ct-day-1" }));
    await applyRouteConnecteamCreate(plan, { scheduler: SCHEDULER, truckNameOf: () => "Isuzu NPR 1", nameOf: () => "Pat", publish });
    const card = announces.find((c) => c.title === "Connecteam shift created");
    expect(card).toBeTruthy();
    expect(card!.fields?.find((f) => f.label === "Day")?.value).toBe(formatYmdLong(DATE));
  });

  it("ANNOUNCES the prep-on-a-truck hold (with the day) instead of silently creating it", async () => {
    const { createShift, getShiftById, applyRouteConnecteamCreate, NON_TRUCK_CREW_NOTE } = await mods();
    const s = createShift({ date: DATE, role: "field", headcount: 1, startTime: START, endTime: END, windowKnown: true, routeId: "rHold", truckId: "E450", assignees: [9200], source: "manual" });
    announces.length = 0;
    const publish = vi.fn(async (): Promise<PublishShiftResult> => ({ ok: true, shiftId: "SHOULD-NOT-HAPPEN" }));
    const res = await applyRouteConnecteamCreate(
      { creates: [], adopts: [], flags: [{ shiftId: s.id, note: NON_TRUCK_CREW_NOTE }], deferred: [], skipped: 0 },
      { scheduler: SCHEDULER, truckNameOf: () => "Isuzu NPR 1", nameOf: () => "Raquel", publish },
    );
    expect(res.flagged).toBe(1);
    expect(publish).not.toHaveBeenCalled(); // never created a truck shift for the prep worker
    expect(getShiftById(s.id)!.syncStatus).toBe("needs_review");
    const held = announces.find((c) => c.title === "Held a route shift for review");
    expect(held).toBeTruthy();
    expect(held!.fields?.find((f) => f.label === "Day")?.value).toBe(formatYmdLong(DATE));
  });
});

describe("planRouteDriverRowReconcile (pure) — route row ↔ driver staff_shift", () => {
  it("backfills the route driver from the shift assignee only when the route row is empty", async () => {
    const { planRouteDriverRowReconcile } = await mods();
    const sets = planRouteDriverRowReconcile([
      { routeId: "rEmpty", hasDriverRow: false, driverShiftAssignees: [42] }, // backfill from the shift
      { routeId: "rHasRow", hasDriverRow: true, driverShiftAssignees: [99] }, // explicit driver → never clobber
      { routeId: "rNoShift", hasDriverRow: false, driverShiftAssignees: [] }, // nothing to mirror
      { routeId: "rTwo", hasDriverRow: false, driverShiftAssignees: [7, 8] }, // first assignee wins
    ]);
    expect(sets).toEqual([
      { routeId: "rEmpty", userId: 42 },
      { routeId: "rTwo", userId: 7 },
    ]);
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
