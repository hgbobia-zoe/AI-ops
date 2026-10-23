import { describe, it, expect } from "vitest";
import { projectSnapshot, COST_FAMILIES, type ProjectSnapshotInput, type CostFamilyInput } from "./projectSnapshot";

function input(over: Partial<ProjectSnapshotInput> = {}): ProjectSnapshotInput {
  return {
    projectId: "P1",
    label: "Test project",
    eventDate: "2026-06-01",
    revenue: { grandTotal: 5000, contractTotal: 5200, amountPaid: 1000, amountDue: 4000, signed: true },
    costFamilies: [],
    stale: false,
    ...over,
  };
}
const labor = (amount: number, status: CostFamilyInput["status"], method = "PLANNED"): CostFamilyInput => ({ type: "labor", amount, status, method, confidence: "MEDIUM", leafCount: 2 });

describe("projectSnapshot — cost families: NEVER zero an untracked family", () => {
  it("fills the whole taxonomy; untracked families are UNAVAILABLE (null), never 0", () => {
    const snap = projectSnapshot(input({ costFamilies: [labor(1500, "ESTIMATED")] }));
    expect(snap.costFamilies).toHaveLength(COST_FAMILIES.length);
    const l = snap.costFamilies.find((f) => f.type === "labor")!;
    expect(l.tracked).toBe(true);
    expect(l.amount).toBe(1500);
    for (const f of snap.costFamilies.filter((f) => f.type !== "labor")) {
      expect(f.tracked).toBe(false);
      expect(f.amount).toBeNull(); // NOT 0
      expect(f.status).toBe("UNAVAILABLE");
    }
  });

  it("a family present but UNAVAILABLE (e.g. labor expected, rate missing) is treated as untracked, not 0", () => {
    const snap = projectSnapshot(input({ costFamilies: [{ type: "labor", amount: null, status: "UNAVAILABLE" }] }));
    const l = snap.costFamilies.find((f) => f.type === "labor")!;
    expect(l.tracked).toBe(false);
    expect(l.amount).toBeNull();
    expect(snap.directCost).toBeNull();
  });
});

describe("projectSnapshot — contribution never fabricated", () => {
  it("labor-only project: contribution = revenue − labor, labeled ESTIMATED", () => {
    const snap = projectSnapshot(input({ costFamilies: [labor(1500, "ESTIMATED")] }));
    expect(snap.directCost).toBe(1500);
    expect(snap.directCostStatus).toBe("ESTIMATED");
    expect(snap.contribution).toBe(3500);
    expect(snap.marginPct).toBe(0.7);
    expect(snap.contributionStatus).toBe("ESTIMATED");
  });

  it("no cost known → contribution + margin UNAVAILABLE (revenue is NOT profit)", () => {
    const snap = projectSnapshot(input({ costFamilies: [] }));
    expect(snap.directCost).toBeNull();
    expect(snap.contribution).toBeNull(); // a missing cost is not zero → no fake 100% margin
    expect(snap.marginPct).toBeNull();
    expect(snap.contributionStatus).toBe("UNAVAILABLE");
  });

  it("revenue unknown → contribution UNAVAILABLE even with a real cost", () => {
    const snap = projectSnapshot(input({ revenue: { grandTotal: null, contractTotal: null, amountPaid: null, amountDue: null, signed: false }, costFamilies: [labor(800, "ACTUAL")] }));
    expect(snap.contribution).toBeNull();
    expect(snap.revenue.contractedStatus).toBe("UNAVAILABLE");
  });
});

describe("projectSnapshot — reconciliation: families sum to the direct-cost total", () => {
  it("multi-family partition balances with residual 0 (forward-compat: more families than labor)", () => {
    const snap = projectSnapshot(
      input({ costFamilies: [labor(1200.5, "ESTIMATED"), { type: "sub_rental", amount: 300.25, status: "ACTUAL", method: null, confidence: null, leafCount: 1 }] }),
    );
    expect(snap.directCost).toBe(1500.75);
    expect(snap.reconciliation.familySum).toBe(1500.75);
    expect(snap.reconciliation.directCostTotal).toBe(1500.75);
    expect(snap.reconciliation.residual).toBe(0);
    expect(snap.reconciliation.balanced).toBe(true);
    expect(snap.directCostStatus).toBe("ESTIMATED"); // any estimated family drags the whole to ESTIMATED
  });

  it("no-cost project reconciles as balanced-empty (nulls, not zeros)", () => {
    const snap = projectSnapshot(input({ costFamilies: [] }));
    expect(snap.reconciliation.directCostTotal).toBeNull();
    expect(snap.reconciliation.familySum).toBeNull();
    expect(snap.reconciliation.balanced).toBe(true);
  });
});

