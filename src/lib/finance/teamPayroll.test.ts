import { describe, it, expect } from "vitest";
import {
  pickupWindow, revenueServed, resolveTeam, summarizeTeamPayroll, UNASSIGNED_TEAM,
  REVENUE_SERVED_NOTE, PAYROLL_BASIS_NOTE, type TeamPayrollWorkerInput,
} from "./teamPayroll";

// The real review week that exposed the bug: Mon Oct 26 to Sun Nov 1, 2026. Payroll Review showed $3,724.44
// for 229.61h across 10 workers; signed events dated that week were $2,833 and the week before $10,504; the
// attribution cascade only found $950 of internal route labor.
function w(key: string, team: string, hours: number | null, estPay: number | null): TeamPayrollWorkerInput {
  return { key, name: key, hours, estPay, team, teamSource: team === UNASSIGNED_TEAM ? "none" : "people" };
}
const WEEK_WORKERS: TeamPayrollWorkerInput[] = [
  w("W1", "Warehouse and prep", 40, 680), w("W2", "Warehouse and prep", 38, 646), w("W3", "Warehouse and prep", 20.5, 350),
  w("S1", "Sales (PH)", 40, 360), w("S2", "Sales (PH)", 38.6, 347.64),
  w("D1", "Drivers and crew", 20, 400), w("D2", "Drivers and crew", 15, 300),
  w("B1", "Back office", 8, 280), w("B2", "Back office", 5.51, 200.8), w("B3", "Back office", 4, 160),
];

describe("revenue served (cycle aware: half delivery week, half pickup week)", () => {
  it("the pickup window is the range shifted back one week", () => {
    expect(pickupWindow("2026-10-26", "2026-11-01")).toEqual({ start: "2026-10-19", end: "2026-10-25" });
    // Works across a month and year boundary too.
    expect(pickupWindow("2026-01-01", "2026-01-31")).toEqual({ start: "2025-12-25", end: "2026-01-24" });
  });

  it("is half of this range's signed events plus half of the prior week's", () => {
    expect(revenueServed(2833, 10504)).toBe(6668.5);
  });

  it("treats a missing side as zero only when the other side is known; both missing stays unknown", () => {
    expect(revenueServed(2000, null)).toBe(1000);
    expect(revenueServed(null, 3000)).toBe(1500);
    expect(revenueServed(null, null)).toBeNull();
  });

  it("states its bases in plain sentences with no dashes", () => {
    for (const s of [REVENUE_SERVED_NOTE, PAYROLL_BASIS_NOTE]) expect(s).not.toMatch(/[—–]| - /);
  });
});

describe("resolveTeam", () => {
  it("prefers the People department over the scheduled role", () => {
    const r = resolveTeam({ department: "sales", shiftRoles: new Map([["driver", 3]]), workerType: "EMPLOYEE", country: null });
    expect(r).toEqual({ team: "Sales", source: "people" });
  });

  it("falls back to the most scheduled shift role in the range", () => {
    const r = resolveTeam({ department: null, shiftRoles: new Map([["prep", 4], ["driver", 1]]), workerType: "EMPLOYEE", country: null });
    expect(r).toEqual({ team: "Warehouse and prep", source: "schedule" });
  });

  it("keeps offshore cost visible with the country, and flags an unknown international contractor", () => {
    expect(resolveTeam({ department: "sales_associate", shiftRoles: null, workerType: "INTERNATIONAL_CONTRACTOR", country: "PH" }).team).toBe("Sales (PH)");
    expect(resolveTeam({ department: null, shiftRoles: null, workerType: "INTERNATIONAL_CONTRACTOR", country: "PH" })).toEqual({ team: "International (PH)", source: "worker_type" });
    expect(resolveTeam({ department: "admin", shiftRoles: null, workerType: "EMPLOYEE", country: "US" }).team).toBe("Back office");
  });

  it("never guesses: no department, no shifts, a US worker is Unassigned", () => {
    expect(resolveTeam({ department: null, shiftRoles: new Map(), workerType: "EMPLOYEE", country: null })).toEqual({ team: UNASSIGNED_TEAM, source: "none" });
    expect(resolveTeam({ department: "unknown_policy", shiftRoles: null, workerType: "US_CONTRACTOR", country: null }).team).toBe(UNASSIGNED_TEAM);
  });
});

