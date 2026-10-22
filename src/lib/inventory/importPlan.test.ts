import { describe, expect, it } from "vitest";
import { buildImportPlan, mergeTags, normalizeTitle, type ImportPolicy, type PlanSourceItem } from "./importPlan";
import type { NormalizedImage } from "./storefront";

const img = (raw: string, primary = false, viewOrder = 0): NormalizedImage => ({
  raw,
  full: raw,
  thumb: raw,
  primary,
  viewOrder,
  fileName: "",
});

// Minimal source-item factory — only the fields the planner reads.
const src = (over: Partial<PlanSourceItem> = {}): PlanSourceItem => ({
  sourceId: over.sourceId ?? Math.random().toString(36).slice(2),
  title: over.title ?? "Velvet Sofa",
  descriptionHtml: over.descriptionHtml ?? "<p>comfy</p>",
  tags: over.tags ?? ["velvet"],
  images: over.images ?? [img("https://img/a.jpg", true, 0)],
  zoeGroup: over.zoeGroup ?? "sofa-rentals",
});

const POLICY: ImportPolicy = { unpriced: true, trackQuantity: false, addTags: ["Subrental", "Staging Design"] };

describe("normalizeTitle", () => {
  it("trims, lowercases and collapses internal whitespace", () => {
    expect(normalizeTitle("  Velvet   SOFA\tBlue ")).toBe("velvet sofa blue");
  });
});

describe("mergeTags", () => {
  it("merges source + add tags, de-duping case-insensitively, order + first casing preserved", () => {
    expect(mergeTags(["Velvet", "blue"], ["Subrental", "velvet", "Blue"])).toEqual(["Velvet", "blue", "Subrental"]);
  });
  it("drops blanks", () => {
    expect(mergeTags(["  ", "x"], ["", "y"])).toEqual(["x", "y"]);
  });
});

describe("buildImportPlan — dedupe", () => {
  it("skips an item already in Zoe's catalog (exact title)", () => {
    const plan = buildImportPlan([src({ title: "Velvet Sofa" })], [{ title: "Velvet Sofa" }], POLICY);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped).toEqual([{ title: "Velvet Sofa", reason: "already in Zoe catalog" }]);
  });

  it("dedupe is case- and whitespace-insensitive", () => {
    const plan = buildImportPlan([src({ title: "Velvet   Sofa" })], [{ title: "velvet sofa" }], POLICY);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("already in Zoe catalog");
  });

  it("skips a duplicate within the source batch itself", () => {
    const plan = buildImportPlan([src({ title: "Velvet Sofa", sourceId: "1" }), src({ title: "VELVET SOFA", sourceId: "2" })], [], POLICY);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0].sourceId).toBe("1");
    expect(plan.skipped).toEqual([{ title: "VELVET SOFA", reason: "duplicate within source batch" }]);
  });

  it("skips an item with no title", () => {
    const plan = buildImportPlan([src({ title: "   " })], [], POLICY);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped).toEqual([{ title: "(untitled)", reason: "missing title" }]);
  });
});

describe("buildImportPlan — planned item content", () => {
  it("merges tags, carries the zoeGroup, and carries the policy flags through", () => {
    const plan = buildImportPlan([src({ title: "Tufted Settee", tags: ["velvet", "white"], zoeGroup: "sofa-rentals" })], [], POLICY);
    expect(plan.toCreate).toHaveLength(1);
    const p = plan.toCreate[0];
    expect(p.tags).toEqual(["velvet", "white", "Subrental", "Staging Design"]);
    expect(p.zoeGroup).toBe("sofa-rentals");
    expect(p.unpriced).toBe(true);
    expect(p.trackQuantity).toBe(false);
  });

  it("honors trackQuantity:true when the policy sets it", () => {
    const plan = buildImportPlan([src()], [], { ...POLICY, trackQuantity: true });
    expect(plan.toCreate[0].trackQuantity).toBe(true);
  });

  it("maps distinct source groups onto their Zoe groups", () => {
    const items = [src({ title: "Sofa A", zoeGroup: "sofa-rentals" }), src({ title: "Stool B", zoeGroup: "stools-rentals" })];
    const plan = buildImportPlan(items, [], POLICY);
    expect(plan.toCreate.map((p) => p.zoeGroup)).toEqual(["sofa-rentals", "stools-rentals"]);
  });

  it("flattens image urls (primary first, as pre-sorted) and warns when an item has no images", () => {
    const withImgs = src({ title: "Sofa A", images: [img("https://img/p.jpg", true, 2), img("https://img/q.jpg", false, 1)] });
    const noImgs = src({ title: "Sofa B", images: [] });
    const plan = buildImportPlan([withImgs, noImgs], [], POLICY);
    expect(plan.toCreate[0].imageUrls).toEqual(["https://img/p.jpg", "https://img/q.jpg"]);
    expect(plan.toCreate[1].imageUrls).toEqual([]);
    expect(plan.warnings).toContain("Sofa B: no images to copy");
  });
});

describe("buildImportPlan — edge cases", () => {
  it("empty source → empty plan, nothing skipped", () => {
    const plan = buildImportPlan([], [{ title: "Anything" }], POLICY);
    expect(plan).toEqual({ toCreate: [], skipped: [], warnings: [] });
  });

  it("all duplicates → nothing to create, all skipped", () => {
    const items = [src({ title: "Sofa A" }), src({ title: "Sofa B" })];
    const plan = buildImportPlan(items, [{ title: "sofa a" }, { title: "SOFA B" }], POLICY);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped.every((s) => s.reason === "already in Zoe catalog")).toBe(true);
  });
});
