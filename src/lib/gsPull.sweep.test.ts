import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOfficePullScript, sweepProjects, SWEEP_SORTS } from "./gsPull";

// Goodshuffle (Nov 2026): searchProjects returns at most 100 rows a page and its pages overlap, so a single
// walk misses projects. The sweep walks several sort orders, dedupes by id and stops at Goodshuffle's total.

const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

describe("sweepProjects", () => {
  it("dedupes overlapping pages and keeps walking sort orders until it has Goodshuffle's total", async () => {
    // 250 projects. The first sort order's pages overlap and never show 200..249; the second shows them.
    const bySort: Record<string, { id: number }[][]> = {
      [SWEEP_SORTS[0]]: [ids(0, 100), ids(50, 100), ids(100, 100), []],
      [SWEEP_SORTS[1]]: [ids(150, 100), ids(0, 100), []],
    };
    const calls: string[] = [];
    const r = await sweepProjects(async (sort, n) => {
      calls.push(`${SWEEP_SORTS.indexOf(sort)}:${n}`);
      return { results: bySort[sort]?.[n] ?? [], totalResultCount: 250 };
    });
    expect(r.failed).toBe(false);
    expect(r.total).toBe(250);
    expect(r.projects.size).toBe(250);
    // Stops after the second order: the third is never read.
    expect(calls.some((c) => c.startsWith("2:"))).toBe(false);
  });

  it("stops after one order when that already covers the total", async () => {
    const r = await sweepProjects(async (_sort, n) => ({ results: n === 0 ? ids(0, 82) : [], totalResultCount: 82 }));
    expect(r.projects.size).toBe(82);
  });

  it("reports a short sweep when every order still falls short, and a fetch error as failed", async () => {
    const short = await sweepProjects(async (_s, n) => ({ results: n === 0 ? ids(0, 90) : [], totalResultCount: 100 }));
    expect(short.projects.size).toBeLessThan(short.total!);
    const err = await sweepProjects(async (_s, n) => (n === 1 ? null : { results: ids(0, 100), totalResultCount: 300 }));
    expect(err.failed).toBe(true);
  });
});

describe("both pull scripts sweep the same way", () => {
  const ext = readFileSync(fileURLToPath(new URL("../../extension/pull-injected.js", import.meta.url)), "utf8");
  const bm = buildOfficePullScript("https://zoe-dispatch.fly.dev");
  for (const [name, src] of [["extension", ext], ["bookmarklet", bm]] as const) {
    it(name, () => {
      for (const s of SWEEP_SORTS) expect(src).toContain(s);
      expect(src).toContain("&pageSize=100");
      expect(src).not.toContain("&pageSize=500");
      expect(src).toContain("totalResultCount");
      expect(src).toMatch(/totalReported: ?\(?total ?== ?null ?\? ?undefined ?: ?total\)?/);
    });
  }
});
