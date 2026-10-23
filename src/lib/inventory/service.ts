// Server-side orchestration for the Inventory Automation plan. Resolves a job (a saved partner by id, or an
// ad-hoc token + mappings for the "add partner" preview), pulls the partner's catalog AND Zoe's current
// catalog from the PUBLIC storefront data API, resolves each mapping's Goodshuffle category id from the
// team-editable Zoe-category registry (settings), and hands the source items to the PURE planner. Keeps the
// route handlers thin. Also exposes group DISCOVERY for the add-partner flow.
//
// HONEST: a failed source/Zoe fetch is surfaced as a per-group flag + a warning, never swallowed into a
// silent "0 items". The planner only ever dedupes against a Zoe catalog we actually retrieved. A mapping
// whose targetCategory has no id in the registry is reported in `unresolvedCategories` and the client fails
// closed — an item is never created under a guessed category.

import { fetchStorefrontInventory, type NormalizedItem } from "./storefront";
import { buildImportPlan, mergeTags, type ImportPlan, type ImportPolicy, type PlanSourceItem } from "./importPlan";
import type { BackfillItem, GroupCategory } from "./bookmarklets";
import {
  getInventoryPartner,
  zoeCategoryIndex,
  ZOE_VENDOR_TOKEN,
  type InventoryPartner,
  type PartnerMapping,
  type ZoeCategory,
} from "./partners";
import { getSettings } from "@/lib/settings";

const CATALOG_SIZE = 500; // pull the whole catalog once (the documented canonical call uses empty filters)

/** The job a caller (the blade) submits. Either a saved `partnerId`, or an ad-hoc `token` + `mappings`. */
export interface PlanJobRequest {
  partnerId?: string; //       a saved partner (settings.inventoryPartners)
  token?: string; //           ad-hoc partner token (add-partner preview, before save)
  mappings?: PartnerMapping[]; //ad-hoc mappings (add-partner preview)
  internalNote?: string; //    provenance note for an ad-hoc partner
  groups?: string[]; //        which mapping keys to include; empty/omitted = all
  addTags?: string[];
  policy?: { unpriced?: boolean; trackQuantity?: boolean };
}

export interface PlanGroupSummary {
  key: string;
  label: string;
  targetCategory: string; //    the Zoe category this group maps to
  sourceCount: number; //       items pulled from the partner for this mapping
  sourceOk: boolean; //         false → the partner catalog fetch failed (counts are then unreliable)
  alreadyInZoeCount: number; // how many of this mapping's source items already exist in Zoe (by title)
  zoeOk: boolean; //            false → Zoe's catalog couldn't be read, so dedupe is partial
  categoryResolved: boolean; // false → targetCategory has no id in the registry (fails closed)
}

