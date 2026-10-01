import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-seo-stage-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function store() {
  return import("./store");
}

describe("seo store — Kanban stage + analysis", () => {
  it("new opportunities start in the DISCOVERED stage", async () => {
    const { upsertOpportunity, getOpportunity } = await store();
    const id = upsertOpportunity({ keyword: "stage tent rental", intent: "commercial", location: "DMV", category: "tents" });
    expect(getOpportunity(id)!.stage).toBe("DISCOVERED");
  });

  it("applies a legal stage transition and records it in the decision history", async () => {
    const { upsertOpportunity, setOpportunityStage, getOpportunity, decisionHistory } = await store();
    const id = upsertOpportunity({ keyword: "stage legal move", intent: "commercial", category: "tents" });
    const r = setOpportunityStage(id, "ANALYZING", "Tester", "auto-analyzed");
    expect(r.ok).toBe(true);
    expect(getOpportunity(id)!.stage).toBe("ANALYZING");
    const hist = decisionHistory(id);
    expect(hist[0].to).toBe("ANALYZING");
    expect(hist[0].from).toBe("DISCOVERED");
    expect(hist[0].actor).toBe("Tester");
  });

  it("rejects an illegal transition and writes nothing", async () => {
    const { upsertOpportunity, setOpportunityStage, getOpportunity, decisionHistory } = await store();
    const id = upsertOpportunity({ keyword: "stage illegal move", intent: "commercial", category: "tents" });
    const before = decisionHistory(id).length;
    const r = setOpportunityStage(id, "PUBLISHED", "Tester");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid");
    expect(getOpportunity(id)!.stage).toBe("DISCOVERED");
    expect(decisionHistory(id).length).toBe(before);
  });

  it("force bypasses the guard (admin override)", async () => {
    const { upsertOpportunity, setOpportunityStage, getOpportunity } = await store();
    const id = upsertOpportunity({ keyword: "stage force move", intent: "commercial", category: "tents" });
    const r = setOpportunityStage(id, "PUBLISHED", "Admin", "override", { force: true });
    expect(r.ok).toBe(true);
    expect(getOpportunity(id)!.stage).toBe("PUBLISHED");
  });

  it("returns not_found for a missing opportunity", async () => {
    const { setOpportunityStage } = await store();
    expect(setOpportunityStage("SEOP-missing", "ANALYZING", null).ok).toBe(false);
  });

  it("countsByStage has every stage present", async () => {
    const { countsByStage } = await store();
    const c = countsByStage();
    expect(Object.keys(c)).toEqual(expect.arrayContaining(["DISCOVERED", "ANALYZING", "APPROVED", "PUBLISHED", "REJECTED", "DEFERRED", "CONSOLIDATED", "BLOCKED"]));
    expect(c.DISCOVERED).toBeGreaterThanOrEqual(1);
  });

  it("setAnalysis persists the derived decision without touching the stage", async () => {
    const { upsertOpportunity, setAnalysis, getOpportunity } = await store();
    const id = upsertOpportunity({ keyword: "stage analysis write", intent: "commercial", category: "tents" });
    const ok = setAnalysis(id, {
      matchedUrl: "https://zoeeventsdmv.com/tents",
      recommendedAction: "IMPROVE",
      priority: 72,
      priorityBreakdown: { score: 72, components: [], summary: "test" },
      explanation: "because",
    });
    expect(ok).toBe(true);
    const o = getOpportunity(id)!;
    expect(o.recommendedAction).toBe("IMPROVE");
    expect(o.priority).toBe(72);
    expect(o.priorityBreakdown?.score).toBe(72);
    expect(o.matchedUrl).toContain("/tents");
    expect(o.stage).toBe("DISCOVERED"); // untouched
  });
});
