// Self-Improvement Controller — display metadata (pure, client-safe). Maps a RunState to a human label, a
// tone, and a coarse group so the UI can render the lifecycle consistently. No logic, no IO.

import type { RunState } from "./types";

export type RunTone = "working" | "attention" | "positive" | "critical" | "muted";
export type RunGroup = "active" | "needs_human" | "success" | "failed";

export const STATE_META: Record<RunState, { label: string; tone: RunTone; group: RunGroup }> = {
  requested: { label: "Requested", tone: "muted", group: "active" },
  investigating: { label: "Investigating", tone: "working", group: "active" },
  planned: { label: "Planned", tone: "working", group: "active" },
  coding: { label: "Coding", tone: "working", group: "active" },
  validating: { label: "Validating", tone: "working", group: "active" },
  pr_created: { label: "PR created", tone: "working", group: "active" },
  ci_running: { label: "CI running", tone: "working", group: "active" },
  ready_to_merge: { label: "Ready to merge", tone: "attention", group: "needs_human" },
  merged: { label: "Merged", tone: "working", group: "active" },
  deploying: { label: "Deploying", tone: "working", group: "active" },
  deployed: { label: "Deployed", tone: "working", group: "active" },
  verifying: { label: "Verifying", tone: "working", group: "active" },
  verified: { label: "Verified", tone: "positive", group: "success" },
  validation_failed: { label: "Validation failed", tone: "critical", group: "failed" },
  ci_failed: { label: "CI failed", tone: "critical", group: "failed" },
  scope_exceeded: { label: "Scope exceeded", tone: "attention", group: "needs_human" },
  session_failed: { label: "Session failed", tone: "critical", group: "failed" },
  deployment_failed: { label: "Deployment failed", tone: "critical", group: "failed" },
  health_check_failed: { label: "Health check failed", tone: "critical", group: "failed" },
  rollback_required: { label: "Rollback required", tone: "critical", group: "failed" },
  rolled_back: { label: "Rolled back", tone: "muted", group: "failed" },
  human_review_required: { label: "Needs human review", tone: "attention", group: "needs_human" },
};

export const TONE_CLASS: Record<RunTone, string> = {
  working: "text-[var(--gold)] bg-[var(--gold)]/10",
  attention: "text-attention bg-attention/10",
  positive: "text-positive bg-positive/10",
  critical: "text-critical bg-critical/10",
  muted: "text-tertiary-text bg-[var(--row-hover)]",
};
