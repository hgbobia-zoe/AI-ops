import { describe, it, expect, beforeEach } from "vitest";
import { assembleInsightFacts, buildInsightPrompt, interpretInsights, type InsightProjectInput, type InsightsInput } from "./insights";
import type { InsightsConfig } from "./config";

const config: InsightsConfig = { lowMarginPct: 0.2, minCategorySample: 3 };

function p(over: Partial<InsightProjectInput>): InsightProjectInput {
  return {
    projectId: "x",
    label: "X",
    eventDate: null,
    marginPct: null,
    contribution: null,
    revenue: null,
    status: "ESTIMATED",
    directCostStatus: "ESTIMATED",
    laborMethod: "PLANNED",
    laborConfidence: "LOW",
    keywords: [],
    ...over,
  };
}

// Four margin-bearing projects (avg 27.5%), two of them low-margin; three carry a "tent" item that runs below book.
const projects: InsightProjectInput[] = [
  p({ projectId: "1", marginPct: 0.4, keywords: ["tent"], directCostStatus: "ESTIMATED" }),
  p({ projectId: "2", marginPct: 0.1, keywords: ["tent"], directCostStatus: "ESTIMATED" }),
  p({ projectId: "3", marginPct: 0.1, keywords: ["tent"], directCostStatus: "ACTUAL" }),
  p({ projectId: "4", marginPct: 0.5, keywords: [], directCostStatus: "ESTIMATED" }),
  p({ projectId: "5", marginPct: null, keywords: ["chair"], directCostStatus: "ESTIMATED" }), // excluded from margin math
];

describe("assembleInsightFacts — deterministic facts (Stage 7c)", () => {
  it("computes the margin distribution (null margins excluded, never read as zero)", () => {
    const { facts, overview } = assembleInsightFacts({ periodLabel: "This week", projects, runs: [], config });
    expect(overview.marginProjectCount).toBe(4);
    expect(overview.avgMarginPct).toBe(0.275);
    expect(overview.lowMarginCount).toBe(2); // P2, P3 (<= 0.2)

    const avg = facts.find((f) => f.id === "margin.avg")!;
    expect(avg.metrics.projectCount).toBe(4);
    expect(avg.metrics.avgMarginPct).toBe(0.275);
    const low = facts.find((f) => f.id === "margin.low")!;
    expect(low.metrics.lowMarginCount).toBe(2);
  });

  it("computes the labor-grain pattern (estimated vs actual) over all projects with labor", () => {
    const { facts, overview } = assembleInsightFacts({ periodLabel: "This week", projects, runs: [], config });
    expect(overview.laborProjectCount).toBe(5); // all carry a laborMethod
    expect(overview.estimatedLaborCount).toBe(4);
    expect(overview.actualLaborCount).toBe(1);
    const grain = facts.find((f) => f.id === "labor.grain")!;
    expect(grain.metrics.estimatedCount).toBe(4);
    expect(grain.metrics.actualCount).toBe(1);
  });

  it("flags a recurring low-margin category only when the sample is sufficient AND the gap is material", () => {
    const { facts, overview } = assembleInsightFacts({ periodLabel: "This week", projects, runs: [], config });
    const tent = facts.find((f) => f.id === "category.tent")!;
    expect(tent).toBeTruthy();
    expect(tent.metrics.count).toBe(3);
    expect(tent.metrics.avgMarginPct).toBe(0.2); // (0.4+0.1+0.1)/3
    expect(tent.metrics.deltaVsOverallPct).toBe(-0.075); // 0.2 - 0.275
    const tentCat = overview.categories.find((c) => c.keyword === "tent")!;
    expect(tentCat.thin).toBe(false);
    // "chair" never reaches the category stats — its only project has a null margin (excluded).
    expect(overview.categories.find((c) => c.keyword === "chair")).toBeUndefined();
  });

  it("labels a thin category (below min sample) as thin rather than asserting a trend", () => {
    const thinProjects: InsightProjectInput[] = [
      p({ projectId: "a", marginPct: 0.1, keywords: ["stage"] }),
      p({ projectId: "b", marginPct: 0.1, keywords: ["stage"] }),
      p({ projectId: "c", marginPct: 0.9, keywords: [] }),
    ];
    const { facts, overview } = assembleInsightFacts({ periodLabel: "W", projects: thinProjects, runs: [], config });
    const thin = facts.find((f) => f.id === "category.stage.thin");
    expect(thin?.thin).toBe(true);
    expect(overview.categories.find((c) => c.keyword === "stage")!.thin).toBe(true);
    expect(facts.find((f) => f.id === "category.stage")).toBeUndefined(); // not asserted as a trend
  });

  it("aggregates reconciliation-run variance reasons into trend facts", () => {
    const runs = [
      { projectId: "1", lines: [{ reason: "late_timesheet" as const, delta: 100 }, { reason: "refund" as const, delta: -30 }] },
      { projectId: "2", lines: [{ reason: "labor_actualized" as const, delta: 50 }] },
    ];
    const { facts } = assembleInsightFacts({ periodLabel: "W", projects: [], runs, config });
    const labor = facts.find((f) => f.id === "recon.labor_moves")!;
    expect(labor.metrics.lateTimesheetCount).toBe(1);
    expect(labor.metrics.laborActualizedCount).toBe(1);
    const refund = facts.find((f) => f.id === "recon.refunds")!;
    expect(refund.metrics.refundLineCount).toBe(1);
    expect(refund.metrics.netRefund).toBe(-30);
  });

  it("produces no facts from an empty set (nothing inferred from nothing)", () => {
    const empty: InsightsInput = { periodLabel: "W", projects: [], runs: [], config };
    expect(assembleInsightFacts(empty).facts).toEqual([]);
  });
});

describe("buildInsightPrompt — the LLM sees ONLY the computed facts (never asked to produce numbers)", () => {
  it("carries the facts verbatim and no other numeric content", () => {
    const { facts } = assembleInsightFacts({ periodLabel: "This week", projects, runs: [], config });
    const prompt = buildInsightPrompt(facts, "This week");

    expect(prompt[0].role).toBe("system");
    expect(prompt[0].content).toMatch(/do not state any number/i);
    // The system instruction itself contains no digits — it cannot smuggle a number into the model.
    expect(prompt[0].content).not.toMatch(/[0-9]/);

    expect(prompt[1].role).toBe("user");
    const payload = JSON.parse(prompt[1].content) as { period: string; facts: { id: string; metrics: Record<string, unknown>; statement: string }[] };
    expect(payload.period).toBe("This week");
    // Every fact in the payload is exactly one we computed — same ids and same metrics, nothing added.
    expect(payload.facts.map((f) => f.id).sort()).toEqual(facts.map((f) => f.id).sort());
    for (const pf of payload.facts) {
      const src = facts.find((f) => f.id === pf.id)!;
      expect(pf.metrics).toEqual(src.metrics);
      expect(pf.statement).toBe(src.text);
    }
  });
});

describe("interpretInsights — dormant-safe (facts-only honest path when no model configured)", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_API_KEY;
  });

  it("returns no interpretation and an honest note when no LLM is configured", async () => {
    const { facts } = assembleInsightFacts({ periodLabel: "This week", projects, runs: [], config });
    const r = await interpretInsights(facts, "This week");
    expect(r.interpretation).toBeNull();
    expect(r.note).toMatch(/AI interpretation unavailable/i);
  });

  it("does not even attempt interpretation for an empty fact set", async () => {
    const r = await interpretInsights([], "This week");
    expect(r.interpretation).toBeNull();
    expect(r.note).toMatch(/no facts/i);
  });
});
