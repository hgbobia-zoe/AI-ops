// Staff matching planner (pure): confident unique links only, never overwrite, everything else is an
// exception with a reason; established roster staff are imported, recent ones flagged.

import { describe, it, expect } from "vitest";
import { planMatches, policyForTitle, nameKey, type MatchInput } from "./match";
import type { Employee } from "./types";

function emp(over: Partial<Employee> & { id: string; displayName: string }): Employee {
  return {
    workEmail: null, phone: null, lifecycleState: "ACTIVE", role: "member", department: "sales_associate", startDate: null, endDate: null,
    userId: null, hrWorkerId: null, connecteamUserId: null, instaworkWorker: null, openphoneUserId: null, gustoId: null, aiOrgHumanName: null,
    createdAt: "", updatedAt: "", ...over,
  };
}

function input(over: Partial<MatchInput>): MatchInput {
  return { employees: [], roster: [], rosterOk: true, logins: [], workers: [], today: "2026-11-03", connecteamPolicies: ["sales_associate", "driver", "warehouse"], ...over };
}

describe("Connecteam roster", () => {
  it("imports established staff with no People record, policy from their title", () => {
    const p = planMatches(input({ roster: [{ userId: 7, name: "Jessie Medalla", phone: "(301) 555-0101", title: "Sales", seniorityDate: "2025-01-10" }] }));
    expect(p.creates).toHaveLength(1);
    expect(p.creates[0].policyId).toBe("sales_associate");
    expect(p.creates[0].phone).toBe("+13015550101");
    expect(p.exceptions).toEqual([]);
  });

  it("flags someone new in Connecteam instead of importing them (a hire mid onboarding)", () => {
    const p = planMatches(input({ roster: [{ userId: 8, name: "New Person", seniorityDate: "2026-10-30" }] }));
    expect(p.creates).toHaveLength(0);
    expect(p.exceptions[0].kind).toBe("new_in_connecteam");
  });

  it("links an existing record by phone, then by full name, and fills a missing phone", () => {
    const a = emp({ id: "A", displayName: "Pat Lee", phone: "+13015550111" });
    const b = emp({ id: "B", displayName: "Sam Ortiz" });
    const p = planMatches(input({
      employees: [a, b],
      roster: [
        { userId: 1, name: "Patricia Lee", phone: "301-555-0111" },
        { userId: 2, name: "Sam Ortiz", phone: "3015550222" },
      ],
    }));
    expect(p.links).toContainEqual(expect.objectContaining({ employeeId: "A", field: "connecteam_user_id", value: 1 }));
    expect(p.links).toContainEqual(expect.objectContaining({ employeeId: "B", field: "connecteam_user_id", value: 2 }));
    expect(p.links).toContainEqual(expect.objectContaining({ employeeId: "B", field: "phone", value: "+13015550222" }));
    expect(p.creates).toHaveLength(0);
  });

  it("two people with the same name is an exception with both as choices", () => {
    const p = planMatches(input({
      employees: [emp({ id: "A", displayName: "Chris Doe" }), emp({ id: "B", displayName: "Chris Doe" })],
      roster: [{ userId: 3, name: "Chris Doe" }],
    }));
    expect(p.links).toHaveLength(0);
    expect(p.exceptions[0].kind).toBe("ambiguous");
    expect(p.exceptions[0].suggestions.map((s) => s.employeeId).sort()).toEqual(["A", "B"]);
  });

  it("never overwrites an existing link and never reuses a held id", () => {
    const p = planMatches(input({
      employees: [emp({ id: "A", displayName: "Pat Lee", connecteamUserId: 1 }), emp({ id: "B", displayName: "Pat Lee" })],
      roster: [{ userId: 1, name: "Pat Lee" }],
    }));
    expect(p.links.filter((l) => l.field === "connecteam_user_id")).toHaveLength(0);
  });

  it("an unreachable roster raises no roster exceptions", () => {
    const p = planMatches(input({ rosterOk: false, employees: [emp({ id: "A", displayName: "Pat Lee" })] }));
    expect(p.exceptions.filter((x) => x.system === "connecteam")).toHaveLength(0);
  });
});

describe("Zoe logins", () => {
  it("links on full name; first name only is a probable match that needs a yes", () => {
    const p = planMatches(input({
      employees: [emp({ id: "A", displayName: "Jessie Medalla" }), emp({ id: "B", displayName: "Hermann Gbobia" })],
      logins: [
        { id: "U1", username: "jessie", name: "Jessie Medalla", role: "member", active: true, openphoneUserId: "OP1" },
        { id: "U2", username: "hermann", name: "hermann", role: "owner", active: true, openphoneUserId: null },
      ],
    }));
    expect(p.links).toContainEqual(expect.objectContaining({ employeeId: "A", field: "user_id", value: "U1" }));
    expect(p.links).toContainEqual(expect.objectContaining({ employeeId: "A", field: "openphone_user_id", value: "OP1" }));
    const probable = p.exceptions.find((x) => x.key === "probable:zoe:U2")!;
    expect(probable.kind).toBe("probable");
    expect(probable.suggestions[0]).toMatchObject({ employeeId: "B", field: "user_id", value: "U2" });
  });

  it("a login tied to nobody is called out; a deactivated one is ignored", () => {
    const p = planMatches(input({
      logins: [
        { id: "U3", username: "kiosk", name: "kiosk", role: "member", active: true, openphoneUserId: null },
        { id: "U4", username: "old", name: "Old Person", role: "member", active: false, openphoneUserId: null },
      ],
    }));
    expect(p.exceptions.map((x) => x.key)).toEqual(["no_match:zoe:U3"]);
  });
});

describe("payroll and People gaps", () => {
  it("links a payroll worker through the Connecteam id linked in the same pass", () => {
    const p = planMatches(input({
      employees: [emp({ id: "A", displayName: "Sam Ortiz" })],
      roster: [{ userId: 2, name: "Sam Ortiz" }],
      workers: [{ id: "HW1", name: "Samuel Ortiz", email: null, connecteamUserId: 2, gustoId: "G9", active: true, excluded: false }],
    }));
    expect(p.links).toContainEqual(expect.objectContaining({ employeeId: "A", field: "hr_worker_id", value: "HW1" }));
    expect(p.links).toContainEqual(expect.objectContaining({ employeeId: "A", field: "gusto_id", value: "G9" }));
  });

  it("flags an active person with no policy, and one missing from Connecteam", () => {
    const p = planMatches(input({
      employees: [emp({ id: "A", displayName: "No Policy", department: null }), emp({ id: "B", displayName: "Not In Ct" })],
      roster: [{ userId: 9, name: "Someone Else", seniorityDate: "2020-01-01" }],
    }));
    const keys = p.exceptions.map((x) => x.key);
    expect(keys).toContain("no_policy:A");
    expect(keys).toContain("missing_in_connecteam:B");
  });

  it("a HIRE not set up yet is not flagged", () => {
    const p = planMatches(input({ employees: [emp({ id: "A", displayName: "Fresh Hire", lifecycleState: "HIRE" })], roster: [{ userId: 9, name: "X Y", seniorityDate: "2020-01-01" }] }));
    expect(p.exceptions.filter((x) => x.employeeId === "A")).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("maps titles to policies and keys names by first and last word", () => {
    expect(policyForTitle("Driver")).toBe("driver");
    expect(policyForTitle("Event Asset Processor")).toBe("warehouse");
    expect(policyForTitle("Co-Founder")).toBe("admin");
    expect(policyForTitle("Marketer")).toBeNull();
    expect(nameKey("Ana María de la Cruz")).toBe("ana cruz");
  });
});
