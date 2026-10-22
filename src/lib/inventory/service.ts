// Server-side orchestration for the Inventory Automation plan. Resolves a job config (a partner preset,
// or a raw token + mappings), pulls the partner's source items AND Zoe's current catalog for the target
// groups from the storefront data API, and hands both to the PURE planner. Keeps the route handler thin.
//
// HONEST: a failed source/Zoe fetch is surfaced as a per-group flag + a warning, never swallowed into a
// silent "0 items". The planner only ever dedupes against a Zoe catalog we actually retrieved — if Zoe's
// side couldn't be read for a group, that is called out so a human doesn't trust the dedupe blindly.

import { fetchStorefrontInventory, type NormalizedItem } from "./storefront";
import { buildImportPlan, type ImportPlan, type ImportPolicy, type PlanSourceItem } from "./importPlan";
import { getPartnerPreset, ZOE_VENDOR_TOKEN, type GroupMapping } from "./partners";

/** The job config a caller (the blade) submits. Either `partnerKey`, or a raw `token` + `mappings`. */
export interface PlanJobRequest {
  partnerKey?: string;
  token?: string;
  mappings?: GroupMapping[];
  groups?: string[]; //      which mapping keys to include; empty/omitted = all
  addTags?: string[];
  policy?: { unpriced?: boolean; trackQuantity?: boolean };
}

export interface PlanGroupSummary {
  key: string;
  label: string;
  zoeGroup: string;
  sourceCount: number; //       items pulled from the partner for this group
  sourceOk: boolean; //         false → the partner fetch failed (sourceCount is then 0 but unreliable)
  zoeExistingCount: number; //  Zoe items found in the target group (the dedupe baseline)
  zoeOk: boolean; //            false → Zoe's catalog couldn't be read, so dedupe for this group is partial
}

export interface PlanResponse {
  ok: boolean;
  error?: string;
  partnerLabel: string;
  policy: ImportPolicy;
  groups: PlanGroupSummary[];
  plan: ImportPlan;
  warnings: string[]; //        service-level warnings (fetch failures, partial dedupe); item-level ones live on plan.warnings
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

function isValidMapping(m: unknown): m is GroupMapping {
  const o = m as GroupMapping;
  return (
    !!o &&
    typeof o.key === "string" &&
    typeof o.sourceCategory === "string" &&
    Array.isArray(o.sourceGroups) &&
    typeof o.zoeGroup === "string"
  );
}

/** Resolve a job request into a concrete { token, mappings, label }, or an error. */
function resolveJob(req: PlanJobRequest): { token: string; mappings: GroupMapping[]; label: string } | { error: string } {
  if (req.partnerKey) {
    const preset = getPartnerPreset(req.partnerKey);
    if (!preset) return { error: `unknown partner "${req.partnerKey}"` };
    return { token: preset.token, mappings: preset.mappings, label: preset.label };
  }
  const token = (req.token ?? "").trim();
  const mappings = Array.isArray(req.mappings) ? req.mappings.filter(isValidMapping) : [];
  if (!token) return { error: "no partner selected (provide partnerKey, or token + mappings)" };
  if (mappings.length === 0) return { error: "no valid group mappings provided" };
  return { token, mappings, label: "Custom partner" };
}

/**
 * Build the import plan for a job: pull the partner's source items + Zoe's current catalog for the target
 * groups, then run the pure planner. Never throws — fetch failures become warnings + per-group flags.
 */
export async function planInventoryImport(req: PlanJobRequest): Promise<PlanResponse> {
  const resolved = resolveJob(req);
  if ("error" in resolved) {
    return {
      ok: false,
      error: resolved.error,
      partnerLabel: "",
      policy: { unpriced: true, trackQuantity: false, addTags: [] },
      groups: [],
      plan: { toCreate: [], skipped: [], warnings: [] },
      warnings: [],
    };
  }

  // Which mappings to run: the selected keys, or all when none specified.
  const wanted = new Set((req.groups ?? []).filter(Boolean));
  const mappings = wanted.size ? resolved.mappings.filter((m) => wanted.has(m.key)) : resolved.mappings;

  const policy: ImportPolicy = {
    unpriced: true, //            v1 copies metadata only; never a price
    trackQuantity: req.policy?.trackQuantity === true,
    addTags: cleanTags(req.addTags),
  };

  const warnings: string[] = [];
  const groups: PlanGroupSummary[] = [];
  const sourceItems: PlanSourceItem[] = [];
  const zoeByGroup = new Map<string, { title: string }[]>(); // keyed by zoeGroup, so two mappings to the same group share one pull

  for (const m of mappings) {
    // Partner source items for this mapping.
    const src = await fetchStorefrontInventory({ token: resolved.token, category: m.sourceCategory, groups: m.sourceGroups });
    if (!src.ok) warnings.push(`Could not read ${resolved.label} "${m.label}" catalog (${src.error}). Those items are not in the plan.`);
    for (const it of src.items) sourceItems.push({ ...(it as NormalizedItem), zoeGroup: m.zoeGroup });

    // Zoe's current catalog for the destination group (pulled once per distinct zoeGroup).
    let zoeOk = true;
    if (!zoeByGroup.has(m.zoeGroup)) {
      const zoe = await fetchStorefrontInventory({ token: ZOE_VENDOR_TOKEN, category: m.sourceCategory, groups: [m.zoeGroup] });
      zoeOk = zoe.ok;
      if (!zoe.ok) warnings.push(`Could not read Zoe's "${m.zoeGroup}" catalog (${zoe.error}); duplicate detection for this group is incomplete.`);
      zoeByGroup.set(m.zoeGroup, zoe.items.map((x) => ({ title: x.title })));
    }

    groups.push({
      key: m.key,
      label: m.label,
      zoeGroup: m.zoeGroup,
      sourceCount: src.items.length,
      sourceOk: src.ok,
      zoeExistingCount: zoeByGroup.get(m.zoeGroup)?.length ?? 0,
      zoeOk,
    });
  }

  const zoeExisting = Array.from(zoeByGroup.values()).flat();
  const plan = buildImportPlan(sourceItems, zoeExisting, policy);

  return { ok: true, partnerLabel: resolved.label, policy, groups, plan, warnings };
}
