import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate a throwaway DB so the seo_* tables are created end-to-end.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-seo-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Import AFTER the env is set so getDb() opens the throwaway file.
async function store() {
  return import("./store");
}

describe("seo store — dedupe idempotency", () => {
  it("upsert is idempotent on keyword+intent+geography", async () => {
    const { upsertOpportunity, listOpportunities } = await store();
    const a = upsertOpportunity({ keyword: "Wedding Tent Rental", intent: "commercial", location: "Washington, DC" });
    // Same identity (case/space-insensitive), fresh research facts → updates in place, no duplicate.
    const b = upsertOpportunity({
      keyword: "  wedding   tent rental ",
      intent: "commercial",
      location: "washington, dc",
      metrics: { volume: 1300, difficulty: 42 },
      metricsSource: "ubersuggest",
      researchAt: new Date().toISOString(),
    });
    expect(b).toBe(a);
    const all = listOpportunities();
    expect(all).toHaveLength(1);
    expect(all[0].metrics?.volume).toBe(1300);
    expect(all[0].metricsSource).toBe("ubersuggest");
  });

  it("different intent or geography is a distinct opportunity", async () => {
    const { upsertOpportunity, listOpportunities } = await store();
    upsertOpportunity({ keyword: "wedding tent rental", intent: "informational", location: "Washington, DC" });
    upsertOpportunity({ keyword: "wedding tent rental", intent: "commercial", location: "Baltimore, MD" });
    // 1 from the first test + 2 new identities = 3.
    expect(listOpportunities().length).toBe(3);
  });

  it("absent metrics stay absent — never defaulted to 0", async () => {
    const { upsertOpportunity, getOpportunity } = await store();
    const id = upsertOpportunity({ keyword: "linen rental dc", intent: "transactional" });
    const o = getOpportunity(id)!;
    expect(o.metrics).toBeNull();
    expect(o.metricsSource).toBe("none");
    expect(o.recommendedAction).toBeNull();
    expect(o.priority).toBeNull();
    expect(o.status).toBe("new");
  });
});

describe("seo store — status workflow + history", () => {
  it("records a status transition in the decision history", async () => {
    const { upsertOpportunity, setOpportunityStatus, statusHistory, getOpportunity } = await store();
    const id = upsertOpportunity({ keyword: "chiavari chair rental", intent: "commercial" });
    // Creation already logged the initial `new`.
    expect(statusHistory(id).some((h) => h.toStatus === "new")).toBe(true);

    const ok = setOpportunityStatus(id, "awaiting_approval", "Tester", "looks promising");
    expect(ok).toBe(true);
    expect(getOpportunity(id)!.status).toBe("awaiting_approval");

    const hist = statusHistory(id);
    const latest = hist[0];
    expect(latest.toStatus).toBe("awaiting_approval");
    expect(latest.fromStatus).toBe("new");
    expect(latest.actor).toBe("Tester");
  });

  it("setOpportunityStatus returns false for a missing opportunity", async () => {
    const { setOpportunityStatus } = await store();
    expect(setOpportunityStatus("SEOP-does-not-exist", "approved", null)).toBe(false);
  });

  it("countsByStatus has every status present and reflects transitions", async () => {
    const { countsByStatus } = await store();
    const c = countsByStatus();
    // Every status key exists (0 when none) — the Overview relies on this.
    expect(Object.keys(c)).toEqual(expect.arrayContaining(["new", "awaiting_approval", "approved", "in_progress", "drafted", "published", "deferred", "rejected"]));
    expect(c.awaiting_approval).toBeGreaterThanOrEqual(1);
  });
});

describe("seo store — retrieval diagnostics", () => {
  it("records and reads back the latest overall + latest successful", async () => {
    const { recordRetrieval, latestDiagnostic, latestSuccess } = await store();
    recordRetrieval({ operation: "probe", ok: true, tool: "initialize", durationMs: 120 });
    recordRetrieval({ operation: "keyword_research", ok: false, detail: "HTTP 429", rateLimited: true, statusCode: 429 });

    const last = latestDiagnostic()!;
    expect(last.ok).toBe(false);
    expect(last.rateLimited).toBe(true);

    const ok = latestSuccess()!;
    expect(ok.ok).toBe(true);
    expect(ok.operation).toBe("probe");
  });
});