describe("summarizeTeamPayroll", () => {
  const base = { connecteamOk: true, deliveryRevenue: 2833, pickupRevenue: 10504, attributedLabor: 950, tempLabor: null };

  it("Oct 26 to Nov 1: payroll is 56% of revenue served, not 131% of the week's events, and the margin after payroll is 44%", () => {
    const s = summarizeTeamPayroll({ ...base, workers: WEEK_WORKERS });
    expect(s.available).toBe(true);
    expect(s.payroll).toBe(3724.44); // equals Payroll Review's Est. gross for that week
    expect(s.hours).toBe(229.61);
    expect(s.workerCount).toBe(10);
    expect(s.revenue).toEqual({ delivery: 2833, pickup: 10504, served: 6668.5 });
    expect(s.payrollPctOfServed).toBe(0.5585);
    expect(s.payrollPctOfDelivery).toBe(1.3147);
    expect(s.marginAfterPayroll).toBe(0.4415);
    // The per-project margins only ever saw a quarter of real payroll.
    expect(s.attributedShareOfPayroll).toBe(0.2551);
  });

  it("breaks payroll down by team, largest first, with shares of the total", () => {
    const s = summarizeTeamPayroll({ ...base, workers: WEEK_WORKERS });
    expect(s.teams.map((t) => [t.team, t.cost, t.workers])).toEqual([
      ["Warehouse and prep", 1676, 3],
      ["Sales (PH)", 707.64, 2],
      ["Drivers and crew", 700, 2],
      ["Back office", 640.8, 3],
    ]);
    expect(s.teams[0].share).toBe(0.45);
    expect(s.teams.reduce((n, t) => n + t.cost, 0)).toBeCloseTo(3724.44, 2);
    expect(s.unassignedCount).toBe(0);
  });

  it("marks payroll as a floor when a paid worker has no estimate, and lists who", () => {
    const s = summarizeTeamPayroll({ ...base, workers: [...WEEK_WORKERS, w("X1", UNASSIGNED_TEAM, 6, null)] });
    expect(s.payroll).toBe(3724.44);
    expect(s.partial).toBe(true);
    expect(s.missingEstimate).toEqual(["X1"]);
    expect(s.unassignedCount).toBe(1);
    expect(s.workers.find((r) => r.key === "X1")?.cost).toBeNull();
  });

  it("is unavailable, never zero, when Connecteam could not be read", () => {
    const s = summarizeTeamPayroll({ ...base, connecteamOk: false, workers: WEEK_WORKERS });
    expect(s.available).toBe(false);
    expect(s.payroll).toBeNull();
    expect(s.hours).toBeNull();
    expect(s.payrollPctOfServed).toBeNull();
    expect(s.marginAfterPayroll).toBeNull();
    // Revenue is still reported; it does not depend on Connecteam.
    expect(s.revenue.served).toBe(6668.5);
  });

  it("does not divide by an unknown or zero revenue", () => {
    const s = summarizeTeamPayroll({ ...base, deliveryRevenue: null, pickupRevenue: null, workers: WEEK_WORKERS });
    expect(s.revenue.served).toBeNull();
    expect(s.payrollPctOfServed).toBeNull();
    expect(s.marginAfterPayroll).toBeNull();
  });

  it("ignores roster entries with no hours in the range", () => {
    const s = summarizeTeamPayroll({ ...base, workers: [w("A", "Sales", 0, 0), w("B", "Sales", 10, 200)] });
    expect(s.workerCount).toBe(1);
    expect(s.payroll).toBe(200);
  });
});
