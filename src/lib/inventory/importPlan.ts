// Import planner — the PURE core of the Inventory Automation blade.
//
// Given a partner's normalized source items (each already tagged with the Zoe group it maps to), Zoe's
// current catalog for those groups, and a job policy, it decides exactly what WOULD be created — with no
// I/O, no side effects, and no surprises. This is what the Preview shows and what the generated importer
// replays, so it must be deterministic and honest:
//   • Dedupe by NORMALIZED title (trim + lowercase + collapse internal whitespace) against Zoe's catalog
//     AND within the source batch itself (two partner items with the same title → one is skipped).
//   • Merge source tags with the job's addTags, de-duped case-insensitively, order preserved.
//   • Carry the policy through verbatim: unpriced (no price copied) and untracked (quantity not tracked).
//   • Never invent data: missing title → skipped with a reason; no images → a warning, not a failure.
//
// RULES CALCULATE. No pricing is computed, no quantity is tracked — this tool copies catalog METADATA
// (title, description, tags, images) only.

import type { NormalizedItem } from "./storefront";

/** A source item tagged with the Zoe group it maps to (the API attaches this before planning). */
export type PlanSourceItem = NormalizedItem & { zoeGroup: string };

/** The job policy. v1 is fixed to metadata-only copies: unpriced + untracked. */
export interface ImportPolicy {
  unpriced: boolean; //      never copy a price (always true in v1; kept explicit for honesty + future use)
  trackQuantity: boolean; // whether created items track quantity (false in v1)
  addTags: string[]; //      extra tags applied to every created item (e.g. ["Subrental","Staging Design"])
}

/** A single item the importer will create in Zoe's Goodshuffle catalog. */
export interface PlannedItem {
  sourceId: string; //        provenance: the partner item this was copied from
  title: string; //           final title (verbatim from source)
  descriptionHtml: string; // final description HTML
  tags: string[]; //          final merged, de-duped tag list
  zoeGroup: string; //        destination Zoe group slug
  imageUrls: string[]; //     full-resolution source image URLs to copy, primary first
  unpriced: boolean; //       policy flag carried through
  trackQuantity: boolean; //  policy flag carried through
}

export interface SkippedItem {
  title: string;
  reason: string;
}

export interface ImportPlan {
  toCreate: PlannedItem[];
  skipped: SkippedItem[];
  warnings: string[];
}

/** Normalize a title for dedupe: trim, lowercase, collapse all internal whitespace runs to one space. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Merge tag lists, preserving first-seen order, de-duping case-insensitively (keeps the first casing). */
export function mergeTags(sourceTags: string[], addTags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...sourceTags, ...addTags]) {
    const clean = t.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/**
 * Build the import plan. PURE: same inputs → same output, no I/O.
 *
 * @param sourceItems  partner items to consider, each tagged with its target zoeGroup, in display order
 * @param zoeExisting  Zoe's current catalog for the target groups (only titles are needed for dedupe)
 * @param policy       the job policy (unpriced / trackQuantity / addTags)
 */
export function buildImportPlan(
  sourceItems: PlanSourceItem[],
  zoeExisting: { title: string }[],
  policy: ImportPolicy,
): ImportPlan {
  const existing = new Set(zoeExisting.map((x) => normalizeTitle(x.title)).filter(Boolean));
  const seenInBatch = new Set<string>();
  const toCreate: PlannedItem[] = [];
  const skipped: SkippedItem[] = [];
  const warnings: string[] = [];

  for (const item of sourceItems) {
    const title = item.title.trim();
    if (!title) {
      skipped.push({ title: "(untitled)", reason: "missing title" });
      continue;
    }
    const norm = normalizeTitle(title);
    if (existing.has(norm)) {
      skipped.push({ title, reason: "already in Zoe catalog" });
      continue;
    }
    if (seenInBatch.has(norm)) {
      skipped.push({ title, reason: "duplicate within source batch" });
      continue;
    }
    seenInBatch.add(norm);

    const imageUrls = item.images.map((img) => img.raw).filter(Boolean);
    if (imageUrls.length === 0) warnings.push(`${title}: no images to copy`);

    toCreate.push({
      sourceId: item.sourceId,
      title,
      descriptionHtml: item.descriptionHtml,
      tags: mergeTags(item.tags, policy.addTags),
      zoeGroup: item.zoeGroup,
      imageUrls,
      unpriced: policy.unpriced,
      trackQuantity: policy.trackQuantity,
    });
  }

  return { toCreate, skipped, warnings };
}
