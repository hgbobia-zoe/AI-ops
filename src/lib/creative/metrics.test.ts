import { describe, it, expect } from "vitest";
import { computeMetrics, parseCost, parseProcessingMs, runProduced } from "./metrics";
import type {
  ExperimentProvider,
  ExperimentRun,
  HumanEval,
  FailureReason,
  RunGenerationView,
} from "./experimentTypes";
import type { QaReport } from "./types";

// ── Fixtures ────────────────────────────────────────────────────────────────
const provider = (id: string, label: string): ExperimentProvider => ({
  id,
  providerId: id === "P1" ? "openai-image" : "higgsfield",
  providerName: id === "P1" ? "OpenAI" : "Higgsfield",
  model: id === "P1" ? "gpt-image-1" : "higgsfield-soul",
  enabled: true,
  blindLabel: label,
  sortOrder: id === "P1" ? 0 : 1,
});

const run = (id: string, providerRefId: string, generationId: string | null): ExperimentRun => ({
  id,
  experimentId: "CX-1",
  caseId: "CXC-1",
  providerRefId,
  providerId: "x",
  model: null,
  blindLabel: "A",
  jobId: "CJ-1",
  generationId,
  status: generationId ? "succeeded" : "pending",
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
});

const qa = (verdict: "pass" | "fail", score: number, productAccuracy = score, brandAlignment = score, webUsability = score): QaReport => ({
  score,
  verdict,
  decision: verdict === "pass" ? "PASS" : "FAIL",
  method: "n8n",
  summary: "",
  checks: [],
  dimensions: {
    productAccuracy, referenceFidelity: score, photographicQuality: score, architecturalRealism: score,
    humanRealism: score, brandAlignment, composition: score, webUsability,
  },
  hardFailures: [],
  issues: [],
  recommendedChanges: [],
});

const gen = (id: string, opts: { qa?: QaReport | null; resultPath?: string | null; cost?: number | null; ms?: number | null; status?: string }): RunGenerationView => ({
  id,
  provider: "n8n",
  model: "gpt-image-1",
  resultPath: opts.resultPath === undefined ? "/img" : opts.resultPath,
  placeholder: false,
  status: opts.status ?? "pass",
  qaReport: opts.qa ?? null,
  qaScore: opts.qa?.score ?? null,
  cost: opts.cost == null ? { total: null, input: null, output: null, currency: "USD", known: false } : { total: opts.cost, input: null, output: null, currency: "USD", known: true },
  processingMs: opts.ms ?? null,
  createdAt: "2026-09-24T00:00:00.000Z",
});

describe("parseCost", () => {
  it("reads cost.usd from callback meta", () => {
    const c = parseCost({ cost: { usd: 0.36 } });
    expect(c.total).toBe(0.36);
    expect(c.known).toBe(true);
  });
  it("returns unknown (never fabricated) when absent", () => {
    expect(parseCost(null).known).toBe(false);
    expect(parseCost({}).known).toBe(false);
    expect(parseCost({ cost: {} }).total).toBeNull();
  });
  it("sums input+output when no total is given", () => {
    const c = parseCost({ cost: { input: 0.1, output: 0.2 } });
    expect(c.total).toBeCloseTo(0.3);
  });
});

describe("parseProcessingMs", () => {
  it("reads processingMs", () => expect(parseProcessingMs({ processingMs: 42000 })).toBe(42000));
  it("null when absent", () => expect(parseProcessingMs({})).toBeNull());
});

describe("runProduced", () => {
  it("true only for a resolved image", () => {
    expect(runProduced(gen("g", { resultPath: "/x", status: "pass" }))).toBe(true);
    expect(runProduced(gen("g", { resultPath: null, status: "generating" }))).toBe(false);
    expect(runProduced(gen("g", { resultPath: "/x", status: "error" }))).toBe(false);
    expect(runProduced(undefined)).toBe(false);
  });
});

