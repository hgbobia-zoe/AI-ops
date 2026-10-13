import { describe, it, expect } from "vitest";
import { detectScheduledUnrouted, type ScheduledUnroutedInput } from "./scheduledUnrouted";
import type { ScheduledPerson, UnroutedRouteCandidate } from "./scheduledUnrouted";

// Windows in Unix seconds. A simple 9am–5pm-ish day for overlap math.
const H = 3600;
const BASE = 1_760_000_000; // arbitrary fixed epoch

function person(p: Partial<ScheduledPerson> & { userId: number; role: ScheduledPerson["role"] }): ScheduledPerson {
  return { name: `U${p.userId}`, title: null, window: { start: BASE, end: BASE + 8 * H }, ...p };
}

function routeCand(p: Partial<UnroutedRouteCandidate> & { routeId: string }): UnroutedRouteCandidate {
  return {
    truckId: "E450",
    truckName: `Truck ${p.routeId}`,
    window: { start: BASE + H, end: BASE + 6 * H },
    gapByRole: { driver: 0, field: 0 },
    ...p,
  };
}

function input(p: Partial<ScheduledUnroutedInput>): ScheduledUnroutedInput {
  return { reachable: true, scheduled: [], routeAssignedUserIds: [], routes: [], ...p };
}

describe("detectScheduledUnrouted (pure)", () => {
  it("surfaces a scheduled driver with no route, suggesting a route that has a driver gap", () => {
    const r = detectScheduledUnrouted(
      input({
        scheduled: [person({ userId: 1, role: "driver" })],
        routes: [routeCand({ routeId: "r1", gapByRole: { driver: 1, field: 0 } })],
      }),
    );
    expect(r.reachable).toBe(true);
    expect(r.people).toHaveLength(1);
    expect(r.people[0]).toMatchObject({ userId: 1, fillRole: "driver", suggestedRouteId: "r1", eligibleRouteIds: ["r1"] });
  });

  it("maps a scheduled prep (warehouse) person to a FIELD helper gap", () => {
    const r = detectScheduledUnrouted(
      input({
        scheduled: [person({ userId: 2, role: "prep" })],
        routes: [routeCand({ routeId: "r1", gapByRole: { driver: 0, field: 2 } })],
      }),
    );
    expect(r.people).toHaveLength(1);
    expect(r.people[0]).toMatchObject({ userId: 2, fillRole: "field", suggestedRouteId: "r1" });
  });

  it("never surfaces office/admin ('other') crew", () => {
    const r = detectScheduledUnrouted(
      input({
        scheduled: [person({ userId: 3, role: "other" })],
        routes: [routeCand({ routeId: "r1", gapByRole: { driver: 1, field: 1 } })],
      }),
    );
    expect(r.people).toHaveLength(0);
  });

  it("does NOT surface someone already on a route-tied app shift (the real 'on a route' signal)", () => {
    const r = detectScheduledUnrouted(
      input({
        scheduled: [person({ userId: 1, role: "driver" })],
        routeAssignedUserIds: [1],
        routes: [routeCand({ routeId: "r1", gapByRole: { driver: 1, field: 0 } })],
      }),
    );
    expect(r.people).toHaveLength(0);
  });

  it("does NOT surface a scheduled person when no route has a gap they can fill (nothing to assign to)", () => {
    const r = detectScheduledUnrouted(
      input({
        scheduled: [person({ userId: 2, role: "prep" })],
        routes: [routeCand({ routeId: "r1", gapByRole: { driver: 1, field: 0 } })], // only a driver gap; prep fills field
      }),
    );
    expect(r.people).toHaveLength(0);
  });

  it("excludes a route whose window does not overlap the person's schedule, keeps one that does", () => {
    const early = person({ userId: 1, role: "driver", window: { start: BASE, end: BASE + 2 * H } });
    const overlapping = routeCand({ routeId: "r1", window: { start: BASE + H, end: BASE + 3 * H }, gapByRole: { driver: 1, field: 0 } });
    const disjoint = routeCand({ routeId: "r2", window: { start: BASE + 5 * H, end: BASE + 7 * H }, gapByRole: { driver: 1, field: 0 } });
    const r = detectScheduledUnrouted(input({ scheduled: [early], routes: [overlapping, disjoint] }));
    expect(r.people).toHaveLength(1);
    expect(r.people[0].eligibleRouteIds).toEqual(["r1"]);
    expect(r.people[0].suggestedRouteId).toBe("r1");
  });

  it("suggests the route with the largest matching gap, ties broken by truck name", () => {
    const r = detectScheduledUnrouted(
      input({
        scheduled: [person({ userId: 2, role: "prep" })],
        routes: [
          routeCand({ routeId: "r1", truckName: "Beta", gapByRole: { driver: 0, field: 1 } }),
          routeCand({ routeId: "r2", truckName: "Alpha", gapByRole: { driver: 0, field: 3 } }),
        ],
      }),
    );
    expect(r.people[0].suggestedRouteId).toBe("r2"); // bigger field gap wins
    expect(r.people[0].eligibleRouteIds.sort()).toEqual(["r1", "r2"]);
  });

  it("when a window is unknown it does NOT fabricate a conflict (eligible + flagged)", () => {
    const noWin = person({ userId: 1, role: "driver", window: null });
    const r = detectScheduledUnrouted(
      input({ scheduled: [noWin], routes: [routeCand({ routeId: "r1", window: null, gapByRole: { driver: 1, field: 0 } })] }),
    );
    expect(r.people).toHaveLength(1);
    expect(r.people[0].reasons.join(" ")).toContain("overlap not checked");
  });

  it("Connecteam unreachable → honest unknown (reachable:false, no people), never fabricated", () => {
    const r = detectScheduledUnrouted(
      input({
        reachable: false,
        scheduled: [person({ userId: 1, role: "driver" })],
        routes: [routeCand({ routeId: "r1", gapByRole: { driver: 1, field: 0 } })],
      }),
    );
    expect(r).toEqual({ reachable: false, people: [] });
  });
});
