import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferCategory, parseUbersuggestPosition } from "./ubersuggestProject";
import { scorePriority } from "./priority";

// Entries copied from a real project_position_info report (2026-11-03), so the parser is tested on the live shape.
const OK_NOT_RANKING = {
  keyword: "table chair rental", language: "en", loc_id: 2840, sd: 9, competition: 0.55, volume: 60500, si: null,
  old_position: { position: null, date: "2026-10-17", url: null }, new_position: { position: null, date: "2026-10-31", url: null },
  status: "ok", marked_unstable: false,
};
const UNSTABLE = {
  keyword: "party rentals", language: "en", loc_id: 2840, sd: 74, competition: 0.47, volume: 49500, si: [3, 4],
  old_position: null, new_position: null, status: "unstable", marked_unstable: true,
};
const RANKING = {
  keyword: "tent rental", loc_id: 2840, sd: 53, competition: 0.97, volume: 22200,
  old_position: { position: 18, date: "2026-10-17", url: "https://zoeeventsdmv.com/tents/" },
  new_position: { position: 12, date: "2026-10-31", url: "https://zoeeventsdmv.com/tents/" },
  status: "ok",
};

describe("parseUbersuggestPosition", () => {
  it("a final 'not ranking' reading records not_top_100 plus real volume and difficulty", () => {
    const p = parseUbersuggestPosition(OK_NOT_RANKING);
    expect(p.hasData).toBe(true);
    expect(p.metrics).toMatchObject({ volume: 60500, difficulty: 9, paidDifficulty: 55, locale: "US", rankStatus: "not_top_100", trackedRank: null, rankDate: "2026-10-31", previousRank: null });
    expect(p.providesRefs).toBe(false);
  });

  it("an unstable reading keeps volume but leaves the rank UNKNOWN, never 'not ranking'", () => {
    const p = parseUbersuggestPosition(UNSTABLE);
    expect(p.metrics.volume).toBe(49500);
    expect(p.metrics.rankStatus).toBeUndefined();
    expect(p.metrics.trackedRank).toBeUndefined();
  });

  it("a ranking reading records position, URL and the previous position", () => {
    const p = parseUbersuggestPosition(RANKING);
    expect(p.metrics).toMatchObject({ rankStatus: "ranking", trackedRank: 12, previousRank: 18, rankUrl: "https://zoeeventsdmv.com/tents/" });
  });

  it("an empty entry has no data", () => {
    expect(parseUbersuggestPosition({ keyword: "x", status: "pending" }).hasData).toBe(false);
    expect(parseUbersuggestPosition(null).hasData).toBe(false);
  });
});

describe("inferCategory", () => {
  it("maps tracked keywords onto Zoe categories", () => {
    expect(inferCategory("dance floors")).toBe("dance floors");
    expect(inferCategory("rental of chairs and tables near me")).toBe("tables");
    expect(inferCategory("chairs for rent near me")).toBe("chairs");
    expect(inferCategory("rent a tent near me")).toBe("tents");
    expect(inferCategory("party rentals")).toBe("extras");
    expect(inferCategory("something else")).toBe("uncategorized");
  });
});

describe("competitive gap from tracked rank (no SERP read)", () => {
  const match = { action: "CREATE" as const, confidence: 0.6, matchedUrl: null, matchedPath: null, candidates: [], reason: "" };
  const gap = (metrics: Parameters<typeof scorePriority>[0]["metrics"]) =>
    scorePriority({ intent: "commercial", category: "tents", metrics, match }).components.find((c) => c.key === "competitive_gap")!;

  it("not in the top 100 is a known gap, not a placeholder", () => {
    const c = gap(parseUbersuggestPosition(OK_NOT_RANKING).metrics);
    expect(c.unknown).toBe(false);
    expect(c.score).toBe(72);
    expect(c.evidence).toContain("not in the top 100");
  });

  it("page 2 is a push-to-page-1 opportunity; top 3 is defend", () => {
    expect(gap(parseUbersuggestPosition(RANKING).metrics).score).toBe(82);
    expect(gap({ rankStatus: "ranking", trackedRank: 2 }).score).toBe(25);
  });

  it("an unknown rank stays the neutral placeholder", () => {
    const c = gap(parseUbersuggestPosition(UNSTABLE).metrics);
    expect(c.unknown).toBe(true);
  });
});

// ── through the real ingest pipeline (temp DB) ─────────────────────────────────────────────────────
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "aiops-seo-ubproj-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("ingestKeywordResults — ubersuggest_project source", () => {
  it("creates opportunities with Ubersuggest metrics, US geo and an inferred category; skips empty entries", async () => {
    const { ingestKeywordResults } = await import("./discovery");
    const { listOpportunities } = await import("./store");
    const r = ingestKeywordResults({
      keywords: [
        { keyword: OK_NOT_RANKING.keyword, rawResult: OK_NOT_RANKING },
        { keyword: UNSTABLE.keyword, rawResult: UNSTABLE },
        { keyword: "empty one", rawResult: { status: "pending" } },
      ],
      meta: { source: "ubersuggest_project", toolName: "project_position_info" },
    });
    expect(r.received).toBe(3);
    expect(r.created).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.errors).toBe(0);

    const opp = listOpportunities().find((o) => o.keyword === "table chair rental")!;
    expect(opp.location).toBe("US");
    expect(opp.category).toBe("tables");
    expect(opp.metricsSource).toBe("ubersuggest");
    expect(opp.metrics?.volume).toBe(60500);
    expect(opp.stage).toBe("ANALYZING");
    expect(opp.priorityBreakdown?.components.find((c) => c.key === "demand")?.unknown).toBe(false);
  });

  it("a later SERP read of the same keyword keeps the Ubersuggest volume", async () => {
    const { ingestKeywordResults } = await import("./discovery");
    const { listOpportunities, upsertOpportunity } = await import("./store");
    // Same dedupe identity, a source that carries no metrics and no refs.
    upsertOpportunity({ keyword: "table chair rental", intent: "commercial", location: "US", metrics: null, metricsSource: "none", source: "serp" });
    const opp = listOpportunities().find((o) => o.keyword === "table chair rental")!;
    expect(opp.metrics?.volume).toBe(60500);
    expect(opp.metricsSource).toBe("ubersuggest");
    // And a re-push of the weekly report refreshes in place (no duplicate).
    const r = ingestKeywordResults({ keywords: [{ keyword: OK_NOT_RANKING.keyword, rawResult: OK_NOT_RANKING }], meta: { source: "ubersuggest_project" } });
    expect(r.updated).toBe(1);
    expect(listOpportunities().filter((o) => o.keyword === "table chair rental")).toHaveLength(1);
  });
});
