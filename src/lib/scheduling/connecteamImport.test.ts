import { describe, expect, it } from "vitest";
import type { CrewShift, CrewMember } from "@/lib/connecteam";
import type { StaffShift } from "./types";
import { contentHashOf, matchConnecteamShiftForPush, normalizeForImport, planReconcile, shiftRoleFromCrewRole, unionPushWindowUnix } from "./connecteamImport";

const DATE = "2026-11-07";
// 2026-11-07T14:00:00Z / 18:00:00Z in Unix seconds.
const START = Math.floor(Date.parse(`${DATE}T14:00:00.000Z`) / 1000);
const END = Math.floor(Date.parse(`${DATE}T18:00:00.000Z`) / 1000);

function member(userId: number, role: CrewMember["role"], name = `U${userId}`): CrewMember {
  return { userId, name, role };
}

function crewShift(over: Partial<CrewShift> = {}): CrewShift {
  return {
    id: "ct1",
    schedulerId: 10,
    schedulerName: "Job Scheduler",
    startUnix: START,
    endUnix: END,
    timezone: "America/New_York",
    isOpen: false,
    title: "Driver",
    assignees: [member(101, "driver")],
    ...over,
  };
}

// A minimal app shift; override what a test needs.
function appShift(over: Partial<StaffShift> = {}): StaffShift {
  const now = "2026-10-15T12:00:00.000Z";
  return {
    id: "SH-1",
    date: DATE,
    role: "driver",
    headcount: 1,
    startTime: `${DATE}T14:00:00.000Z`,
    endTime: `${DATE}T18:00:00.000Z`,
    windowKnown: true,
    location: null,
    routeId: null,
    truckId: null,
    eventLabel: "Driver",
    reasons: [],
    notes: null,
    source: "connecteam",
    status: "sent",
    assignees: [101],
    instaworkHeadcount: 0,
    payRate: null,
    connecteamShiftId: "ct1",
    connecteamSchedulerId: 10,
    connecteamPublishedAt: null,
    connecteamContentHash: null,
    connecteamSyncedAt: null,
    connecteamLastModified: null,
    syncStatus: null,
    syncNote: null,
    instaworkGigId: null,
    instaworkPostedAt: null,
    lifecycleState: null,
    supervisorUserId: null,
    reportLocation: null,
    reportTime: null,
    equipment: [],
    instructions: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** The content hash the importer would store for a given CrewShift (for arranging test state). */
function hashFor(s: CrewShift): string {
  return normalizeForImport([s], DATE)[0].contentHash;
}

describe("shiftRoleFromCrewRole", () => {
  it("maps driver/prep straight and office/admin (other) -> office (non-crew)", () => {
    expect(shiftRoleFromCrewRole("driver")).toBe("driver");
    expect(shiftRoleFromCrewRole("prep")).toBe("prep");
    expect(shiftRoleFromCrewRole("other")).toBe("office");
  });
});

describe("contentHashOf", () => {
  it("is stable regardless of assignee order", () => {
    const a = contentHashOf({ startTime: "x", endTime: "y", title: "T", assignees: [3, 1, 2], isOpen: false });
    const b = contentHashOf({ startTime: "x", endTime: "y", title: "T", assignees: [1, 2, 3], isOpen: false });
    expect(a).toBe(b);
  });
  it("changes when a meaningful field changes", () => {
    const base = contentHashOf({ startTime: "x", endTime: "y", title: "T", assignees: [1], isOpen: false });
    expect(contentHashOf({ startTime: "x", endTime: "y", title: "T", assignees: [1, 2], isOpen: false })).not.toBe(base);
    expect(contentHashOf({ startTime: "z", endTime: "y", title: "T", assignees: [1], isOpen: false })).not.toBe(base);
  });
});

describe("matchConnecteamShiftForPush (the push de-dup matcher)", () => {
  const app = (assignees: number[], startTime: string | null = `${DATE}T14:00:00.000Z`, endTime: string | null = `${DATE}T18:00:00.000Z`) =>
    ({ assignees, startTime, endTime });

  it("matches on the assignee set regardless of title/role/window (worker-day is the stable key)", () => {
    // The app pushes a "Field" leg; the worker already has a "Zoe Event Rentals" shift. Different title, same person.
    const existing = crewShift({ id: "ct-human", title: "Zoe Event Rentals", assignees: [member(101, "other")] });
    expect(matchConnecteamShiftForPush(app([101]), [existing])?.id).toBe("ct-human");
  });

  it("returns null when no Connecteam shift holds all the app assignees (then the caller CREATES)", () => {
    const existing = crewShift({ id: "ct-a", assignees: [member(101, "driver")] });
    expect(matchConnecteamShiftForPush(app([999]), [existing])).toBeNull(); // different worker -> no match
    expect(matchConnecteamShiftForPush(app([101, 102]), [existing])).toBeNull(); // 102 not on it -> no match
    expect(matchConnecteamShiftForPush(app([]), [existing])).toBeNull(); // nobody to match
  });

  it("never matches an OPEN (unassigned) shift", () => {
    const open = crewShift({ id: "ct-open", isOpen: true, assignees: [] });
    expect(matchConnecteamShiftForPush(app([101]), [open])).toBeNull();
  });

  it("prefers a window-overlapping shift, then the earliest start (deterministic)", () => {
    const early = crewShift({ id: "ct-early", startUnix: START - 36_000, endUnix: START - 3_600, assignees: [member(101, "driver")] }); // no overlap
    const overlapping = crewShift({ id: "ct-overlap", startUnix: START, endUnix: END, assignees: [member(101, "driver")] });
    expect(matchConnecteamShiftForPush(app([101]), [early, overlapping])?.id).toBe("ct-overlap");
  });
});

describe("unionPushWindowUnix (no-shrink window)", () => {
  it("keeps the broadest of the app and Connecteam windows (never truncates a longer human shift)", () => {
    const ct = { startUnix: 1000, endUnix: 9000 };
    const appStart = new Date(2000 * 1000).toISOString();
    const appEnd = new Date(5000 * 1000).toISOString();
    expect(unionPushWindowUnix(appStart, appEnd, ct)).toEqual({ startUnix: 1000, endUnix: 9000 });
  });
  it("extends when the app window runs later/earlier than Connecteam", () => {
    const ct = { startUnix: 3000, endUnix: 4000 };
    expect(unionPushWindowUnix(new Date(1000 * 1000).toISOString(), new Date(9000 * 1000).toISOString(), ct)).toEqual({ startUnix: 1000, endUnix: 9000 });
  });
  it("falls back to the Connecteam window when the app window is unknown (never fabricates a time)", () => {
    const ct = { startUnix: 3000, endUnix: 4000 };
    expect(unionPushWindowUnix(null, null, ct)).toEqual({ startUnix: 3000, endUnix: 4000 });
  });
});

describe("normalizeForImport", () => {
  it("drops EXPLICIT drafts but keeps shifts with an absent published flag", () => {
    const published = crewShift({ id: "a", isPublished: true });
    const draft = crewShift({ id: "b", isPublished: false });
    const unknown = crewShift({ id: "c" }); // no flag
    const out = normalizeForImport([published, draft, unknown], DATE);
    expect(out.map((s) => s.connecteamShiftId).sort()).toEqual(["a", "c"]);
  });

  it("derives role day-level from title, then assignees", () => {
    expect(normalizeForImport([crewShift({ title: "Driver" })], DATE)[0].role).toBe("driver");
    expect(normalizeForImport([crewShift({ title: "Warehouse Associate" })], DATE)[0].role).toBe("prep");
    // Blank title, driver assignee -> driver from the dominant assignee role.
    expect(normalizeForImport([crewShift({ title: "", assignees: [member(1, "driver")] })], DATE)[0].role).toBe("driver");
    // Blank title, office-only -> office (non-crew), NOT field.
    expect(normalizeForImport([crewShift({ title: "", assignees: [member(1, "other")] })], DATE)[0].role).toBe("office");
    // Office person on an otherwise driver/prep shift still follows the dominant CREW role.
    expect(normalizeForImport([crewShift({ title: "", assignees: [member(1, "other"), member(2, "driver")] })], DATE)[0].role).toBe("driver");
    expect(normalizeForImport([crewShift({ title: "", assignees: [member(1, "other"), member(2, "prep")] })], DATE)[0].role).toBe("prep");
  });

  it("captures a last-modified only when present (never fabricated)", () => {
    expect(normalizeForImport([crewShift()], DATE)[0].lastModifiedIso).toBeNull();
    const withLm = normalizeForImport([crewShift({ lastModifiedUnix: END })], DATE)[0];
    expect(withLm.lastModifiedIso).toBe(new Date(END * 1000).toISOString());
  });

  it("marks a window unknown when start/end are not a valid interval", () => {
    const out = normalizeForImport([crewShift({ startUnix: END, endUnix: START })], DATE)[0];
    expect(out.windowKnown).toBe(false);
    expect(out.startTime).toBeNull();
  });
});

describe("planReconcile — honesty + create", () => {
  it("does NOTHING when Connecteam is unreachable (ok:false)", () => {
    const plan = planReconcile({ date: DATE, connecteam: { ok: false, shifts: [] }, appShifts: [appShift()] });
    expect(plan.reachable).toBe(false);
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.flags).toHaveLength(0);
  });

  it("creates an app shift for a Connecteam shift with no app copy", () => {
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [crewShift({ id: "new1" })] }, appShifts: [] });
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].ct.connecteamShiftId).toBe("new1");
  });

  it("two-way sync still MIRRORS an office/admin Connecteam shift — created, with role office (not dropped)", () => {
    // Lisa's Operations Coordinator shift: office title + office-only assignee → role office.
    const officeCt = crewShift({ id: "office1", title: "Operations Coordinator", assignees: [member(99, "other")] });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [officeCt] }, appShifts: [] });
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].ct.connecteamShiftId).toBe("office1");
    expect(plan.creates[0].ct.role).toBe("office"); // mirrored as office, never silently dropped
  });
});

