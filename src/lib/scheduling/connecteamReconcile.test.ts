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