describe("computeMetrics", () => {
  it("keeps AI QA and human approval separate and computes cost per approved image", () => {
    const providers = [provider("P1", "A"), provider("P2", "B")];
    const runs = [
      run("R1", "P1", "G1"),
      run("R2", "P1", "G2"),
      run("R3", "P2", "G3"),
    ];
    const generations: Record<string, RunGenerationView> = {
      G1: gen("G1", { qa: qa("pass", 90, 95, 88, 91), cost: 0.4, ms: 40000 }),
      G2: gen("G2", { qa: qa("fail", 50), cost: 0.4, ms: 20000 }),
      G3: gen("G3", { qa: qa("pass", 80), cost: 0.2, ms: 10000 }),
    };
    // Human: OpenAI R1 approved, R2 rejected; Higgsfield R3 rejected (PHOTOGRAPHY).
    const evals: HumanEval[] = [
      { id: "E1", runId: "R1", experimentId: "CX-1", caseId: "CXC-1", productAccuracy: "pass", realism: "pass", brandFit: "pass", composition: "pass", usability: "pass", overallApproval: "pass", decision: "approve", notes: null, evaluator: "T", createdAt: "", updatedAt: "" },
      { id: "E2", runId: "R2", experimentId: "CX-1", caseId: "CXC-1", productAccuracy: "fail", realism: "fail", brandFit: null, composition: null, usability: "fail", overallApproval: "fail", decision: "reject", notes: null, evaluator: "T", createdAt: "", updatedAt: "" },
      { id: "E3", runId: "R3", experimentId: "CX-1", caseId: "CXC-1", productAccuracy: "pass", realism: "fail", brandFit: null, composition: null, usability: "fail", overallApproval: "fail", decision: "reject", notes: null, evaluator: "T", createdAt: "", updatedAt: "" },
    ];
    const failures: FailureReason[] = [
      { id: "F1", runId: "R3", experimentId: "CX-1", category: "PHOTOGRAPHY", note: null, createdAt: "" },
    ];

    const m = computeMetrics(providers, runs, evals, failures, generations);
    const p1 = m.find((x) => x.providerRefId === "P1")!;
    const p2 = m.find((x) => x.providerRefId === "P2")!;

    // OpenAI: 2 gens, 2 successful, 1 QA pass, 1 human approved, 1 publishable (QA pass AND approved).
    expect(p1.generations).toBe(2);
    expect(p1.successful).toBe(2);
    expect(p1.aiQaPass).toBe(1);
    expect(p1.humanApproved).toBe(1);
    expect(p1.publishable).toBe(1);
    // Human approval rate = 1/2 evaluated = 50%; QA pass rate = 1/2 successful = 50%.
    expect(p1.humanApprovalRate).toBe(50);
    expect(p1.qaPassRate).toBe(50);
    // Cost per approved = total 0.8 / 1 approved = 0.8 (distinct from avg cost 0.4).
    expect(p1.avgCost).toBeCloseTo(0.4);
    expect(p1.costPerApproved).toBeCloseTo(0.8);
    expect(p1.avgProductAccuracy).toBeCloseTo((95 + 50) / 2); // averages across both QA reports

    // Higgsfield: 1 gen, QA pass but human-rejected → 0 publishable; cost per approved is unknown (0 approved).
    expect(p2.aiQaPass).toBe(1);
    expect(p2.humanApproved).toBe(0);
    expect(p2.publishable).toBe(0);
    expect(p2.costPerApproved).toBeNull();
    expect(p2.failureModes.PHOTOGRAPHY).toBe(1);
  });

  it("reports null rates/costs rather than fabricating when data is missing", () => {
    const providers = [provider("P1", "A")];
    const runs = [run("R1", "P1", "G1")];
    const generations: Record<string, RunGenerationView> = { G1: gen("G1", { qa: null, cost: null, ms: null }) };
    const m = computeMetrics(providers, runs, [], [], generations)[0];
    expect(m.aiQaPass).toBe(0);
    expect(m.humanApprovalRate).toBeNull(); // 0 evaluated
    expect(m.avgQaScore).toBeNull();
    expect(m.avgCost).toBeNull();
    expect(m.costPerApproved).toBeNull();
    expect(m.costKnown).toBe(false);
  });
});
