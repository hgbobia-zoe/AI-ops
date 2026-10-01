import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpResult } from "./ubersuggest";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-seo-disc-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function mod() {
  return import("./discovery");
}

// A mocked Ubersuggest boundary — the ONLY place mocks are allowed. Returns a representative keyword payload.
function mockOk(data: unknown): McpResult {
  return { ok: true, data, durationMs: 1, retrievedAt: new Date().toISOString() };
}

describe("discovery — result parsing (defensive, unverified schema)", () => {
  it("parses metrics, related, competitors and intent from a flat object", async () => {
    const { parseKeywordResult } = await mod();
    const p = parseKeywordResult({ volume: "1,200", difficulty: 35, cpc: 4.2, related: ["a", "b"], competitors: [{ domain: "x.com" }], intent: "commercial" });
    expect(p.metrics.volume).toBe(1200);
    expect(p.metrics.difficulty).toBe(35);
    expect(p.metrics.cpc).toBe(4.2);
    expect(p.hasMetrics).toBe(true);
    expect(p.relatedKeywords).toEqual(["a", "b"]);
    expect(p.competitorRefs).toEqual(["x.com"]);
    expect(p.intent).toBe("commercial");
  });

  it("leaves absent metrics UNKNOWN (never 0)", async () => {
    const { parseKeywordResult } = await mod();
    const p = parseKeywordResult({ related: ["x"] });
    expect(p.metrics.volume).toBeUndefined();
    expect(p.metrics.difficulty).toBeUndefined();
    expect(p.hasMetrics).toBe(false);
  });

  it("unwraps an MCP content envelope with JSON text", async () => {
    const { parseKeywordResult } = await mod();
    const p = parseKeywordResult({ content: [{ type: "text", text: JSON.stringify({ search_volume: 900, seo_difficulty: 12 }) }] });
    expect(p.metrics.volume).toBe(900);
    expect(p.metrics.difficulty).toBe(12);
  });
});

describe("discovery — gate", () => {
  it("rejects informational/navigational keywords", async () => {
    const { passesGate } = await mod();
    const seed = { keyword: "tent rental", category: "tents", location: "DMV", intent: "commercial" as const };
    expect(passesGate(seed, { metrics: {}, hasMetrics: false, relatedKeywords: [], competitorRefs: [], intent: "informational" })).toBe(false);
    expect(passesGate(seed, { metrics: {}, hasMetrics: false, relatedKeywords: [], competitorRefs: [], intent: "commercial" })).toBe(true);
  });

  it("rejects a known, very-low-volume keyword but keeps unknown volume", async () => {
    const { passesGate } = await mod();
    const seed = { keyword: "tent rental", category: "tents", location: "DMV", intent: "commercial" as const };
    expect(passesGate(seed, { metrics: { volume: 3 }, hasMetrics: true, relatedKeywords: [], competitorRefs: [], intent: "commercial" })).toBe(false);
    expect(passesGate(seed, { metrics: {}, hasMetrics: false, relatedKeywords: [], competitorRefs: [], intent: null })).toBe(true);
  });
});

describe("discovery — pipeline", () => {
  it("short-circuits honestly when not configured (no network, nothing created)", async () => {
    const { discover } = await mod();
    const r = await discover({ configured: () => false });
    expect(r.configured).toBe(false);
    expect(r.created).toBe(0);
    expect(r.attempted).toBe(0);
    expect(r.note.toLowerCase()).toContain("credential");
  });

  it("runs end-to-end against a mocked boundary: upserts, analyzes, advances to ANALYZING", async () => {
    const { discover } = await mod();
    const { listOpportunities } = await import("./store");
    const r = await discover({
      configured: () => true,
      callTool: async () => mockOk({ volume: 1300, difficulty: 28, related: ["wedding tent rental"], competitors: ["competitor.com"] }),
      categories: ["tents"],
      maxGeosPerCategory: 1,
      limit: 2,
    });
    expect(r.configured).toBe(true);
    expect(r.attempted).toBe(2);
    expect(r.created).toBeGreaterThanOrEqual(1);
    expect(r.analyzed).toBe(r.created + r.updated);

    const opps = listOpportunities({ limit: 100 }).filter((o) => o.category === "tents");
    expect(opps.length).toBeGreaterThanOrEqual(1);
    const o = opps[0];
    expect(o.metrics?.volume).toBe(1300);
    expect(o.metricsSource).toBe("ubersuggest");
    expect(o.recommendedAction).not.toBeNull();
    expect(o.priority).not.toBeNull();
    expect(o.stage).toBe("ANALYZING");
  });

  it("is idempotent — a second run refreshes rather than duplicates", async () => {
    const { discover } = await mod();
    const { listOpportunities } = await import("./store");
    const before = listOpportunities({ limit: 500 }).length;
    const r = await discover({
      configured: () => true,
      callTool: async () => mockOk({ volume: 1300, difficulty: 28 }),
      categories: ["tents"],
      maxGeosPerCategory: 1,
      limit: 2,
    });
    const after = listOpportunities({ limit: 500 }).length;
    expect(after).toBe(before); // no new rows
    expect(r.updated).toBeGreaterThanOrEqual(1);
  });
});
