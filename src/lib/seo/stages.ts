// SEO Growth — Kanban stage lifecycle: the transition map + guard. PURE (no DB, no I/O) so it can be unit
// tested and reused on both the server (write guard) and the client (which moves are offered on the board).
//
// The main flow is DISCOVERED → ANALYZING → APPROVED → DRAFTING → REVIEW → APPROVED_FOR_PUBLISHING →
// PUBLISHED → MONITORING. REJECTED / DEFERRED / CONSOLIDATED / BLOCKED are off-flow states most active
// stages can drop into, and DEFERRED / BLOCKED / REJECTED can be reopened back into the flow. Invalid
// transitions are rejected (never silently applied), so the audit trail only ever contains legal moves.

import type { SeoStage } from "./types";

/** Allowed next stages for each stage. A move not listed here is invalid (same→same is handled separately). */
export const STAGE_TRANSITIONS: Record<SeoStage, SeoStage[]> = {
  DISCOVERED: ["ANALYZING", "APPROVED", "REJECTED", "DEFERRED", "CONSOLIDATED", "BLOCKED"],
  ANALYZING: ["APPROVED", "DISCOVERED", "REJECTED", "DEFERRED", "CONSOLIDATED", "BLOCKED"],
  APPROVED: ["DRAFTING", "ANALYZING", "REJECTED", "DEFERRED", "CONSOLIDATED", "BLOCKED"],
  DRAFTING: ["REVIEW", "APPROVED", "DEFERRED", "BLOCKED"],
  REVIEW: ["APPROVED_FOR_PUBLISHING", "DRAFTING", "DEFERRED", "BLOCKED"],
  APPROVED_FOR_PUBLISHING: ["PUBLISHED", "REVIEW", "BLOCKED"],
  PUBLISHED: ["MONITORING", "DRAFTING"],
  MONITORING: ["DRAFTING", "PUBLISHED"],
  REJECTED: ["DISCOVERED", "ANALYZING"],
  DEFERRED: ["DISCOVERED", "ANALYZING", "APPROVED"],
  CONSOLIDATED: ["DISCOVERED"],
  BLOCKED: ["ANALYZING", "APPROVED", "DRAFTING", "REVIEW"],
};

/** Display metadata for each stage (board column labels + whether it is an active-flow or off-flow lane). */
export const STAGE_META: Record<SeoStage, { label: string; lane: "active" | "off" }> = {
  DISCOVERED: { label: "Discovered", lane: "active" },
  ANALYZING: { label: "Analyzing", lane: "active" },
  APPROVED: { label: "Approved", lane: "active" },
  DRAFTING: { label: "Drafting", lane: "active" },
  REVIEW: { label: "Review", lane: "active" },
  APPROVED_FOR_PUBLISHING: { label: "Ready to publish", lane: "active" },
  PUBLISHED: { label: "Published", lane: "active" },
  MONITORING: { label: "Monitoring", lane: "active" },
  REJECTED: { label: "Rejected", lane: "off" },
  DEFERRED: { label: "Deferred", lane: "off" },
  CONSOLIDATED: { label: "Consolidated", lane: "off" },
  BLOCKED: { label: "Blocked", lane: "off" },
};

/** The board column order (active flow first, then off-flow lanes). */
export const BOARD_STAGES: SeoStage[] = [
  "DISCOVERED",
  "ANALYZING",
  "APPROVED",
  "DRAFTING",
  "REVIEW",
  "APPROVED_FOR_PUBLISHING",
  "PUBLISHED",
  "MONITORING",
  "DEFERRED",
  "BLOCKED",
  "CONSOLIDATED",
  "REJECTED",
];

/**
 * Whether moving from `from` to `to` is a legal transition. A same-stage move is treated as a legal no-op
 * so an idempotent re-apply (or a drop onto the same column) never errors.
 */
export function canTransition(from: SeoStage, to: SeoStage): boolean {
  if (from === to) return true;
  return STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The legal next stages from `from` (excluding `from` itself). */
export function nextStages(from: SeoStage): SeoStage[] {
  return STAGE_TRANSITIONS[from] ?? [];
}

/** Type guard for an unknown string being a valid stage. */
export function isStage(x: unknown): x is SeoStage {
  return typeof x === "string" && x in STAGE_TRANSITIONS;
}