export interface PlanResponse {
  ok: boolean;
  error?: string;
  partnerLabel: string;
  policy: ImportPolicy;
  groups: PlanGroupSummary[];
  plan: ImportPlan;
  warnings: string[]; //              service-level warnings (fetch failures, partial dedupe)
  /** Resolved Goodshuffle categories keyed by targetCategory — fed straight into the importer. */
  categories: Record<string, GroupCategory>;
  /** targetCategory names used by the plan that have NO id in the registry (the client fails closed). */
  unresolvedCategories: string[];
  /** Provenance note stamped on every copied item. */
  internalNotes: string;
  /** Zoe's public storefront token, for the importer's run-time idempotency re-check. */
  zoeToken: string;
  /**
   * ALL source items for the selected groups (NOT deduped against Zoe) — the input for the photo-backfill
   * bookmarklet, which matches each against Zoe's live catalog at run time and only touches photoless ones.
   */
  backfillItems: BackfillItem[];
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of v) {
    const clean = String(t ?? "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function isValidMapping(m: unknown): m is PartnerMapping {
  const o = m as PartnerMapping;
  return !!o && typeof o.key === "string" && Array.isArray(o.sourceGroups) && o.sourceGroups.length > 0 && typeof o.targetCategory === "string";
}

interface ResolvedJob {
  token: string;
  mappings: PartnerMapping[];
  label: string;
  internalNote: string;
}

/** Resolve a job request into a concrete { token, mappings, label, internalNote }, or an error. */
function resolveJob(req: PlanJobRequest, partners: InventoryPartner[]): ResolvedJob | { error: string } {
  if (req.partnerId) {
    const partner = getInventoryPartner(partners, req.partnerId);
    if (!partner) return { error: `unknown partner "${req.partnerId}"` };
    return { token: partner.vendorToken, mappings: partner.mappings, label: partner.name, internalNote: partner.internalNote };
  }
  const token = (req.token ?? "").trim();
  const mappings = Array.isArray(req.mappings) ? req.mappings.filter(isValidMapping) : [];
  if (!token) return { error: "no partner selected (provide partnerId, or token + mappings)" };
  if (mappings.length === 0) return { error: "no valid group mappings provided" };
  return { token, mappings, label: "New partner", internalNote: (req.internalNote ?? "").trim() };
}

/** Does a storefront item belong to any of the given source-group slugs? Case-insensitive. */
function itemInGroups(item: NormalizedItem, slugs: Set<string>): boolean {
  return item.groups.some((g) => slugs.has(g.slug.toLowerCase()));
}

const emptyResponse = (error: string): PlanResponse => ({
  ok: false,
  error,
  partnerLabel: "",
  policy: { unpriced: true, trackQuantity: false, addTags: [] },
  groups: [],
  plan: { toCreate: [], skipped: [], warnings: [] },
  warnings: [],
  categories: {},
  unresolvedCategories: [],
  internalNotes: "",
  zoeToken: ZOE_VENDOR_TOKEN,
  backfillItems: [],
});

/**
 * Build the import plan for a job. Pulls the partner's catalog + Zoe's catalog once each, buckets the
 * partner's items by each selected mapping's source groups, resolves each mapping's Goodshuffle category id
 * from the registry, and runs the pure planner. Never throws — fetch failures become warnings + flags.
 */
export async function planInventoryImport(req: PlanJobRequest): Promise<PlanResponse> {
  const settings = getSettings();
  const resolved = resolveJob(req, settings.inventoryPartners);
  if ("error" in resolved) return emptyResponse(resolved.error);

  const catIndex = zoeCategoryIndex(settings.zoeCategories);

  // Which mappings to run: the selected keys, or all when none specified.
  const wanted = new Set((req.groups ?? []).filter(Boolean));
  const mappings = wanted.size ? resolved.mappings.filter((m) => wanted.has(m.key)) : resolved.mappings;

  const policy: ImportPolicy = {
    unpriced: true, //            v1 copies metadata only; never a price
    trackQuantity: req.policy?.trackQuantity === true,
    addTags: cleanTags(req.addTags),
  };

  const warnings: string[] = [];

  // One catalog pull for the partner, one for Zoe (whole catalog, empty filters — the canonical call).
  const src = await fetchStorefrontInventory({ token: resolved.token, category: "", groups: [], size: CATALOG_SIZE });
  if (!src.ok) warnings.push(`Could not read ${resolved.label}'s catalog (${src.error}). No items are in the plan.`);
  const zoe = await fetchStorefrontInventory({ token: ZOE_VENDOR_TOKEN, category: "", groups: [], size: CATALOG_SIZE });
  if (!zoe.ok) warnings.push(`Could not read Zoe's catalog (${zoe.error}); duplicate detection is incomplete.`);

  const zoeTitles = new Set(zoe.items.map((x) => x.title.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean));

  const groups: PlanGroupSummary[] = [];
  const categories: Record<string, GroupCategory> = {};
  const unresolvedSet = new Set<string>();
  const sourceItems: PlanSourceItem[] = [];
  const backfillItems: BackfillItem[] = [];

  for (const m of mappings) {
    const slugs = new Set(m.sourceGroups.map((g) => g.toLowerCase()));
    const items = src.items.filter((it) => itemInGroups(it, slugs));
    for (const it of items) {
      sourceItems.push({ ...it, zoeGroup: m.targetCategory });
      // Backfill operates over ALL source items (not deduped): the bookmarklet matches each to Zoe's live
      // catalog at run time and only attaches photos to ones that exist there and have none.
      backfillItems.push({
        title: it.title,
        descriptionHtml: it.descriptionHtml,
        tags: mergeTags(it.tags, policy.addTags),
        imageUrls: it.images.map((img) => img.raw).filter(Boolean),
        baseTag: m.baseTag,
      });
    }

    const alreadyInZoe = items.filter((it) => zoeTitles.has(it.title.trim().toLowerCase().replace(/\s+/g, " "))).length;

    // Resolve the Goodshuffle category id from the registry (fail closed when absent).
    const id = catIndex.get(m.targetCategory.trim().toLowerCase());
    const categoryResolved = typeof id === "number" && Number.isFinite(id);
    if (categoryResolved) {
      categories[m.targetCategory] = { primaryCategoryID: id as number, primaryCategoryName: m.targetCategory, baseTag: m.baseTag };
    } else {
      unresolvedSet.add(m.targetCategory);
    }

    groups.push({
      key: m.key,
      label: m.label,
      targetCategory: m.targetCategory,
      sourceCount: items.length,
      sourceOk: src.ok,
      alreadyInZoeCount: alreadyInZoe,
      zoeOk: zoe.ok,
      categoryResolved,
    });
  }

  const plan = buildImportPlan(sourceItems, Array.from(zoeTitles).map((title) => ({ title })), policy);

  const unresolvedCategories = Array.from(unresolvedSet);
  if (unresolvedCategories.length) {
    warnings.push(
      `No Goodshuffle category id configured for: ${unresolvedCategories.join(", ")}. Add it in /admin (Inventory categories) before importing — the importer will not guess.`,
    );
  }

  return {
    ok: true,
    partnerLabel: resolved.label,
    policy,
    groups,
    plan,
    warnings,
    categories,
    unresolvedCategories,
    internalNotes: resolved.internalNote || `Subrent from ${resolved.label}.`,
    zoeToken: ZOE_VENDOR_TOKEN,
    backfillItems,
  };
}

export interface DiscoveredGroup {
  slug: string;
  name: string;
  count: number;
}

export interface CatalogDiscovery {
  ok: boolean;
  error?: string;
  total: number;
  groups: DiscoveredGroup[];
}

/**
 * Pull a partner's whole catalog and aggregate its DISTINCT groups (slug + display name + item count), for
 * the add-partner flow's mapping UI. Never throws — a failed fetch returns { ok:false, error, groups:[] }.
 */
export async function discoverPartnerGroups(token: string): Promise<CatalogDiscovery> {
  const t = (token ?? "").trim();
  if (!t) return { ok: false, error: "no token", total: 0, groups: [] };
  const res = await fetchStorefrontInventory({ token: t, category: "", groups: [], size: CATALOG_SIZE });
  if (!res.ok) return { ok: false, error: res.error ?? "unreachable", total: 0, groups: [] };
  const bySlug = new Map<string, DiscoveredGroup>();
  for (const it of res.items) {
    for (const g of it.groups) {
      const key = g.slug.toLowerCase();
      const existing = bySlug.get(key);
      if (existing) existing.count += 1;
      else bySlug.set(key, { slug: g.slug, name: g.name || g.slug, count: 1 });
    }
  }
  const groups = Array.from(bySlug.values()).sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  return { ok: true, total: res.total || res.items.length, groups };
}

// Re-export the registry type for route handlers that return it alongside partners.
export type { ZoeCategory };
