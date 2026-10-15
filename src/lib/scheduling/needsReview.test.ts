import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrewMember, CrewShift, PublishShiftInput, PublishShiftResult, Scheduler } from "@/lib/connecteam";
import type { StaffShift } from "./types";
import { buildConflictViews, planResolve } from "./needsReview";

const DATE = "2026-12-15";
const START = Math.floor(Date.parse(`${DATE}T14:00:00.000Z`) / 1000);
const END = Math.floor(Date.parse(`${DATE}T18:00:00.000Z`) / 1000);

function member(userId: number): CrewMember {
  return { userId, name: `U${userId}`, role: "driver" };
}
function crewShift(over: Partial<CrewShift> = {}): CrewShift {
  return { id: "ctX", schedulerId: 7, schedulerName: "Job", startUnix: START, endUnix: END, timezone: "America/New_York", isOpen: false, title: "Driver", assignees: [member(1)], ...over };
}
function staffShift(over: Partial<StaffShift> = {}): StaffShift {
  return {
    id: "SH-1", date: DATE, role: "driver", headcount: 1,
    startTime: `${DATE}T14:00:00.000Z`, endTime: `${DATE}T18:00:00.000Z`, windowKnown: true,
    location: null, routeId: null, truckId: null, eventLabel: "Smith Wedding", reasons: [], notes: null,
    source: "connecteam", status: "sent", assignees: [1], instaworkHeadcount: 0, payRate: null,
    connecteamShiftId: "ctX", connecteamSchedulerId: 7, connecteamPublishedAt: null,
    connecteamContentHash: "oldhash", connecteamSyncedAt: `${DATE}T10:00:00.000Z`, connecteamLastModified: `${DATE}T12:00:00.000Z`,
    syncStatus: "needs_review", syncNote: "Changed on both sides.",
    instaworkGigId: null, instaworkPostedAt: null,
    lifecycleState: null, supervisorUserId: null, reportLocation: null, reportTime: null, equipment: [], instructions: null,
    createdAt: `${DATE}T09:00:00.000Z`, updatedAt: `${DATE}T13:00:00.000Z`,
    ...over,
  };
}

describe("buildConflictViews (pure)", () => {
  it("shows app vs live Connecteam side by side, with the newer side marked", () => {
    const flagged = staffShift({ assignees: [1], updatedAt: `${DATE}T13:00:00.000Z` });
    const live = crewShift({ id: "ctX", assignees: [member(1), member(2)], lastModifiedUnix: Math.floor(Date.parse(`${DATE}T15:00:00.000Z`) / 1000) });
    const [v] = buildConflictViews({ flagged: [flagged], crewShifts: [live], reachable: true, nameOf: (u) => `Name${u}` });
    expect(v.connecteamLive).toBe(true);
    expect(v.app.assignees.map((a) => a.userId)).toEqual([1]);
    expect(v.connecteam!.assignees.map((a) => a.userId)).toEqual([1, 2]);
    expect(v.newerSide).toBe("connecteam"); // ct edited 15:00 > app 13:00
    expect(v.canKeepApp).toBe(true);
    expect(v.canKeepConnecteam).toBe(true);
    expect(v.syncNote).toContain("both sides");
  });

  it("Connecteam unreachable → no live side, keep-Connecteam disabled, stored snapshot shown", () => {
    const [v] = buildConflictViews({ flagged: [staffShift()], crewShifts: [], reachable: false, nameOf: () => null });
    expect(v.connecteam).toBeNull();
    expect(v.connecteamReachable).toBe(false);
    expect(v.canKeepConnecteam).toBe(false);
    expect(v.canKeepApp).toBe(false);
    expect(v.storedLastModified).toBe(`${DATE}T12:00:00.000Z`);
  });

  it("linked but vanished (reachable, no match) → keep-Connecteam still offered (accept removal)", () => {
    const [v] = buildConflictViews({ flagged: [staffShift({ connecteamShiftId: "ctGONE" })], crewShifts: [crewShift({ id: "ctOTHER" })], reachable: true, nameOf: () => null });
    expect(v.connecteamLive).toBe(false);
    expect(v.canKeepConnecteam).toBe(true); // accept-removal is a valid "keep Connecteam"
  });
});

describe("planResolve (pure)", () => {
  const live = { connecteamShiftId: "ctX" } as Pick<StaffShift, "connecteamShiftId">;
  const importable = { connecteamShiftId: "ctX", role: "driver", assignees: [1], contentHash: "h" } as never;

  it("keep Connecteam + live present → pull", () => {
    expect(planResolve({ shift: live, winner: "connecteam", reachable: true, live: importable }).kind).toBe("pull");
  });
  it("keep Connecteam + linked but vanished → accept_removal", () => {
    expect(planResolve({ shift: live, winner: "connecteam", reachable: true, live: null }).kind).toBe("accept_removal");
  });
  it("keep Connecteam while unreachable → error (never guesses)", () => {
    expect(planResolve({ shift: live, winner: "connecteam", reachable: false, live: null }).kind).toBe("error");
  });
  it("keep app + linked & live → push_update; unlinked → push_create", () => {
    expect(planResolve({ shift: live, winner: "app", reachable: true, live: importable }).kind).toBe("push_update");
    expect(planResolve({ shift: { connecteamShiftId: null }, winner: "app", reachable: true, live: null }).kind).toBe("push_create");
  });
});

