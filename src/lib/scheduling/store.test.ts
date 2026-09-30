import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DemandShift } from "./types";

// Isolate a throwaway DB so the staff_shifts table + migrations run end-to-end.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-sched-"));
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
async function store() {
  return import("./store");
}

// A day's worth of demand: 2 driver shifts (event day) + 1 prep shift (day before, no routeId).
function demandFor(eventDate: string, prepDate: string): DemandShift[] {
  return [
    { date: eventDate, role: "driver", headcount: 1, startTime: `${eventDate}T14:00:00.000Z`, endTime: `${eventDate}T18:00:00.000Z`, windowKnown: true, location: "Warehouse", routeId: "R1", truckId: "NPR-1", eventLabel: "A", reasons: [] },
    { date: eventDate, role: "driver", headcount: 1, startTime: `${eventDate}T15:00:00.000Z`, endTime: `${eventDate}T19:00:00.000Z`, windowKnown: true, location: "Warehouse", routeId: "R2", truckId: "E450", eventLabel: "B", reasons: [] },
    { date: prepDate, role: "prep", headcount: 2, startTime: null, endTime: null, windowKnown: false, location: "Warehouse", eventLabel: `Prep for ${eventDate}`, reasons: ["2 delivery routes"] },
  ];
}

describe("syncDemand idempotency", () => {
  const EVENT = "2026-11-07";
  const PREP = "2026-11-06";

  it("materializes driver + prep shifts on their own dates", async () => {
    const { syncDemand, getShiftsForDate } = await store();
    syncDemand(EVENT, demandFor(EVENT, PREP));
    expect(getShiftsForDate(EVENT).filter((s) => s.role === "driver")).toHaveLength(2);
    expect(getShiftsForDate(PREP).filter((s) => s.role === "prep")).toHaveLength(1);
  });

  it("re-running does NOT duplicate the cross-day prep shift", async () => {
    const { syncDemand, getShiftsForDate } = await store();
    // Run three more times — the classic bug spawned a new prep row on the prior day each run.
    syncDemand(EVENT, demandFor(EVENT, PREP));
    syncDemand(EVENT, demandFor(EVENT, PREP));
    syncDemand(EVENT, demandFor(EVENT, PREP));
    expect(getShiftsForDate(EVENT).filter((s) => s.role === "driver")).toHaveLength(2);
    expect(getShiftsForDate(PREP).filter((s) => s.role === "prep")).toHaveLength(1);
  });

  it("refreshes a derived draft's headcount but leaves a human-touched shift alone", async () => {
    const { syncDemand, getShiftsForDate, updateShift } = await store();
    // Human assigns crew to the prep shift → it must be frozen against refresh.
    const prep = getShiftsForDate(PREP).find((s) => s.role === "prep")!;
    updateShift(prep.id, { assignees: [111] });

    // New demand bumps prep to 3 — but the human-touched row keeps its count.
    const bumped = demandFor(EVENT, PREP).map((d) => (d.role === "prep" ? { ...d, headcount: 3 } : d));
    syncDemand(EVENT, bumped);
    const after = getShiftsForDate(PREP).find((s) => s.role === "prep")!;
    expect(after.headcount).toBe(2); // unchanged — human is working on it
    expect(after.assignees).toEqual([111]);
    expect(getShiftsForDate(PREP).filter((s) => s.role === "prep")).toHaveLength(1);
  });
});
