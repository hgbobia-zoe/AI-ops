// Opportunity Radar — lifecycle engine (§6). PURE and deterministic. Computes the AUTO stage from
// facts; a human MANUAL override always wins (same pattern as Sales OS lead_status). Only advances up
// to OUTREACH_READY automatically — everything past that (CONTACTED/ENGAGED/…/WON/LOST) is a human act.

import { STAGE_ORDER, type LifecycleStage } from "./types";

export interface LifecycleFacts {
  hasCoreFields: boolean; // name + date-or-deadline + jurisdiction present → VALIDATED
  isRelevant: boolean; // relevance score over threshold → RELEVANT
  hasEntities: boolean; // any related company/contact discovered → RESEARCHING
  hasPrimaryTarget: boolean; // a recommended primary target exists → TARGET_IDENTIFIED
  hasOutreachDraft: boolean; // a draft has been generated → OUTREACH_READY
}

/** The furthest stage the FACTS justify (never past OUTREACH_READY — human-driven stages come after). */
export function autoStage(f: LifecycleFacts): LifecycleStage {
  if (f.hasOutreachDraft) return "OUTREACH_READY";
  if (f.hasPrimaryTarget) return "TARGET_IDENTIFIED";
  if (f.hasEntities) return "RESEARCHING";
  if (f.isRelevant) return "RELEVANT";
  if (f.hasCoreFields) return "VALIDATED";
  return "DISCOVERED";
}

const TERMINAL: LifecycleStage[] = ["WON", "LOST", "ARCHIVED"];
export function isTerminal(stage: LifecycleStage): boolean {
  return TERMINAL.includes(stage);
}

/** Effective stage: a manual override wins unless the auto stage is further along and the manual one is
 *  not terminal (so re-discovery can't drag a human-advanced opportunity backward, but genuine progress
 *  still shows). Terminal manual stages (WON/LOST/ARCHIVED) always stand. */
export function effectiveStage(auto: LifecycleStage, manual: LifecycleStage | null): LifecycleStage {
  if (!manual) return auto;
  if (isTerminal(manual)) return manual;
  const ai = STAGE_ORDER.indexOf(auto);
  const mi = STAGE_ORDER.indexOf(manual);
  return ai > mi ? auto : manual;
}

export function stageProgress(stage: LifecycleStage): number {
  if (stage === "WON") return 1;
  if (stage === "LOST" || stage === "ARCHIVED") return 0;
  const i = STAGE_ORDER.indexOf(stage);
  return i < 0 ? 0 : i / (STAGE_ORDER.length - 1);
}