// ── Effectful apply over a throwaway DB ─────────────────────────────────────────────────────────────
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-needsreview-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  delete process.env.CONNECTEAM_API_KEY;
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
  const nr = await import("./needsReview");
  return { ...store, ...nr };
}
const SCHEDULER: Scheduler = { schedulerId: 7, name: "Job", timezone: "America/New_York" };

describe("applyResolveAction (DB)", () => {
  it("keep Connecteam (pull): applies the Connecteam content and clears the flag", async () => {
    const { createShift, updateShift, getShiftById, applyResolveAction } = await mods();
    const s = createShift({ date: DATE, role: "driver", headcount: 1, startTime: `${DATE}T14:00:00.000Z`, endTime: `${DATE}T18:00:00.000Z`, windowKnown: true, assignees: [1], source: "connecteam" });
    updateShift(s.id, { syncStatus: "needs_review", syncNote: "conflict", connecteamShiftId: "ctX" });
    const fresh = getShiftById(s.id)!;
    const ct = { connecteamShiftId: "ctX", schedulerId: 7, date: DATE, role: "field" as const, headcount: 2, startTime: `${DATE}T15:00:00.000Z`, endTime: `${DATE}T19:00:00.000Z`, windowKnown: true, location: null, eventLabel: "New", assignees: [1, 2], isOpen: false, contentHash: "newhash", lastModifiedIso: `${DATE}T15:00:00.000Z` };
    const r = await applyResolveAction(fresh, { kind: "pull", ct }, { scheduler: null });
    expect(r.ok).toBe(true);
    const out = getShiftById(s.id)!;
    expect(out.syncStatus).toBe("synced");
    expect(out.syncNote).toBeNull();
    expect(out.assignees).toEqual([1, 2]);
    expect(out.role).toBe("field");
    expect(out.connecteamContentHash).toBe("newhash");
  });

  it("keep app (push_update): pushes via the injected updater (silent) and clears the flag", async () => {
    const { createShift, updateShift, getShiftById, applyResolveAction } = await mods();
    const s = createShift({ date: DATE, role: "driver", headcount: 1, startTime: `${DATE}T14:00:00.000Z`, endTime: `${DATE}T18:00:00.000Z`, windowKnown: true, assignees: [1], source: "connecteam" });
    updateShift(s.id, { syncStatus: "needs_review", connecteamShiftId: "ctX" });
    const updateFn = vi.fn(async (_i: PublishShiftInput & { shiftId: string }): Promise<PublishShiftResult> => ({ ok: true, shiftId: "ctX" }));
    const r = await applyResolveAction(getShiftById(s.id)!, { kind: "push_update" }, { scheduler: SCHEDULER, updateFn });
    expect(r.ok).toBe(true);
    expect(updateFn).toHaveBeenCalledOnce();
    expect(getShiftById(s.id)!.syncStatus).toBe("synced");
  });

  it("keep app leaves the flag in place when the Connecteam write fails (honest)", async () => {
    const { createShift, updateShift, getShiftById, applyResolveAction } = await mods();
    const s = createShift({ date: DATE, role: "driver", headcount: 1, startTime: `${DATE}T14:00:00.000Z`, endTime: `${DATE}T18:00:00.000Z`, windowKnown: true, assignees: [1], source: "connecteam" });
    updateShift(s.id, { syncStatus: "needs_review", connecteamShiftId: "ctX" });
    const updateFn = vi.fn(async (): Promise<PublishShiftResult> => ({ ok: false, error: "rejected" }));
    const r = await applyResolveAction(getShiftById(s.id)!, { kind: "push_update" }, { scheduler: SCHEDULER, updateFn });
    expect(r.ok).toBe(false);
    expect(getShiftById(s.id)!.syncStatus).toBe("needs_review"); // not cleared
  });

  it("accept_removal cancels the app shift and unlinks it", async () => {
    const { createShift, updateShift, getShiftById, applyResolveAction } = await mods();
    const s = createShift({ date: DATE, role: "driver", headcount: 1, startTime: `${DATE}T14:00:00.000Z`, endTime: `${DATE}T18:00:00.000Z`, windowKnown: true, assignees: [1], source: "connecteam" });
    updateShift(s.id, { syncStatus: "needs_review", connecteamShiftId: "ctGONE" });
    const r = await applyResolveAction(getShiftById(s.id)!, { kind: "accept_removal" }, { scheduler: null });
    expect(r.ok).toBe(true);
    const out = getShiftById(s.id)!;
    expect(out.status).toBe("cancelled");
    expect(out.connecteamShiftId).toBeNull();
    expect(out.syncStatus).toBe("synced");
  });
});
