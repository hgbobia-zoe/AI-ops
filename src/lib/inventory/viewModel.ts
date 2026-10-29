// Pure view-model for the Inventory Import blade. The blade is a four-step workspace (partner →
// configure → preview → execute); this module turns the server plan + the UI's own flags into the
// deterministic shapes the component renders. Keeping it pure (no React, no I/O) lets the counts,
// effects, step states and execution gating be unit-tested in the node test environment.
//
// HONEST: every number here is DERIVED from the real plan the server returned — nothing is invented.
// A missing plan is "no plan", an empty plan is "nothing to create", and an unresolved category is a
// hard block. These are kept distinct so the UI never shows a failure as a success or a "0".

import type { PlanResponse } from "./service";

// Skip reasons emitted by buildImportPlan() — centralised so the UI and tests agree on the vocabulary.
export const SKIP_DUPLICATE_IN_ZOE = "already in Zoe catalog";
export const SKIP_DUPLICATE_IN_BATCH = "duplicate within source batch";
export const SKIP_NO_TITLE = "missing title";

/** A derived, honest summary of a previewed plan. All counts come straight from the plan. */
export interface PreviewSummary {
  toCreate: number;
  skippedTotal: number;
  skippedDuplicates: number; //   already in Zoe OR duplicate within the source batch
  skippedNoTitle: number; //      source item had no usable title
  groupsCount: number; //         mappings included in this plan
  itemsWithPhotos: number; //     of the items to create, how many carry at least one photo
  itemsMissingPhotos: number; //  of the items to create, how many have none (shown as an explicit effect)
  totalPhotos: number; //         total photos that would be uploaded across all created items
  alreadyInZoe: number; //        source items already present in Zoe (summed across groups)
  partialRead: boolean; //        a source/Zoe catalog read failed → counts are incomplete, not zero
  warningsCount: number; //       service + item warnings combined
}

/** Summarise a previewed plan into the counts + effects the preview step shows. Pure. */
export function summarizePlan(plan: PlanResponse): PreviewSummary {
  const toCreate = plan.plan.toCreate;
  const skipped = plan.plan.skipped;

  let skippedDuplicates = 0;
  let skippedNoTitle = 0;
  for (const s of skipped) {
    if (s.reason === SKIP_NO_TITLE) skippedNoTitle += 1;
    else if (s.reason === SKIP_DUPLICATE_IN_ZOE || s.reason === SKIP_DUPLICATE_IN_BATCH) skippedDuplicates += 1;
  }

  let itemsWithPhotos = 0;
  let totalPhotos = 0;
  for (const it of toCreate) {
    const n = it.imageUrls.length;
    totalPhotos += n;
    if (n > 0) itemsWithPhotos += 1;
  }

  const alreadyInZoe = plan.groups.reduce((sum, g) => sum + g.alreadyInZoeCount, 0);
  const partialRead = plan.groups.some((g) => !g.sourceOk || !g.zoeOk);
  const warningsCount = plan.warnings.length + plan.plan.warnings.length;

  return {
    toCreate: toCreate.length,
    skippedTotal: skipped.length,
    skippedDuplicates,
    skippedNoTitle,
    groupsCount: plan.groups.length,
    itemsWithPhotos,
    itemsMissingPhotos: toCreate.length - itemsWithPhotos,
    totalPhotos,
    alreadyInZoe,
    partialRead,
    warningsCount,
  };
}

/** The execution step's state. Distinguishes "no plan yet" from "nothing to do" from "blocked" from "ready". */
export type ExecStatus = "no-plan" | "nothing" | "blocked" | "ready";

export interface ExecutionState {
  status: ExecStatus;
  count: number; //            items the importer would create
  unresolved: string[]; //     target categories with no resolved Goodshuffle id (hard block)
  reason: string; //           plain-English explanation of the current state / what unlocks it
}

/**
 * Derive whether the external importer can be generated, and why/why-not. The write is only ever
 * offered when there is a previewed plan that will create at least one item and every target category
 * resolves to a real Goodshuffle id — the importer fails closed and never guesses a category.
 */
export function executionState(plan: PlanResponse | null): ExecutionState {
  if (!plan) {
    return { status: "no-plan", count: 0, unresolved: [], reason: "Run a preview first so there is a concrete plan to write." };
  }
  const count = plan.plan.toCreate.length;
  const unresolved = plan.unresolvedCategories ?? [];
  if (count === 0) {
    return {
      status: "nothing",
      count: 0,
      unresolved,
      reason: "This plan creates nothing — every source item already exists in Zoe, or no groups returned items.",
    };
  }
  if (unresolved.length > 0) {
    return {
      status: "blocked",
      count,
      unresolved,
      reason: `No Goodshuffle category id for ${unresolved.join(", ")}. Add it in /admin (Inventory categories) to unlock the write — the importer will not guess.`,
    };
  }
  return { status: "ready", count, unresolved, reason: `Ready to generate an importer for ${count} item${count === 1 ? "" : "s"}.` };
}

export type StepKey = "partner" | "configure" | "preview" | "execute";
export type StepState = "done" | "current" | "locked";

export interface StepInfo {
  key: StepKey;
  index: number; //   1-based ordinal (ordered, never skipped)
  label: string;
  state: StepState;
  detail?: string; // short status, or why the step is locked and what unlocks it
}

const STEP_LABEL: Record<StepKey, string> = {
  partner: "Partner",
  configure: "Configure",
  preview: "Preview",
  execute: "Write to Goodshuffle",
};

/**
 * Derive the ordered four-step tracker. Steps are always 1..4 (no skipped numbers); a step that can't
 * run yet is "locked" and carries the reason it's locked + what unlocks it.
 */
export function deriveSteps(opts: {
  hasPartner: boolean; //      a saved partner is selected (and the add-partner panel is closed)
  selectedGroups: number; //   how many groups are checked for import
  hasPlan: boolean; //         a preview has been resolved
  exec: ExecutionState;
}): StepInfo[] {
  const { hasPartner, selectedGroups, hasPlan, exec } = opts;

  const partner: StepInfo = {
    key: "partner",
    index: 1,
    label: STEP_LABEL.partner,
    state: hasPartner ? "done" : "current",
    detail: hasPartner ? undefined : "Pick a partner, or add one by its storefront link.",
  };

  const configure: StepInfo = {
    key: "configure",
    index: 2,
    label: STEP_LABEL.configure,
    state: !hasPartner ? "locked" : hasPlan ? "done" : "current",
    detail: !hasPartner ? "Select a partner first." : undefined,
  };

  const preview: StepInfo = {
    key: "preview",
    index: 3,
    label: STEP_LABEL.preview,
    state: !hasPartner ? "locked" : hasPlan ? "done" : "current",
    detail: !hasPartner
      ? "Select a partner first."
      : hasPlan
        ? undefined
        : selectedGroups === 0
          ? "Select at least one group, then run Preview."
          : "Run Preview to see what would be created.",
  };

  const execState: StepState = exec.status === "ready" ? "current" : "locked";
  const execute: StepInfo = {
    key: "execute",
    index: 4,
    label: STEP_LABEL.execute,
    state: execState,
    detail: exec.status === "ready" ? undefined : exec.reason,
  };

  return [partner, configure, preview, execute];
}
