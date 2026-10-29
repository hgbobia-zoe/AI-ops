// People Lifecycle — the pure stage vocabulary. A "stage" is the single derived label the UI groups,
// filters and counts by, computed from the whole-person lifecycle state PLUS the person's onboarding
// readiness (blocked when a provision task failed, ready when every required one is done). Kept free of
// DB/IO so it can be unit-tested and shared by the overview assembler and the list filters without a
// runtime cycle (overview + list import FROM here; this imports nothing from them).

import type { Tone } from "@/lib/tone";
import type { LifecycleState } from "./types";

/** The derived lifecycle stage — the onboarding set (HIRE → ACTIVE) plus the two offboarding states. */
export type Stage =
  | "starting_soon" // HIRE — upcoming, onboarding not begun
  | "onboarding" //    ONBOARD, progressing, not yet ready
  | "blocked" //       ONBOARD with a failed provision task
  | "ready" //         onboarding complete (ready to activate) OR already READY
  | "active" //        ACTIVE
  | "offboarding" //   OFFBOARD (HR process running)
  | "offboarded"; //   OFFBOARDED (HR done — access removal tracked separately)

export interface StageMeta {
  label: string;
  tone: Tone;
  /** Which section owns the stage (drives the Onboarding vs Offboarding views). */
  group: "onboarding" | "offboarding";
  /** One honest sentence used in empty/setup copy and filter tooltips. */
  hint: string;
}

/** The ordered stage metadata — label, tone (colour lives on the indicator only), and section. */
export const STAGE_META: Record<Stage, StageMeta> = {
  starting_soon: { label: "Starting soon", tone: "neutral", group: "onboarding", hint: "Hired, onboarding not started yet." },
  onboarding: { label: "Onboarding", tone: "attention", group: "onboarding", hint: "Access provisioning in progress." },
  blocked: { label: "Blocked", tone: "critical", group: "onboarding", hint: "A required provisioning step failed." },
  ready: { label: "Ready", tone: "positive", group: "onboarding", hint: "All required access provisioned — ready to activate." },
  active: { label: "Active", tone: "positive", group: "onboarding", hint: "Fully onboarded and active." },
  offboarding: { label: "Offboarding", tone: "attention", group: "offboarding", hint: "Offboarding in progress; revokes may be open." },
  offboarded: { label: "Offboarded", tone: "neutral", group: "offboarding", hint: "HR process done — this does NOT mean every access was removed." },
};

/** The stages shown on the Onboarding view, in order. */
export const ONBOARDING_STAGES: Stage[] = ["starting_soon", "onboarding", "blocked", "ready", "active"];
/** The stages shown on the Offboarding view, in order. */
export const OFFBOARDING_STAGES: Stage[] = ["offboarding", "offboarded"];

/**
 * Classify a person into exactly one stage. PURE — identical rules to the overview grouping, so a
 * person lands in the same bucket everywhere. `hasFailed`/`ready` come from the person's provision
 * tasks (a failed required task → blocked; every required task complete → ready).
 */
export function classifyStage(input: { lifecycleState: LifecycleState; hasFailed: boolean; ready: boolean }): Stage {
  switch (input.lifecycleState) {
    case "HIRE":
      return "starting_soon";
    case "ONBOARD":
      return input.hasFailed ? "blocked" : input.ready ? "ready" : "onboarding";
    case "READY":
      return "ready";
    case "ACTIVE":
      return "active";
    case "OFFBOARD":
      return "offboarding";
    case "OFFBOARDED":
      return "offboarded";
  }
}