describe("projectSnapshot — penny safety", () => {
  it("family amounts and contribution round to the cent", () => {
    const snap = projectSnapshot(input({ revenue: { grandTotal: 2000, contractTotal: 2000, amountPaid: 0, amountDue: 2000, signed: true }, costFamilies: [labor(1500.555, "ESTIMATED")] }));
    expect(snap.costFamilies.find((f) => f.type === "labor")!.amount).toBe(1500.56);
    expect(snap.directCost).toBe(1500.56);
    expect(snap.contribution).toBe(499.44);
    expect(snap.reconciliation.residual).toBe(0);
  });
});

describe("projectSnapshot — status derivation", () => {
  it("PROVISIONAL when there is no cost evidence at all", () => {
    expect(projectSnapshot(input({ costFamilies: [] })).status).toBe("PROVISIONAL");
  });

  it("ESTIMATED when fresh but labor is planned-grain (estimated)", () => {
    const snap = projectSnapshot(input({ costFamilies: [labor(1500, "ESTIMATED")], stale: false }));
    expect(snap.status).toBe("ESTIMATED");
  });

  it("ESTIMATED when cost is actual but revenue is not fully collected", () => {
    const snap = projectSnapshot(input({ revenue: { grandTotal: 5000, contractTotal: 5000, amountPaid: 1000, amountDue: 4000, signed: true }, costFamilies: [labor(2000, "ACTUAL")], stale: false }));
    expect(snap.status).toBe("ESTIMATED"); // never RECONCILED while revenue uncollected
  });

  it("RECONCILED only when all cost is actual, revenue fully collected, and data is fresh", () => {
    const snap = projectSnapshot(input({ revenue: { grandTotal: 5000, contractTotal: 5000, amountPaid: 5000, amountDue: 0, signed: true }, costFamilies: [labor(2000, "ACTUAL", "ACTUAL_STOP")], stale: false }));
    expect(snap.status).toBe("RECONCILED");
    expect(snap.contribution).toBe(3000);
    expect(snap.directCostStatus).toBe("ACTUAL");
  });

  it("full collection can be proven by paid ≥ contracted when amount_due is unknown", () => {
    const snap = projectSnapshot(input({ revenue: { grandTotal: 5000, contractTotal: 5000, amountPaid: 5000, amountDue: null, signed: true }, costFamilies: [labor(2000, "ACTUAL", "ACTUAL_STOP")], stale: false }));
    expect(snap.revenue.fullyCollected).toBe(true);
    expect(snap.status).toBe("RECONCILED");
  });

  it("stale data forces PROVISIONAL even when otherwise reconcilable", () => {
    const snap = projectSnapshot(input({ revenue: { grandTotal: 5000, contractTotal: 5000, amountPaid: 5000, amountDue: 0, signed: true }, costFamilies: [labor(2000, "ACTUAL", "ACTUAL_STOP")], stale: true }));
    expect(snap.status).toBe("PROVISIONAL");
  });
});

describe("projectSnapshot — revenue labeling (honest, not invented)", () => {
  it("signed vs quote and collected money are labeled correctly", () => {
    const signed = projectSnapshot(input());
    expect(signed.revenue.contractedStatus).toBe("SIGNED");
    expect(signed.revenue.dueStatus).toBe("SCHEDULED");
    expect(signed.revenue.collectedStatus).toBe("ACTUAL");

    const quote = projectSnapshot(input({ revenue: { grandTotal: 5000, contractTotal: 5200, amountPaid: null, amountDue: 5000, signed: false } }));
    expect(quote.revenue.contractedStatus).toBe("PROJECTED"); // a quote is not committed revenue
    expect(quote.revenue.dueStatus).toBe("PROJECTED");
    expect(quote.revenue.collectedStatus).toBe("UNAVAILABLE");
  });

  it("fees/discounts/refunds are flagged as not separated upstream (never invented)", () => {
    const snap = projectSnapshot(input());
    expect(snap.revenue.componentsTracked).toBe(false);
    expect(snap.notes.some((n) => /fees, discounts and refunds/i.test(n))).toBe(true);
  });
});
