import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate a throwaway DB so the staff_shifts + shift_assignments tables + migrations run end-to-end.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-assign-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Import AFTER the env is set so getDb() opens the throwaway file.
async function mods() {
  const store = await import("./store");
  const assign = await import("./assignments");
  return { ...store, ...assign };
}

const nameOf = (uid: number): string => `User ${uid}`;

describe("syncInternalAssignments (live dual-write)", () => {
  it("creates one internal row per assignee, idempotently", async () => {
    const m = await mods();
    const shift = m.createShift({ date: "2026-10-10", role: "driver", headcount: 2, routeId: "R1" });
    const r1 = m.syncInternalAssignments(shift, [101, 102], nameOf);
    expect(r1).toEqual({ created: 2, removed: 0 });

    let rows = m.getAssignmentsForShift(shift.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((a) => a.workerKind === "internal" && a.state === "ASSIGNED")).toBe(true);
    expect(rows.map((a) => a.connecteamUserId).sort()).toEqual([101, 102]);
    expect(rows.find((a) => a.connecteamUserId === 101)?.displayName).toBe("User 101");

    // Re-running with the same set is a no-op (no dup rows).
    const r2 = m.syncInternalAssignments(shift, [101, 102], nameOf);
    expect(r2).toEqual({ created: 0, removed: 0 });
    rows = m.getAssignmentsForShift(shift.id);
    expect(rows).toHaveLength(2);
  });

  it("marks a dropped worker REPLACED and keeps a single row (no dup on re-add)", async () => {
    const m = await mods();
    const shift = m.createShift({ date: "2026-10-11", role: "field", headcount: 2, routeId: "R2" });
    m.syncInternalAssignments(shift, [201, 202], nameOf);

    // Drop 202.
    const dropped = m.syncInternalAssignments(shift, [201], nameOf);
    expect(dropped.removed).toBe(1);
    let rows = m.getAssignmentsForShift(shift.id);
    expect(rows.find((a) => a.connecteamUserId === 202)?.state).toBe("REPLACED");
    expect(rows.filter((a) => a.state === "ASSIGNED")).toHaveLength(1);

    // Re-add 202 → revived, not duplicated.
    const readd = m.syncInternalAssignments(shift, [201, 202], nameOf);
    expect(readd.created).toBe(1);
    rows = m.getAssignmentsForShift(shift.id);
    expect(rows).toHaveLength(2); // still two rows total (202 reused)
    expect(rows.find((a) => a.connecteamUserId === 202)?.state).toBe("ASSIGNED");
  });

  it("records an append-only event per assignment", async () => {
    const m = await mods();
    const shift = m.createShift({ date: "2026-10-12", role: "driver", headcount: 1, routeId: "R3" });
    m.syncInternalAssignments(shift, [301], nameOf, "Dispatcher A");
    const events = m.getShiftEvents(shift.id);
    expect(events.some((e) => e.kind === "assigned" && e.actor === "Dispatcher A")).toBe(true);
  });
});

describe("syncInstaworkAssignments (booked snapshot)", () => {
  it("creates instawork rows from booked names and drops a departed name", async () => {
    const m = await mods();
    const shift = m.createShift({ date: "2026-10-13", role: "field", headcount: 2, routeId: "R4" });
    const r1 = m.syncInstaworkAssignments(shift, { gigId: "G1", workers: ["Alex P", "Sam R"] });
    expect(r1.created).toBe(2);
    let rows = m.getAssignmentsForShift(shift.id);
    expect(rows.every((a) => a.workerKind === "instawork" && a.clockSource === "unavailable")).toBe(true);

    // Sam R drops off the fresh snapshot.
    const r2 = m.syncInstaworkAssignments(shift, { gigId: "G1", workers: ["Alex P"] });
    expect(r2.removed).toBe(1);
    rows = m.getAssignmentsForShift(shift.id);
    expect(rows.find((a) => a.instaworkWorker === "Sam R")?.state).toBe("REPLACED");
  });
});
