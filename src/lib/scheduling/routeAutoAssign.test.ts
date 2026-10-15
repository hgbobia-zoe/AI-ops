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
      result([person({ userId: 2, fillRole: "field", role: "prep", eligibleRouteIds: ["r1", "r2"], suggestedRouteId: "r2" })]),
    );
    expect(plan.autoAssign).toHaveLength(0);
    expect(plan.prompt).toHaveLength(1);
    expect(plan.prompt[0]).toMatchObject({ userId: 2, suggestedRouteId: "r2", eligibleRouteIds: ["r1", "r2"] });
    expect(plan.prompt[0].reason).toContain("ambiguous");
  });

  it("splits a mixed batch: unambiguous auto-assigns, ambiguous prompts", () => {
    const plan = planRouteAutoAssign(
      result([
        person({ userId: 1, eligibleRouteIds: ["r1"] }),
        person({ userId: 2, fillRole: "field", role: "prep", eligibleRouteIds: ["r1", "r2"] }),
      ]),
    );
    expect(plan.autoAssign.map((a) => a.userId)).toEqual([1]);
    expect(plan.prompt.map((p) => p.userId)).toEqual([2]);
  });

  it("Connecteam unreachable → empty plan (honest unknown, never auto-writes)", () => {
    const plan = planRouteAutoAssign(result([person({ userId: 1, eligibleRouteIds: ["r1"] })], false));
    expect(plan).toEqual({ reachable: false, autoAssign: [], prompt: [] });
  });
});
