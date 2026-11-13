import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/getSession", () => ({
  viewerRole: vi.fn(async () => "owner"),
  currentActor: vi.fn(async () => ({ id: "u1", label: "Lisa" })),
}));
// The route crew window for "R-1": 7:45 AM to 5:00 PM EST on Nov 14.
const CREW = { start: "2026-11-14T12:45:00.000Z", end: "2026-11-14T22:00:00.000Z", known: true };
vi.mock("@/lib/scheduling/routeCrewWindow", () => ({
  crewWindowForRoute: (id: string | null) => (id === "R-1" ? CREW : { start: null, end: null, known: false }),
}));

const ct = vi.hoisted(() => ({ ok: true as boolean, calls: [] as Array<{ schedulerId: number; shiftId: string }> }));
vi.mock("@/lib/connecteam", async (orig) => ({
  ...(await orig<typeof import("@/lib/connecteam")>()),
  deletePublishedShift: vi.fn(async (i: { schedulerId: number; shiftId: string }) => {
    ct.calls.push(i);
    return ct.ok ? { ok: true } : { ok: false, error: "Connecteam HTTP 500" };
  }),
  getDefaultScheduler: vi.fn(async () => ({ schedulerId: 7, name: "Job Scheduler", timezone: "America/New_York" })),
}));

import { createShift, getShiftById, updateShift } from "@/lib/scheduling/store";
import { DELETE, PATCH } from "./route";

const patch = (id: string, body: Record<string, unknown>) =>
  PATCH(new Request(`http://localhost/api/scheduling/shift/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

const routeShift = () =>
  createShift({ date: "2026-11-14", role: "field", headcount: 1, startTime: CREW.start, endTime: CREW.end, windowKnown: true, routeId: "R-1", assignees: [1], source: "derived" });

describe("PATCH /api/scheduling/shift/[id]: route time overrides", () => {
  it("changing a route shift's time marks it overridden (who, when, the route time)", async () => {
    const s = routeShift();
    expect((await patch(s.id, { startTime: "2026-11-14T13:00:00.000Z", endTime: CREW.end })).status).toBe(200);
    expect(getShiftById(s.id)!.routeOverride).toMatchObject({ by: "Lisa", source: "dispatch", routeStart: CREW.start, routeEnd: CREW.end });
  });

  it("Reset to route puts it back on the route time and clears the override", async () => {
    const s = routeShift();
    await patch(s.id, { startTime: "2026-11-14T13:00:00.000Z", endTime: CREW.end });
    expect((await patch(s.id, { routeTimeAction: "reset" })).status).toBe(200);
    expect(getShiftById(s.id)).toMatchObject({ startTime: CREW.start, endTime: CREW.end, routeOverride: null });
  });

  it("Keep this time records an override without changing the time", async () => {
    const s = routeShift();
    await patch(s.id, { startTime: "2026-11-14T13:00:00.000Z", endTime: CREW.end });
    await patch(s.id, { routeTimeAction: "reset" });
    // Simulate an old difference nobody confirmed, then keep it.
    const t = createShift({ date: "2026-11-14", role: "driver", headcount: 1, startTime: "2026-11-14T13:00:00.000Z", endTime: CREW.end, windowKnown: true, routeId: "R-1", assignees: [2], source: "manual" });
    expect((await patch(t.id, { routeTimeAction: "keep" })).status).toBe(200);
    expect(getShiftById(t.id)).toMatchObject({ startTime: "2026-11-14T13:00:00.000Z", routeOverride: expect.objectContaining({ by: "Lisa", source: "kept" }) });
  });

  it("a client cannot write the override directly, and an edit without a time change leaves it alone", async () => {
    const s = routeShift();
    await patch(s.id, { notes: "hello", routeOverride: { by: "x", at: "y", source: "dispatch", routeStart: null, routeEnd: null } });
    expect(getShiftById(s.id)!.routeOverride).toBeNull();
  });
});

describe("cancel and delete pull the shift from Connecteam (owner rule 2026-11-13)", () => {
  let n = 0;
  const published = () => {
    n += 1;
    const s = createShift({ date: "2026-11-17", role: "prep", headcount: 1, startTime: "2026-11-17T14:00:00.000Z", endTime: "2026-11-17T18:00:00.000Z", windowKnown: true, assignees: [5], source: "manual" });
    updateShift(s.id, { status: "sent", connecteamShiftId: `ct-cancel-${n}`, connecteamSchedulerId: 11594873, syncStatus: "synced" });
    return s;
  };

  it("cancelling takes it down in Connecteam, then cancels and unlinks it here", async () => {
    ct.ok = true;
    ct.calls = [];
    const s = published();
    expect((await patch(s.id, { status: "cancelled" })).status).toBe(200);
    expect(ct.calls).toEqual([{ schedulerId: 11594873, shiftId: `ct-cancel-${n}` }]);
    expect(getShiftById(s.id)).toMatchObject({ status: "cancelled", connecteamShiftId: null, syncStatus: null });
  });

  it("when Connecteam refuses, nothing is cancelled and the message says so", async () => {
    ct.ok = false;
    const s = published();
    const res = await patch(s.id, { status: "cancelled" });
    expect(res.status).toBe(502);
    expect((await res.json()).message).toContain("Nothing was cancelled");
    expect(getShiftById(s.id)).toMatchObject({ status: "sent", connecteamShiftId: `ct-cancel-${n}` });
    ct.ok = true;
  });

  it("deleting a published shift pulls it from Connecteam first", async () => {
    ct.calls = [];
    const s = published();
    const res = await DELETE(new Request(`http://localhost/api/scheduling/shift/${s.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: s.id }) });
    expect(res.status).toBe(200);
    expect(ct.calls).toHaveLength(1);
    expect(getShiftById(s.id)).toBeNull();
  });

  it("a shift that was never in Connecteam cancels without a Connecteam call", async () => {
    ct.calls = [];
    const s = createShift({ date: "2026-11-17", role: "prep", headcount: 1, startTime: null, endTime: null, windowKnown: false, assignees: [], source: "manual" });
    expect((await patch(s.id, { status: "cancelled" })).status).toBe(200);
    expect(ct.calls).toHaveLength(0);
  });
});
