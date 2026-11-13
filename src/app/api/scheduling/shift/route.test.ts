import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/getSession", () => ({
  viewerRole: vi.fn(async () => "owner"),
  currentActor: vi.fn(async () => ({ id: "u1", label: "Lisa" })),
}));
const CREW = { start: "2026-11-14T12:45:00.000Z", end: "2026-11-14T22:00:00.000Z", known: true };
vi.mock("@/lib/scheduling/routeCrewWindow", () => ({ crewWindowForRoute: () => CREW }));
vi.mock("@/lib/db/repo", async (orig) => ({
  ...(await orig<typeof import("@/lib/db/repo")>()),
  getRouteById: (id: string) => (id === "R-1" ? { routeId: "R-1", truckId: "NPR-1", date: "2026-11-14", status: "planned", stops: [] } : null),
}));

import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/scheduling/shift", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("POST /api/scheduling/shift: Add shift follows the route", () => {
  it("a shift on a route takes the route's time and follows it (no override)", async () => {
    const j = await (await post({ date: "2026-11-14", role: "field", headcount: 1, routeId: "R-1", assignees: [1] })).json();
    expect(j.shift).toMatchObject({ startTime: CREW.start, endTime: CREW.end, windowKnown: true, truckId: "NPR-1", routeOverride: null, routeWindowStart: CREW.start });
  });

  it("a different typed time on a route shift is an override from the start", async () => {
    const j = await (await post({ date: "2026-11-14", role: "field", headcount: 1, routeId: "R-1", startTime: "2026-11-14T13:00:00.000Z", endTime: CREW.end })).json();
    expect(j.shift.routeOverride).toMatchObject({ by: "Lisa", source: "dispatch" });
  });

  it("a shift with no route keeps blank times (no guessed hour)", async () => {
    const j = await (await post({ date: "2026-11-14", role: "prep", headcount: 1, startTime: null, endTime: null, windowKnown: false })).json();
    expect(j.shift).toMatchObject({ startTime: null, endTime: null, windowKnown: false, routeId: null });
  });
});
