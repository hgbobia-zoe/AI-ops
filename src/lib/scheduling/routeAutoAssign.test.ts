import { describe, it, expect } from "vitest";
import { planRouteAutoAssign, isAutoRouteEligible } from "./routeAutoAssign";
import { routeEligibleFromTitle } from "@/lib/connecteam";
import type { ScheduledUnroutedPerson, ScheduledUnroutedResult } from "./scheduledUnrouted";

function person(p: Partial<ScheduledUnroutedPerson> & { userId: number; eligibleRouteIds: string[] }): ScheduledUnroutedPerson {
  return {
    name: `U${p.userId}`,
    role: "driver",
    routeEligible: true, // default is a driver; prep/asset/other tests override
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

  it("AUTO-ASSIGNS a WAREHOUSE associate (routeEligible) with one eligible field route — warehouse helps deliver", () => {
    const plan = planRouteAutoAssign(
      result([person({ userId: 4, role: "prep", routeEligible: true, fillRole: "field", eligibleRouteIds: ["r1"], suggestedRouteId: "r1" })]),
    );
    expect(plan.autoAssign.map((a) => a.userId)).toEqual([4]);
    expect(plan.autoAssign[0]).toMatchObject({ routeId: "r1", fillRole: "field" });
    expect(plan.prompt).toHaveLength(0);
  });

  it("NEVER auto-assigns an ASSET-PREP worker (not routeEligible), even with one eligible field route → PROMPT", () => {
    const plan = planRouteAutoAssign(
      result([person({ userId: 5, role: "prep", routeEligible: false, fillRole: "field", eligibleRouteIds: ["r1"], suggestedRouteId: "r1" })]),
    );
    expect(plan.autoAssign).toHaveLength(0);
    expect(plan.prompt).toHaveLength(1);
    expect(plan.prompt[0]).toMatchObject({ userId: 5, suggestedRouteId: "r1", eligibleRouteIds: ["r1"] });
    expect(plan.prompt[0].reason).toContain("asset-prep");
  });

  it("NEVER auto-assigns an office/admin ('other') worker to a route (defense in depth) → PROMPT", () => {
    const plan = planRouteAutoAssign(
      result([person({ userId: 6, role: "other", routeEligible: false, fillRole: "field", eligibleRouteIds: ["r1"], suggestedRouteId: "r1" })]),
    );
    expect(plan.autoAssign).toHaveLength(0);
    expect(plan.prompt).toHaveLength(1);
    expect(plan.prompt[0].reason).toContain("not auto-routed");
  });

  it("STILL auto-assigns a genuine driver with one eligible route", () => {
    const plan = planRouteAutoAssign(
      result([person({ userId: 7, role: "driver", routeEligible: true, fillRole: "driver", eligibleRouteIds: ["r1"] })]),
    );
    expect(plan.autoAssign.map((a) => a.userId)).toEqual([7]);
    expect(plan.prompt).toHaveLength(0);
  });

  it("isAutoRouteEligible keys on the title-derived routeEligible signal (driver+warehouse yes, asset-prep/other/untitled no)", () => {
    expect(isAutoRouteEligible({ routeEligible: true })).toBe(true);
    expect(isAutoRouteEligible({ routeEligible: false })).toBe(false);
    // the signal itself, from the live titles:
    expect(routeEligibleFromTitle("Driver")).toBe(true);
    expect(routeEligibleFromTitle("Warehouse Associate")).toBe(true); // warehouse helps deliver
    expect(routeEligibleFromTitle("Event Asset Processor")).toBe(false); // back of warehouse
    expect(routeEligibleFromTitle("Co-Founder")).toBe(false);
    expect(routeEligibleFromTitle("")).toBe(false); // untitled → never auto-routed
    expect(routeEligibleFromTitle(undefined)).toBe(false);
  });

  it("Connecteam unreachable → empty plan (honest unknown, never auto-writes)", () => {
    const plan = planRouteAutoAssign(result([person({ userId: 1, eligibleRouteIds: ["r1"] })], false));
    expect(plan).toEqual({ reachable: false, autoAssign: [], prompt: [] });
  });
});
