import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrewShift, CrewMember } from "@/lib/connecteam";

// Throwaway DB so the staff_shifts table + migrations run end-to-end (mirrors store.test.ts).
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-ctsync-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  delete process.env.CONNECTEAM_API_KEY; // keep the importer "not configured" for the tick test
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
  const reconcile = await import("./connecteamReconcile");
  const planner = await import("./connecteamImport");
  return { ...store, ...reconcile, ...planner };
}

const DATE = "2026-12-05";
const START = Math.floor(Date.parse(`${DATE}T14:00:00.000Z`) / 1000);
const END = Math.floor(Date.parse(`${DATE}T18:00:00.000Z`) / 1000);

function member(userId: number): CrewMember {
  return { userId, name: `U${userId}`, role: "driver" };
}
function crewShift(over: Partial<CrewShift> = {}): CrewShift {
  return {
    id: "ctA",
    schedulerId: 7,
    schedulerName: "Job Scheduler",
    startUnix: START,
    endUnix: END,
    timezone: "America/New_York",
    isOpen: false,
    title: "Driver",
    assignees: [member(201)],
    ...over,
  };
}

describe("applyReconcilePlan — create + idempotency", () => {
  it("imports a Connecteam shift as an app shift, and re-running is a no-op", async () => {
    const { planReconcile, applyReconcilePlan, getShiftsForDate } = await mods();

    const read = () => getShiftsForDate(DATE);
    const plan1 = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [crewShift()] }, appShifts: read() });
    const r1 = applyReconcilePlan(plan1);
    expect(r1.created).toBe(1);

    const imported = read();
    expect(imported).toHaveLength(1);
    expect(imported[0].source).toBe("connecteam");
    expect(imported[0].status).toBe("sent");
    expect(imported[0].connecteamShiftId).toBe("ctA");
    expect(imported[0].assignees).toEqual([201]);
    expect(imported[0].routeId).toBeNull(); // day-level, never a route guess
    expect(imported[0].syncStatus).toBe("synced");

    // Re-run with the SAME Connecteam state -> no new shift, no change (idempotent).
    const plan2 = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [crewShift()] }, appShifts: read() });
    const r2 = applyReconcilePlan(plan2);
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(1);
    expect(read()).toHaveLength(1);
  });

  it("propagates a Connecteam change onto the linked app shift (Connecteam wins)", async () => {
    const { planReconcile, applyReconcilePlan, getShiftsForDate } = await mods();
    const read = () => getShiftsForDate(DATE);
    const after = read().find((s) => s.connecteamShiftId === "ctA")!;
    expect(after).toBeTruthy();

    // Connecteam adds a second assignee; app not touched locally -> update applies.
    const changed = crewShift({ assignees: [member(201), member(202)] });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [changed] }, appShifts: read() });
    const r = applyReconcilePlan(plan);
    expect(r.updated).toBe(1);
    expect(read().find((s) => s.connecteamShiftId === "ctA")!.assignees).toEqual([201, 202]);

    // And re-running after the update is again a no-op.
    const plan2 = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [changed] }, appShifts: read() });
    expect(applyReconcilePlan(plan2).unchanged).toBe(1);
  });

  it("flags a vanished Connecteam copy needs_review WITHOUT deleting the app shift", async () => {
    const { planReconcile, applyReconcilePlan, getShiftsForDate } = await mods();
    const read = () => getShiftsForDate(DATE);
    const before = read();
    expect(before).toHaveLength(1);

    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [] }, appShifts: before });
    const r = applyReconcilePlan(plan);
    expect(r.flagged).toBe(1);

    const after = read();
    expect(after).toHaveLength(1); // not deleted
    expect(after[0].syncStatus).toBe("needs_review");
    expect(after[0].syncNote).toContain("no longer returned");
  });

  it("an unreachable read changes nothing", async () => {
    const { planReconcile, applyReconcilePlan, getShiftsForDate } = await mods();
    const read = () => getShiftsForDate(DATE);
    const before = JSON.stringify(read());
    const plan = planReconcile({ date: DATE, connecteam: { ok: false, shifts: [] }, appShifts: read() });
    const r = applyReconcilePlan(plan);
    expect(r.reachable).toBe(false);
    expect(r.created + r.updated + r.flagged).toBe(0);
    expect(JSON.stringify(read())).toBe(before);
  });
});

describe("runConnecteamImportTick — honest when not configured", () => {
  it("is a safe no-op when Connecteam is not configured", async () => {
    const { runConnecteamImportTick } = await mods();
    const r = await runConnecteamImportTick();
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("not configured");
    expect(r.created).toBe(0);
  });
});

