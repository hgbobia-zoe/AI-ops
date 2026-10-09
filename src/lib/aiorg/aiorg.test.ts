import { describe, it, expect } from "vitest";
import { AI_EMPLOYEES, BLADE_AGENTS, HUMANS, agentIdsForBlade } from "./registry";
import {
  authoritySplit,
  buildEmployeeView,
  pickKeySignal,
  priorityLabel,
  rollupHumans,
  type AIEmployee,
  type AiEmployeeView,
  type AiMetric,
  type BladeKey,
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

  it("a PAUSED employee reads as intentionally off (state 'idle' + paused flag), overriding active/health", () => {
    const v = buildEmployeeView(base(), { paused: true, active: true, health: { status: "ok", label: "Connected" }, metrics: [{ label: "Open", value: 3 }] });
    expect(v.state).toBe("idle");
    expect(v.paused).toBe(true);
    // Not paused by default.
    expect(buildEmployeeView(base()).paused).toBe(false);
  });

  it("a 'coming' employee is never paused (nothing to pause)", () => {
    const v = buildEmployeeView(base({ backing: "coming" }), { paused: true });
    expect(v.paused).toBe(false);
    expect(v.state).toBe("coming");
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

describe("pickKeySignal — the one in-blade signal", () => {
  const m = (label: string, value: string | number, tone?: AiMetric["tone"]): AiMetric => ({ label, value, tone });
  it("returns null when there are no metrics (a 'coming' agent)", () => {
    expect(pickKeySignal([])).toBeNull();
  });
  it("prefers a critical/attention-toned metric over a neutral one", () => {
    expect(pickKeySignal([m("Open", 3), m("Act now", 2, "attention")])?.label).toBe("Act now");
    expect(pickKeySignal([m("Open", 3, "attention"), m("Crit", 1, "critical")])?.label).toBe("Crit");
  });
  it("falls back to the first metric when tones are equal", () => {
    expect(pickKeySignal([m("First", 9), m("Second", 1)])?.label).toBe("First");
  });
});

describe("blade mapping — per-blade filtered view", () => {
  const ids = new Set(AI_EMPLOYEES.map((e) => e.id));
  const BLADES = Object.keys(BLADE_AGENTS) as BladeKey[];

  it("every id listed under a blade is a real employee", () => {
    for (const blade of BLADES) {
      for (const id of BLADE_AGENTS[blade]) expect(ids.has(id)).toBe(true);
    }
  });

  it("agentIdsForBlade returns the mapped ids", () => {
    expect(agentIdsForBlade("salesos")).toContain("lead-intelligence");
    expect(agentIdsForBlade("event-risk")).toContain("event-risk");
    expect(agentIdsForBlade("event-risk")).toContain("inventory-exception");
  });

  it("every employee declares a canonical blade and is listed under it", () => {
    for (const e of AI_EMPLOYEES) {
      expect(e.blade).toBeTruthy();
      expect(BLADE_AGENTS[e.blade as BladeKey]).toContain(e.id);
    }
  });

  it("every live / seed / partial agent surfaces in at least one blade (none orphaned)", () => {
    const placed = new Set(BLADES.flatMap((b) => BLADE_AGENTS[b]));
    for (const e of AI_EMPLOYEES) {
      if (e.backing !== "coming") expect(placed.has(e.id)).toBe(true);
    }
  });
});

describe("registry integrity", () => {
  it("has 21 employees with unique ids", () => {
    expect(AI_EMPLOYEES).toHaveLength(21);
    expect(new Set(AI_EMPLOYEES.map((e) => e.id)).size).toBe(21);
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

  it("the honest backing split matches the design doc (10 live, 1 seed, 7 partial, 3 coming)", () => {
    const by = { live: 0, seed: 0, partial: 0, coming: 0 };
    for (const e of AI_EMPLOYEES) by[e.backing]++;
    expect(by).toEqual({ live: 10, seed: 1, partial: 7, coming: 3 });
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
