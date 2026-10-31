import { describe, it, expect } from "vitest";
import { planRouteAutoAssign } from "./routeAutoAssign";
import type { ScheduledUnroutedPerson, ScheduledUnroutedResult } from "./scheduledUnrouted";

function person(p: Partial<ScheduledUnroutedPerson> & { userId: number; eligibleRouteIds: string[] }): ScheduledUnroutedPerson {
  return {
    name: `U${p.userId}`,
    role: "driver",
    fillRole: "driver",
    title: null,
    window: null,
    suggestedRouteId: p.eligibleRouteIds[0] ?? null,
    reasons: [],
    ...p,
  };
}
function result(people: ScheduledUnroutedPerson[], reachable = true): ScheduledUnroutedResult {
  return { reachable, people };
}

describe("planRouteAutoAssign (pure)", () => {
  it("AUTO-ASSIGNS a person with exactly one eligible route (unambiguous)", () => {
    const plan = planRouteAutoAssign(result([person({ userId: 1, fillRole: "driver", eligibleRouteIds: ["r1"] })]));
    expect(plan.reachable).toBe(true);
    expect(plan.autoAssign).toHaveLength(1);
    expect(plan.prompt).toHaveLength(0);
    expect(plan.autoAssign[0]).toMatchObject({ userId: 1, routeId: "r1", fillRole: "driver" });
    expect(plan.autoAssign[0].reasons[0]).toContain("unambiguous");
  });

  it("falls back to the PROMPT when more than one route is eligible (ambiguous)", () => {
    const plan = planRouteAutoAssign(
      result([person({ userId: 2, fillRole: "driver", role: "driver", eligibleRouteIds: ["r1", "r2"], suggestedRouteId: "r2" })]),
    );
    expect(plan.autoAssign).toHaveLength(0);
    expect(plan.prompt).toHaveLength(1);
    expect(plan.prompt[0]).toMatchObject({ userId: 2, suggestedRouteId: "r2", eligibleRouteIds: ["r1", "r2"] });
    expect(plan.prompt[0].reason).toContain("ambiguous");
  });

  it("splits a mixed batch: unambiguous driver auto-assigns, ambiguous driver prompts", () => {
    const plan = planRouteAutoAssign(
      result([
        person({ userId: 1, eligibleRouteIds: ["r1"] }),
        person({ userId: 2, fillRole: "driver", role: "driver", eligibleRouteIds: ["r1", "r2"] }),
      ]),
    );
    expect(plan.autoAssign.map((a) => a.userId)).toEqual([1]);
    expect(plan.prompt.map((p) => p.userId)).toEqual([2]);
  });

  it("NEVER auto-assigns a prep (warehouse) worker to a truck, even on a single route (owner directive 2026-10-30)", () => {
    // "asset prep does not get on a truck at all" — prep is not delivery crew. In practice the detector no
    // longer surfaces prep onto a route seat at all (fillRoleFor → null); this guards the auto gate directly.
    const plan = planRouteAutoAssign(
      result([person({ userId: 5, role: "prep", fillRole: "field", eligibleRouteIds: ["r1"], suggestedRouteId: "r1" })]),
    );
    expect(plan.autoAssign).toHaveLength(0);
    expect(plan.prompt).toHaveLength(1);
    expect(plan.prompt[0]).toMatchObject({ userId: 5 });
    expect(plan.prompt[0].reason).toContain("not auto-routed");
  });

  it("NEVER auto-assigns an office/admin ('other') worker to a route (defense in depth) → PROMPT", () => {
    const plan = planRouteAutoAssign(
      result([person({ userId: 6, role: "other", fillRole: "field", eligibleRouteIds: ["r1"], suggestedRouteId: "r1" })]),
    );
    expect(plan.autoAssign).toHaveLength(0);
    expect(plan.prompt).toHaveLength(1);
    expect(plan.prompt[0].reason).toContain("not auto-routed");
  });

  it("STILL auto-assigns a genuine driver with one eligible route (field/driver crew is unaffected)", () => {
    const plan = planRouteAutoAssign(
      result([person({ userId: 7, role: "driver", fillRole: "driver", eligibleRouteIds: ["r1"] })]),
    );
    expect(plan.autoAssign.map((a) => a.userId)).toEqual([7]);
    expect(plan.prompt).toHaveLength(0);
  });

  it("Connecteam unreachable → empty plan (honest unknown, never auto-writes)", () => {
    const plan = planRouteAutoAssign(result([person({ userId: 1, eligibleRouteIds: ["r1"] })], false));
    expect(plan).toEqual({ reachable: false, autoAssign: [], prompt: [] });
  });
});
