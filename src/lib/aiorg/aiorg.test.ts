import { describe, it, expect } from "vitest";
import { AI_EMPLOYEES, HUMANS } from "./registry";
import {
  authoritySplit,
  buildEmployeeView,
  priorityLabel,
  rollupHumans,
  type AIEmployee,
  type AiEmployeeView,
  type Tool,
} from "./types";

const base = (over: Partial<AIEmployee> = {}): AIEmployee => ({
  id: "x",
  name: "X",
  department: "sales",
  owner: "Jessie",
  mission: "m",
  responsibilities: [],
  inputs: [],
  toolbox: [],
  escalationRules: [],
  backing: "live",
  valueMeasure: "v",
  ...over,
});

describe("buildEmployeeView — honesty enforcement", () => {
  it("a 'coming' employee NEVER shows metrics and is state 'coming'", () => {
    const v = buildEmployeeView(base({ backing: "coming" }), { metrics: [{ label: "x", value: 5 }], lastRunAt: "2026-01-01T00:00:00Z" });
    expect(v.state).toBe("coming");
    expect(v.metrics).toEqual([]);
    expect(v.lastRunAt).toBeNull();
    expect(v.health).toBeNull();
  });

  it("an OFF / ATTENTION data source degrades the employee to 'attention'", () => {
    const off = buildEmployeeView(base(), { health: { status: "off", label: "Not connected" }, metrics: [] });
    expect(off.state).toBe("attention");
    const att = buildEmployeeView(base(), { health: { status: "attention", label: "Stale" }, metrics: [] });
    expect(att.state).toBe("attention");
  });

  it("an inactive-but-healthy employee is 'idle'; an active one is 'ok'", () => {
    expect(buildEmployeeView(base(), { active: false, metrics: [] }).state).toBe("idle");
    expect(buildEmployeeView(base(), { active: true, metrics: [{ label: "Open", value: 3 }] }).state).toBe("ok");
  });

  it("defaults to 'ok' with no signal", () => {
    expect(buildEmployeeView(base()).state).toBe("ok");
  });
});

describe("authoritySplit", () => {
  const t = (perm: Tool["perm"]): Tool => ({ id: perm, label: perm, category: "DATA", perm, backing: "x" });
  it("splits APPROVAL_REQUIRED from CAN and drops FORBIDDEN", () => {
    const { can, requiresApproval } = authoritySplit([t("READ"), t("ANALYZE"), t("DRAFT"), t("APPROVAL_REQUIRED"), t("EXECUTE"), t("FORBIDDEN")]);
    expect(can.map((x) => x.perm).sort()).toEqual(["ANALYZE", "DRAFT", "EXECUTE", "READ"]);
    expect(requiresApproval.map((x) => x.perm)).toEqual(["APPROVAL_REQUIRED"]);
  });
});

describe("priorityLabel", () => {
  it("maps critical/high/medium/info onto P0..P3", () => {
    expect(priorityLabel("critical")).toBe("P0");
    expect(priorityLabel("high")).toBe("P1");
    expect(priorityLabel("medium")).toBe("P2");
    expect(priorityLabel("info")).toBe("P3");
  });
});

describe("rollupHumans", () => {
  it("groups views by owner and carries the resolved counts", () => {
    const views: AiEmployeeView[] = [
      { id: "a", name: "A", department: "sales", owner: "Jessie", mission: "", backing: "live", state: "ok", metrics: [], lastRunAt: null, lastDetail: null, health: null },
      { id: "b", name: "B", department: "sales", owner: "Jessie", mission: "", backing: "live", state: "attention", metrics: [], lastRunAt: null, lastDetail: null, health: null },
      { id: "c", name: "C", department: "marketing", owner: "Princess", mission: "", backing: "seed", state: "ok", metrics: [], lastRunAt: null, lastDetail: null, health: null },
    ];
    const cards = rollupHumans(
      [{ name: "Jessie", role: "Sales" }, { name: "Princess", role: "Marketing" }],
      views,
      { Jessie: { openApprovals: 0, openExceptions: 1, aiActivityToday: 4 }, Princess: { openApprovals: 0, openExceptions: 0, aiActivityToday: 0 } },
    );
    expect(cards[0].employeeCount).toBe(2);
    expect(cards[0].openExceptions).toBe(1);
    expect(cards[0].aiActivityToday).toBe(4);
    expect(cards[1].employeeCount).toBe(1);
  });
});

describe("registry integrity", () => {
  it("has 19 employees with unique ids", () => {
    expect(AI_EMPLOYEES).toHaveLength(19);
    expect(new Set(AI_EMPLOYEES.map((e) => e.id)).size).toBe(19);
  });

  it("every employee's owner is a real human in HUMANS", () => {
    const names = new Set(HUMANS.map((h) => h.name));
    for (const e of AI_EMPLOYEES) expect(names.has(e.owner)).toBe(true);
  });

  it("every employee has a non-empty toolbox and mission", () => {
    for (const e of AI_EMPLOYEES) {
      expect(e.toolbox.length).toBeGreaterThan(0);
      expect(e.mission.length).toBeGreaterThan(0);
    }
  });

  it("the honest backing split matches the design doc (10 live, 1 seed, 6 partial, 2 coming)", () => {
    const by = { live: 0, seed: 0, partial: 0, coming: 0 };
    for (const e of AI_EMPLOYEES) by[e.backing]++;
    expect(by).toEqual({ live: 10, seed: 1, partial: 6, coming: 2 });
  });

  it("badges Event Radar as SEED and Hiring + Competitive Intelligence as COMING", () => {
    expect(AI_EMPLOYEES.find((e) => e.id === "event-radar")?.backing).toBe("seed");
    expect(AI_EMPLOYEES.find((e) => e.id === "hiring")?.backing).toBe("coming");
    expect(AI_EMPLOYEES.find((e) => e.id === "competitive-intelligence")?.backing).toBe("coming");
  });

  it("comms-send / money / schedule tools are APPROVAL_REQUIRED (never auto-executed)", () => {
    for (const e of AI_EMPLOYEES) {
      for (const t of e.toolbox) {
        if (t.category === "COMMS_SEND" || t.id === "change_price" || t.id === "publish_schedule" || t.id === "status_sync") {
          expect(t.perm).toBe("APPROVAL_REQUIRED");
        }
      }
    }
  });
});