describe("planReconcile — linked reconciliation", () => {
  it("baselines an app-pushed shift the first time (no content change)", () => {
    const ct = crewShift();
    const app = appShift({ source: "manual", connecteamContentHash: null });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [ct] }, appShifts: [app] });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].applyContent).toBe(false);
    expect(plan.updates[0].reason).toBe("baseline");
  });

  it("is a no-op when the Connecteam content is unchanged", () => {
    const ct = crewShift();
    const app = appShift({ connecteamContentHash: hashFor(ct), connecteamSyncedAt: "2026-10-15T12:00:00.000Z" });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [ct] }, appShifts: [app] });
    expect(plan.updates).toHaveLength(0);
    expect(plan.flags).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it("lets Connecteam win when only Connecteam changed", () => {
    const oldCt = crewShift({ assignees: [member(101, "driver")] });
    const newCt = crewShift({ assignees: [member(101, "driver"), member(102, "driver")] }); // a second person added in CT
    const app = appShift({
      connecteamContentHash: hashFor(oldCt),
      connecteamSyncedAt: "2026-10-15T12:00:00.000Z",
      updatedAt: "2026-10-15T12:00:00.000Z", // not edited locally since sync
    });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [newCt] }, appShifts: [app] });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].applyContent).toBe(true);
    expect(plan.updates[0].reason).toBe("connecteam_changed");
    expect(plan.updates[0].ct.assignees).toEqual([101, 102]);
  });

  it("flags a both-sides conflict needs_review when Connecteam has no timestamp", () => {
    const oldCt = crewShift({ assignees: [member(101, "driver")] });
    const newCt = crewShift({ assignees: [member(103, "driver")] }); // CT changed
    const app = appShift({
      connecteamContentHash: hashFor(oldCt),
      connecteamSyncedAt: "2026-10-15T12:00:00.000Z",
      updatedAt: "2026-10-15T18:00:00.000Z", // edited locally AFTER the sync -> both changed
    });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [newCt] }, appShifts: [app] });
    expect(plan.updates).toHaveLength(0);
    expect(plan.flags).toHaveLength(1);
    expect(plan.flags[0].reason).toBe("both_changed_no_timestamp");
  });

  it("applies last-edit-wins for Connecteam when it DOES expose a newer last-modified", () => {
    const oldCt = crewShift({ assignees: [member(101, "driver")] });
    const newCt = crewShift({ assignees: [member(103, "driver")], lastModifiedUnix: Math.floor(Date.parse("2026-10-15T20:00:00.000Z") / 1000) });
    const app = appShift({
      connecteamContentHash: hashFor(oldCt),
      connecteamSyncedAt: "2026-10-15T12:00:00.000Z",
      updatedAt: "2026-10-15T18:00:00.000Z", // app edited, but CT edited later
    });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [newCt] }, appShifts: [app] });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].reason).toBe("last_edit_wins_connecteam");
  });

  it("lets the app win (needs_review, not clobbered) when the app edit is newer", () => {
    const oldCt = crewShift({ assignees: [member(101, "driver")] });
    const newCt = crewShift({ assignees: [member(103, "driver")], lastModifiedUnix: Math.floor(Date.parse("2026-10-15T13:00:00.000Z") / 1000) });
    const app = appShift({
      connecteamContentHash: hashFor(oldCt),
      connecteamSyncedAt: "2026-10-15T12:00:00.000Z",
      updatedAt: "2026-10-15T18:00:00.000Z", // app edited AFTER CT's last-modified
    });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [newCt] }, appShifts: [app] });
    expect(plan.updates).toHaveLength(0);
    expect(plan.flags).toHaveLength(1);
    expect(plan.flags[0].reason).toBe("last_edit_wins_app");
  });

  it("flags a vanished Connecteam copy needs_review and never deletes", () => {
    const app = appShift({ source: "connecteam", connecteamShiftId: "gone", connecteamSyncedAt: "2026-10-15T12:00:00.000Z", connecteamContentHash: "h" });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [] }, appShifts: [app] });
    expect(plan.flags).toHaveLength(1);
    expect(plan.flags[0].reason).toBe("connecteam_copy_vanished");
    expect(plan.flags[0].ct).toBeNull();
  });

  it("leaves an already-needs_review shift untouched (no re-flag thrash)", () => {
    const ct = crewShift();
    const app = appShift({ syncStatus: "needs_review", connecteamContentHash: "stale" });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [ct] }, appShifts: [app] });
    expect(plan.updates).toHaveLength(0);
    expect(plan.flags).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it("does not flag a freshly-published shift (never synced) as vanished", () => {
    const app = appShift({ source: "manual", connecteamShiftId: "justpushed", connecteamSyncedAt: null, connecteamContentHash: null });
    const plan = planReconcile({ date: DATE, connecteam: { ok: true, shifts: [] }, appShifts: [app] });
    expect(plan.flags).toHaveLength(0);
  });
});
