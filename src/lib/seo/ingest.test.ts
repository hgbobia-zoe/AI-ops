import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real store against a temp DB (migrations run on first getDb()); only the office-runner MCP boundary would
// be mocked, and ingest doesn't call it — it receives already-pulled data. Mirrors discovery.test.ts.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-seo-ingest-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function disc() {
  return import("./discovery");
}
async function store() {
  return import("./store");
}

describe("ingestKeywordResults — office-runner PUSH path", () => {
  it("parses pushed raw results, upserts opportunities, analyzes + advances to ANALYZING", async () => {
    const { ingestKeywordResults } = await disc();
    const { listOpportunities } = await store();
    const r = ingestKeywordResults({
      keywords: [
        { keyword: "tent rental", category: "tents", location: "DMV", intent: "commercial", rawResult: { volume: 1300, difficulty: 28, related: ["wedding tent rental"], competitors: ["competitor.com"] } },
        { keyword: "chiavari chair rental", category: "chairs", location: "DMV", intent: "commercial", rawResult: { volume: 480, difficulty: 19 } },
      ],
      meta: { toolName: "keyword_overview", retrievedAt: new Date().toISOString() },
    });
    expect(r.received).toBe(2);
    expect(r.created).toBe(2);
    expect(r.analyzed).toBe(2);
    expect(r.errors).toBe(0);
    expect(r.limitHit).toBe(false);

    const opps = listOpportunities();
    const tent = opps.find((o) => o.keyword === "tent rental");
    expect(tent).toBeTruthy();
    expect(tent!.metrics?.volume).toBe(1300);
    expect(tent!.stage).toBe("ANALYZING"); // auto-advanced by reanalyze
    expect(tent!.priority).not.toBeNull(); // analyzed
  });

  it("is idempotent — re-ingesting the same keyword refreshes, never duplicates", async () => {
    const { ingestKeywordResults } = await disc();
    const { listOpportunities } = await store();
    const before = listOpportunities().length;
    const r = ingestKeywordResults({ keywords: [{ keyword: "tent rental", category: "tents", location: "DMV", intent: "commercial", rawResult: { volume: 1500, difficulty: 30 } }] });
    expect(r.created).toBe(0);
    expect(r.updated).toBe(1);
    const after = listOpportunities();
    expect(after.length).toBe(before); // no new row
    expect(after.find((o) => o.keyword === "tent rental")!.metrics?.volume).toBe(1500); // refreshed
  });

  it("gates out junk (sub-floor volume) and never fabricates a row", async () => {
    const { ingestKeywordResults } = await disc();
    const { findOpportunityByDedupe } = await store();
    const r = ingestKeywordResults({ keywords: [{ keyword: "nonsense term", category: "extras", location: "DMV", intent: "commercial", rawResult: { volume: 3 } }] });
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(0);
    expect(findOpportunityByDedupe("nonsense term", "commercial", "DMV")).toBeNull();
  });

  it("records a bad keyword as an error without aborting the batch (failure isolation)", async () => {
    const { ingestKeywordResults } = await disc();
    const r = ingestKeywordResults({
      keywords: [
        { keyword: "", category: "tents", location: "DMV", rawResult: {} }, // invalid
        { keyword: "dance floor rental", category: "dance floors", location: "DMV", intent: "commercial", rawResult: { volume: 260 } }, // valid
      ],
    });
    expect(r.errors).toBe(1);
    expect(r.created).toBe(1); // the valid one still landed
  });

  it("a limit-hit records a rate-limited diagnostic and fabricates NO data", async () => {
    const { ingestKeywordResults } = await disc();
    const { latestRateLimited, listOpportunities } = await store();
    const before = listOpportunities().length;
    const r = ingestKeywordResults({ keywords: [], meta: { limitHit: true, quota: { resetAt: "2026-01-01T00:00:00Z" } } });
    expect(r.limitHit).toBe(true);
    expect(r.created).toBe(0);
    expect(listOpportunities().length).toBe(before); // nothing created
    const limited = latestRateLimited();
    expect(limited).toBeTruthy();
    expect(limited!.rateLimited).toBe(true);
  });

  it("captures the first-run tool schema as a diagnostic", async () => {
    const { ingestKeywordResults } = await disc();
    const { recentDiagnostics } = await store();
    ingestKeywordResults({ keywords: [], meta: { toolName: "keyword_overview", toolsList: [{ name: "keyword_overview" }, { name: "related_keywords" }] } });
    const schema = recentDiagnostics(20).find((d) => d.operation === "ingest.schema");
    expect(schema).toBeTruthy();
    expect(schema!.detail).toContain("keyword_overview");
  });
});

describe("pendingSeedKeywords — free-tier drip resume", () => {
  it("excludes already-discovered seeds so the runner never re-pulls them", async () => {
    const { pendingSeedKeywords, buildSeedKeywords } = await disc();
    const all = buildSeedKeywords().length;
    const pending = pendingSeedKeywords();
    // "tent rental"/DMV + "chiavari chair rental"/DMV + "dance floor rental"/DMV were ingested above.
    expect(pending.length).toBeLessThan(all);
    expect(pending.some((s) => s.keyword === "tent rental" && s.location === "DMV")).toBe(false);
    // and the limit option bounds the drip batch
    expect(pendingSeedKeywords({ limit: 3 }).length).toBe(3);
  });
});
