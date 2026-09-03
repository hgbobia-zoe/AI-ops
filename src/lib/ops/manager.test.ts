import { describe, it, expect } from "vitest";
import { buildAttention, summarize, opsBrief, type OpsInputs } from "./manager";

const base: OpsInputs = { risks: [], nearTermGaps: [], dormantCount: 0 };

describe("ops manager — attention ranking", () => {
  it("ranks a critical imminent risk above a high one far out", () => {
    const items = buildAttention({
      ...base,
      risks: [
        { severity: "HIGH", title: "High far", description: "d", signature: "h1", daysUntil: 20 },
        { severity: "CRITICAL", title: "Critical soon", description: "d", signature: "c1", daysUntil: 1 },
      ],
    });
    expect(items[0].title).toBe("Critical soon");
    expect(items[0].priority).toBe("critical");
    expect(items[0].score).toBeGreaterThan(items[1].score);
  });

  it("adds sales gaps, labor overruns, and win-back as their own items", () => {
    const items = buildAttention({
      risks: [],
      nearTermGaps: [{ label: "Sep 6 – 12" }],
      labor: { verified: true, costVarianceValue: 500, costVariancePct: 0.2, favorable: false, alertPct: 0.1 },
      dormantCount: 3,
    });
    expect(items.find((i) => i.source === "sales")).toBeTruthy();
    expect(items.find((i) => i.source === "finance")?.title).toContain("20%");
    expect(items.find((i) => i.source === "customer")?.title).toContain("3 repeat customers");
  });

  it("does NOT raise a labor item when unverified or within threshold or favorable", () => {
    const unverified = buildAttention({ ...base, labor: { verified: false, costVarianceValue: 999, costVariancePct: 0.9, favorable: false, alertPct: 0.1 } });
    expect(unverified.find((i) => i.source === "finance")).toBeFalsy();
    const withinThreshold = buildAttention({ ...base, labor: { verified: true, costVarianceValue: 10, costVariancePct: 0.05, favorable: false, alertPct: 0.1 } });
    expect(withinThreshold.find((i) => i.source === "finance")).toBeFalsy();
    const favorable = buildAttention({ ...base, labor: { verified: true, costVarianceValue: -500, costVariancePct: -0.2, favorable: true, alertPct: 0.1 } });
    expect(favorable.find((i) => i.source === "finance")).toBeFalsy();
  });

  it("summarize + brief reflect the counts, and an empty feed reads as all-clear", () => {
    const empty = buildAttention(base);
    expect(summarize(empty).total).toBe(0);
    expect(opsBrief(empty, summarize(empty))).toContain("Nothing needs attention");

    const items = buildAttention({ ...base, risks: [{ severity: "CRITICAL", title: "X", description: "d", signature: "s", daysUntil: 0 }] });
    const sum = summarize(items);
    expect(sum.critical).toBe(1);
    expect(opsBrief(items, sum)).toContain("critical");
    expect(opsBrief(items, sum)).toContain("Start with: X");
  });
});
