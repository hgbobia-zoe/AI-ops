import { describe, it, expect } from "vitest";
import { collapseScheduledPeople, detectScheduledUnrouted, type ScheduledUnroutedInput } from "./scheduledUnrouted";
import type { ScheduledPerson, UnroutedRouteCandidate } from "./scheduledUnrouted";
import type { CrewShift } from "@/lib/connecteam";

// Windows in Unix seconds. A simple 9am–5pm-ish day for overlap math.
const H = 3600;
const BASE = 1_760_000_000; // arbitrary fixed epoch

function person(p: Partial<ScheduledPerson> & { userId: number; role: ScheduledPerson["role"] }): ScheduledPerson {
  // Default routeEligible mirrors the live mapping (driver route-eligible); tests override per case.
  return { name: `U${p.userId}`, title: null, routeEligible: p.role === "driver", window: { start: BASE, end: BASE + 8 * H }, ...p };
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

  it("carries the title-derived routeEligible through to the surfaced person (warehouse true, asset false)", () => {
    const warehouse = detectScheduledUnrouted(
      input({
        scheduled: [person({ userId: 2, role: "prep", routeEligible: true })], // warehouse associate
        routes: [routeCand({ routeId: "r1", gapByRole: { driver: 0, field: 2 } })],
      }),
    );
    expect(warehouse.people[0]).toMatchObject({ userId: 2, fillRole: "field", routeEligible: true });

    const asset = detectScheduledUnrouted(
      input({
        scheduled: [person({ userId: 3, role: "prep", routeEligible: false })], // asset-prep (back of warehouse)
        routes: [routeCand({ routeId: "r1", gapByRole: { driver: 0, field: 2 } })],
      }),
    );
    expect(asset.people[0]).toMatchObject({ userId: 3, fillRole: "field", routeEligible: false });
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

});

// ── collapseScheduledPeople: each person shows their OWN real shift window, never a cross-shift span ──────
describe("collapseScheduledPeople (pure) — the '7:30a – 2:30a' bug", () => {
  // Saturday 10/17/2026 ET epochs (EDT, UTC-4).
  const U = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
  const T0730 = U("2026-10-17T07:30:00-04:00"); // Joseph's shift start
  const T1300 = U("2026-10-17T13:00:00-04:00"); // Joseph's shift end (1:00 PM)
  const T1530 = U("2026-10-17T15:30:00-04:00"); // Marquis's shift start (3:30 PM)
  const T1800 = U("2026-10-17T18:00:00-04:00"); // shared evening shift start
  const T0230 = U("2026-10-18T02:30:00-04:00"); // shared evening shift end (2:30 AM next day)

  function shift(id: string, start: number, end: number, assignees: Array<{ userId: number; name: string }>): CrewShift {
    return {
      id,
      schedulerId: 1,
      schedulerName: "Drivers",
      startUnix: start,
      endUnix: end,
      timezone: "America/New_York",
      isOpen: false,
      title: "Driver",
      assignees: assignees.map((a) => ({ userId: a.userId, name: a.name, role: "driver" as const, routeEligible: true })),
    };
  }

  it("shows each driver's OWN earliest shift, not a span merged across a shared late shift", () => {
    const joseph = { userId: 101, name: "Joseph Hewitt" };
    const marquis = { userId: 102, name: "Marquis Crossen" };
    const people = collapseScheduledPeople([
      shift("s1", T0730, T1300, [joseph]), // Joseph 7:30a – 1:00p
      shift("s2", T1530, T1800, [marquis]), // Marquis 3:30p – 6:00p
      shift("s3", T1800, T0230, [joseph, marquis]), // shared evening shift ending 2:30a
    ]);

    const j = people.find((p) => p.userId === 101)!;
    const m = people.find((p) => p.userId === 102)!;
    // Before the fix both ended at 2:30a (T0230); now each keeps its own earliest shift's real window.
    expect(j.window).toEqual({ start: T0730, end: T1300 });
    expect(m.window).toEqual({ start: T1530, end: T1800 });
    // The fabricated "end of day" 2:30a span must not appear on anyone.
    expect(j.window!.end).not.toBe(T0230);
    expect(m.window!.end).not.toBe(T0230);
  });

  it("drops a shift with no usable window to null, not a bogus zero-length window", () => {
    const [p] = collapseScheduledPeople([shift("s1", T0730, T0730, [{ userId: 1, name: "A" }])]);
    expect(p.window).toBeNull();
  });
});

describe("detectScheduledUnrouted (pure) — unreachable", () => {
  function person(p: Partial<ScheduledPerson> & { userId: number; role: ScheduledPerson["role"] }): ScheduledPerson {
    return { name: `U${p.userId}`, title: null, routeEligible: p.role === "driver", window: { start: BASE, end: BASE + 8 * H }, ...p };
  }
  function routeCand(p: Partial<UnroutedRouteCandidate> & { routeId: string }): UnroutedRouteCandidate {
    return { truckId: "E450", truckName: `Truck ${p.routeId}`, window: { start: BASE + H, end: BASE + 6 * H }, gapByRole: { driver: 0, field: 0 }, ...p };
  }
  function input(p: Partial<ScheduledUnroutedInput>): ScheduledUnroutedInput {
    return { reachable: true, scheduled: [], routeAssignedUserIds: [], routes: [], ...p };
  }
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
