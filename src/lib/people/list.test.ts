// Pure lifecycle-list contract: stage classification matches the overview grouping rules, the stage
// filter is validated against the section's allowed stages, counts are per-stage, and the search spans
// name/role/department/email. No DB — these are the pure helpers the searchable list renders through.

import { describe, it, expect } from "vitest";
import { classifyStage, ONBOARDING_STAGES, OFFBOARDING_STAGES } from "./stages";
import { filterPeople, parseStageFilter, stageCounts, type StageFilter } from "./list";
import type { EmployeeSummary } from "./overview";
import type { Employee, LifecycleState } from "./types";

function emp(over: Partial<Employee> = {}): Employee {
  return {
    id: "E-1", displayName: "Jordan Rivera", workEmail: null, phone: null,
    lifecycleState: "HIRE", role: "member", department: "sales", startDate: null, endDate: null,
    userId: null, hrWorkerId: null, connecteamUserId: null, instaworkWorker: null,
    openphoneUserId: null, gustoId: null, aiOrgHumanName: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
  };
}

function summary(over: Partial<Employee>, ready: boolean, hasFailed: boolean, outstandingRevokes = 0): EmployeeSummary {
  const e = emp(over);
  return {
    employee: e,
    readiness: { ready, completed: ready ? 1 : 0, totalRequired: 1, completionPct: ready ? 100 : 0, blockers: ready ? [] : [{ system: "Zoe", status: hasFailed ? "failed" : "manual_required" }] },
    hasFailed,
    outstandingRevokes,
    stage: classifyStage({ lifecycleState: e.lifecycleState, hasFailed, ready }),
  };
}

describe("classifyStage", () => {
  const cases: [LifecycleState, boolean, boolean, string][] = [
    ["HIRE", false, false, "starting_soon"],
    ["ONBOARD", false, false, "onboarding"],
    ["ONBOARD", false, true, "blocked"], // a failed task wins over "in progress"
    ["ONBOARD", true, false, "ready"],
    ["READY", false, false, "ready"],
    ["ACTIVE", false, false, "active"],
    ["OFFBOARD", false, false, "offboarding"],
    ["OFFBOARDED", false, false, "offboarded"],
  ];
  it.each(cases)("%s (ready=%s, failed=%s) → %s", (state, ready, failed, expected) => {
    expect(classifyStage({ lifecycleState: state, ready, hasFailed: failed })).toBe(expected);
  });

  it("a failed ONBOARD is blocked even if otherwise ready", () => {
    expect(classifyStage({ lifecycleState: "ONBOARD", ready: true, hasFailed: true })).toBe("blocked");
  });
});

describe("parseStageFilter", () => {
  it("accepts a stage valid for the section", () => {
    expect(parseStageFilter("blocked", ONBOARDING_STAGES)).toBe("blocked");
  });
  it("rejects a stage from the other section", () => {
    expect(parseStageFilter("offboarded", ONBOARDING_STAGES)).toBe("all");
    expect(parseStageFilter("active", OFFBOARDING_STAGES)).toBe("all");
  });
  it("falls back to all for unknown/empty", () => {
    expect(parseStageFilter(undefined, ONBOARDING_STAGES)).toBe("all");
    expect(parseStageFilter("garbage", ONBOARDING_STAGES)).toBe("all");
  });
});

describe("stageCounts + filterPeople", () => {
  const people: EmployeeSummary[] = [
    summary({ id: "E-1", displayName: "Jordan Rivera", lifecycleState: "HIRE", role: "member", department: "sales" }, false, false),
    summary({ id: "E-2", displayName: "Alex Kim", lifecycleState: "ONBOARD", role: "admin", department: "driver" }, false, false),
    summary({ id: "E-3", displayName: "Sam Blocked", lifecycleState: "ONBOARD", role: "member", department: "sales" }, false, true),
    summary({ id: "E-4", displayName: "Riley Ready", lifecycleState: "READY", role: "member", department: "warehouse" }, true, false),
    summary({ id: "E-5", displayName: "Dana Active", lifecycleState: "ACTIVE", role: "owner", department: "admin", workEmail: "dana@zoe.test" }, true, false),
  ];

  it("counts each onboarding stage plus the total", () => {
    const c = stageCounts(people, ONBOARDING_STAGES);
    expect(c.all).toBe(5);
    expect(c.starting_soon).toBe(1);
    expect(c.onboarding).toBe(1);
    expect(c.blocked).toBe(1);
    expect(c.ready).toBe(1);
    expect(c.active).toBe(1);
  });

  it("filters to a single stage", () => {
    const rows = filterPeople(people, { stage: "blocked" });
    expect(rows.map((r) => r.employee.id)).toEqual(["E-3"]);
  });

  it("stage 'all' keeps everyone", () => {
    expect(filterPeople(people, { stage: "all" as StageFilter })).toHaveLength(5);
  });

  it("search matches name, role, department and email (case-insensitive)", () => {
    expect(filterPeople(people, { q: "riley" }).map((r) => r.employee.id)).toEqual(["E-4"]);
    expect(filterPeople(people, { q: "OWNER" }).map((r) => r.employee.id)).toEqual(["E-5"]);
    expect(filterPeople(people, { q: "sales" }).map((r) => r.employee.id)).toEqual(["E-1", "E-3"]);
    expect(filterPeople(people, { q: "dana@zoe" }).map((r) => r.employee.id)).toEqual(["E-5"]);
  });

  it("combines stage + search", () => {
    const rows = filterPeople(people, { stage: "onboarding", q: "alex" });
    expect(rows.map((r) => r.employee.id)).toEqual(["E-2"]);
    expect(filterPeople(people, { stage: "onboarding", q: "sam" })).toHaveLength(0); // Sam is blocked, not onboarding
  });
});
