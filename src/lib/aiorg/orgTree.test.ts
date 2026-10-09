import { describe, it, expect } from "vitest";
import { AI_EMPLOYEES, HUMANS } from "./registry";
import { buildEmployeeView, type AiDept } from "./types";
import { buildOrgTree, DEPARTMENT_LEAD, splitCoOwners, type OrgAgentInput } from "./orgTree";

// The real derived agents (coming agents get no metrics, enforced in buildEmployeeView), reduced to the
// minimal tree input. This exercises the SAME roster the UI renders.
const agents: OrgAgentInput[] = AI_EMPLOYEES.map((e) => {
  const v = buildEmployeeView(e);
  return { id: v.id, name: v.name, department: v.department, backing: v.backing, state: v.state };
});

describe("buildOrgTree — hierarchy assembly", () => {
  const tree = buildOrgTree(HUMANS, agents);

  it("roots the tree at the Ownership seat, split into co-owner tiles (presentation only)", () => {
    expect(tree.owner.names).toEqual(["Hermann", "Cindy"]);
    expect(tree.owner.role).toMatch(/ownership/i);
    // The registry stays the single combined entry — the split is presentation-only.
    expect(HUMANS.some((h) => h.name === "Hermann+Cindy")).toBe(true);
    expect(HUMANS.some((h) => h.name === "Hermann")).toBe(false);
  });

  it("has exactly four branches: Jessie, Lisa, Princess, then the Executive group", () => {
    expect(tree.branches.map((b) => b.name)).toEqual(["Jessie", "Lisa", "Princess", "Executive"]);
  });

  it("maps each human-led branch to the real roster role", () => {
    const byKey = Object.fromEntries(tree.branches.map((b) => [b.department, b]));
    expect(byKey.sales.name).toBe(DEPARTMENT_LEAD.sales);
    expect(byKey.sales.role).toBe("Sales");
    expect(byKey.sales.human).toBe(true);
    expect(byKey.backoffice.name).toBe(DEPARTMENT_LEAD.backoffice);
    expect(byKey.backoffice.human).toBe(true);
    expect(byKey.marketing.name).toBe(DEPARTMENT_LEAD.marketing);
    expect(byKey.marketing.human).toBe(true);
  });

  it("places ops_exec as a non-human Executive group under Ownership", () => {
    const exec = tree.branches.find((b) => b.department === "ops_exec")!;
    expect(exec.name).toBe("Executive");
    expect(exec.human).toBe(false);
    expect(exec.key).toBe("executive");
  });

  it("places every AI employee under exactly one branch, with no loss or duplication", () => {
    const placed = tree.branches.flatMap((b) => b.agents.map((a) => a.id));
    expect(placed.length).toBe(AI_EMPLOYEES.length);
    expect(new Set(placed).size).toBe(AI_EMPLOYEES.length);
    expect([...placed].sort()).toEqual([...AI_EMPLOYEES.map((e) => e.id)].sort());
  });

  it("files each agent under the branch matching its own department", () => {
    for (const b of tree.branches) {
      for (const a of b.agents) expect(a.department).toBe(b.department);
    }
  });

  it("counts per department match the real registry", () => {
    const expected: Record<AiDept, number> = { sales: 0, backoffice: 0, marketing: 0, ops_exec: 0 };
    for (const e of AI_EMPLOYEES) expected[e.department]++;
    const byKey = Object.fromEntries(tree.branches.map((b) => [b.department, b.agents.length]));
    expect(byKey).toEqual(expected);
  });

  it("preserves each agent's honest backing + state (never fabricated)", () => {
    const flat = Object.fromEntries(tree.branches.flatMap((b) => b.agents).map((a) => [a.id, a]));
    for (const e of AI_EMPLOYEES) {
      expect(flat[e.id].backing).toBe(e.backing);
      if (e.backing === "coming") expect(flat[e.id].state).toBe("coming");
    }
  });

  it("gives each agent a non-empty department title", () => {
    for (const b of tree.branches) for (const a of b.agents) expect(a.title.length).toBeGreaterThan(0);
  });

  it("DEPARTMENT_LEAD names are all real people in HUMANS", () => {
    const names = new Set(HUMANS.map((h) => h.name));
    for (const dept of Object.keys(DEPARTMENT_LEAD) as AiDept[]) {
      expect(names.has(DEPARTMENT_LEAD[dept])).toBe(true);
    }
  });
});

describe("splitCoOwners", () => {
  it("splits a combined owner label into separate co-owner names", () => {
    expect(splitCoOwners("Hermann+Cindy")).toEqual(["Hermann", "Cindy"]);
    expect(splitCoOwners("Hermann & Cindy")).toEqual(["Hermann", "Cindy"]);
    expect(splitCoOwners("Hermann and Cindy")).toEqual(["Hermann", "Cindy"]);
  });
  it("leaves a single name as one tile", () => {
    expect(splitCoOwners("Jessie")).toEqual(["Jessie"]);
  });
});