describe("one shift, one record (re-link, merge, stale flags) and Connecteam edits as overrides", () => {
  const D2 = "2026-12-06";
  const S2 = Math.floor(Date.parse(`${D2}T14:00:00.000Z`) / 1000);
  const E2 = Math.floor(Date.parse(`${D2}T18:00:00.000Z`) / 1000);
  const ct = (id: string, people: number[], over: Partial<CrewShift> = {}): CrewShift => ({ ...crewShift({ id, startUnix: S2, endUnix: E2, assignees: people.map(member) }), ...over });

  it("re-links a shift whose Connecteam id changed (same person, same time) instead of importing a copy, and clears its flag", async () => {
    const m = await mods();
    const s = m.createShift({ date: D2, role: "driver", headcount: 1, startTime: `${D2}T14:00:00.000Z`, endTime: `${D2}T18:00:00.000Z`, windowKnown: true, routeId: "R-x", assignees: [301], source: "manual" });
    m.updateShift(s.id, { connecteamShiftId: "base1:old", connecteamSyncedAt: "2026-12-01T00:00:00.000Z", syncStatus: "needs_review", syncNote: m.VANISHED_NOTE, status: "sent" });
    const plan = m.planReconcile({ date: D2, connecteam: { ok: true, shifts: [ct("base1:new", [301])] }, appShifts: m.getShiftsForDate(D2) });
    expect(plan.creates).toHaveLength(0);
    expect(plan.relinks.map((r) => r.appShiftId)).toEqual([s.id]);
    const r = m.applyReconcilePlan(plan, "test", () => ({ start: null, end: null, known: false }));
    expect(r.relinked).toBe(1);
    expect(m.getShiftById(s.id)).toMatchObject({ connecteamShiftId: "base1:new", syncStatus: "synced", syncNote: null });
  });

  it("never re-links to a Connecteam shift for a different person at the same time", async () => {
    const m = await mods();
    const s = m.createShift({ date: D2, role: "driver", headcount: 1, startTime: `${D2}T14:00:00.000Z`, endTime: `${D2}T18:00:00.000Z`, windowKnown: true, assignees: [302], source: "manual" });
    m.updateShift(s.id, { connecteamShiftId: "base2:old", connecteamSyncedAt: "2026-12-01T00:00:00.000Z", status: "sent" });
    const plan = m.planReconcile({ date: D2, connecteam: { ok: true, shifts: [ct("base2:new", [999])] }, appShifts: m.getShiftsForDate(D2).filter((x) => x.id === s.id) });
    expect(plan.relinks).toHaveLength(0);
    expect(plan.flags.map((f) => f.reason)).toEqual(["connecteam_copy_vanished"]);
  });

  it("merges a route copy and an imported copy of one Connecteam shift: keeps the route copy on Connecteam's time as an override", async () => {
    const m = await mods();
    const D3 = "2026-12-07";
    const route = m.createShift({ date: D3, role: "field", headcount: 1, startTime: `${D3}T12:45:00.000Z`, endTime: `${D3}T22:00:00.000Z`, windowKnown: true, routeId: "R-y", assignees: [303], source: "derived" });
    m.updateShift(route.id, { connecteamShiftId: "ctDup", status: "sent", connecteamSyncedAt: "2026-12-01T00:00:00.000Z" });
    const imported = m.createIngestedShift({ date: D3, role: "prep", headcount: 1, startTime: `${D3}T13:00:00.000Z`, endTime: `${D3}T22:00:00.000Z`, windowKnown: true, location: null, eventLabel: null, assignees: [303], connecteamShiftId: "ctDup", connecteamSchedulerId: 7, connecteamContentHash: "h", connecteamLastModified: null, connecteamSyncedAt: "2026-12-01T00:00:00.000Z" });
    const live = crewShift({ id: "ctDup", startUnix: Date.parse(`${D3}T13:00:00.000Z`) / 1000, endUnix: Date.parse(`${D3}T22:00:00.000Z`) / 1000, assignees: [member(303)] });
    const plan = m.planReconcile({ date: D3, connecteam: { ok: true, shifts: [live] }, appShifts: m.getShiftsForDate(D3) });
    expect(plan.merges).toEqual([expect.objectContaining({ keepId: route.id, dropId: imported.id })]);
    const crew = { start: `${D3}T12:45:00.000Z`, end: `${D3}T22:00:00.000Z`, known: true };
    m.applyReconcilePlan(plan, "test", () => crew);
    expect(m.getShiftById(imported.id)).toMatchObject({ status: "cancelled", connecteamShiftId: null });
    const kept = m.getShiftById(route.id)!;
    expect(kept).toMatchObject({ startTime: `${D3}T13:00:00.000Z`, connecteamShiftId: "ctDup" });
    expect(kept.routeOverride).toMatchObject({ by: "Connecteam", source: "connecteam", routeStart: crew.start });
    // Idempotent: the next pass finds one record and nothing to merge.
    const again = m.planReconcile({ date: D3, connecteam: { ok: true, shifts: [live] }, appShifts: m.getShiftsForDate(D3) });
    expect(again.merges).toHaveLength(0);
    expect(again.creates).toHaveLength(0);
  });

  it("a time edited in Connecteam on a route shift becomes an override", async () => {
    const m = await mods();
    const D4 = "2026-12-08";
    const s = m.createShift({ date: D4, role: "driver", headcount: 1, startTime: `${D4}T12:45:00.000Z`, endTime: `${D4}T22:00:00.000Z`, windowKnown: true, routeId: "R-z", assignees: [304], source: "derived" });
    m.updateShift(s.id, { connecteamShiftId: "ctEdit", status: "sent", connecteamContentHash: "old-hash", connecteamSyncedAt: new Date(Date.now() + 60_000).toISOString() });
    const edited = crewShift({ id: "ctEdit", startUnix: Date.parse(`${D4}T13:00:00.000Z`) / 1000, endUnix: Date.parse(`${D4}T22:00:00.000Z`) / 1000, assignees: [member(304)] });
    const plan = m.planReconcile({ date: D4, connecteam: { ok: true, shifts: [edited] }, appShifts: m.getShiftsForDate(D4) });
    expect(plan.updates).toEqual([expect.objectContaining({ appShiftId: s.id, applyContent: true })]);
    m.applyReconcilePlan(plan, "test", () => ({ start: `${D4}T12:45:00.000Z`, end: `${D4}T22:00:00.000Z`, known: true }));
    expect(m.getShiftById(s.id)!.routeOverride).toMatchObject({ by: "Connecteam", source: "connecteam" });
  });
});
