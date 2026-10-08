// Self-Improvement Controller — rollback (audit gate 10). A failed post-deploy health check must never be
// silently continued. The controller DECIDES (pure) whether to roll back automatically or escalate to a
// human, and TRIGGERS rollback by firing a GitHub repository_dispatch to the pre-defined rollback workflow
// (which holds the Fly deploy creds). The controller itself holds NO Fly creds and can only fire that one
// pre-defined event — it cannot run arbitrary infrastructure (audit gate 12).

import type { HealthResult } from "./types";

export type RollbackDecision =
  | { action: "none" } //          deploy is healthy — nothing to do
  | { action: "rollback" } //      unhealthy + auto-rollback enabled — trigger it
  | { action: "human_review"; reason: string }; // unhealthy + auto-rollback off — stop and escalate

/** Decide what to do after a health verdict. PURE. Auto-rollback only fires when explicitly enabled; every
 *  other unhealthy case stops for a human. A healthy deploy never rolls back. */
export function rollbackDecision(health: HealthResult, autonomy: { autoRollback: boolean }): RollbackDecision {
  if (health.healthy) return { action: "none" };
  if (autonomy.autoRollback) return { action: "rollback" };
  return { action: "human_review", reason: `deploy unhealthy (${health.failures.join("; ") || "health check failed"}); auto-rollback is off — a human must roll back` };
}

export interface RollbackTrigger {
  ok: boolean;
  skipped?: boolean; // no dispatch token configured — a human must roll back
  error?: string;
}

/** Fire the pre-defined rollback workflow via GitHub repository_dispatch. Requires GITHUB_DISPATCH_TOKEN —
 *  a fine-grained token scoped to repository_dispatch on this one repo, NOT a Fly or admin cred. Without it,
 *  this skips (honest) so the controller escalates to a human instead. Never throws. */
export async function triggerRollback(opts: { repo: string; previousDeployId?: string | null; reason: string }): Promise<RollbackTrigger> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return { ok: false, skipped: true, error: "GITHUB_DISPATCH_TOKEN not set" };
  try {
    const res = await fetch(`https://api.github.com/repos/${opts.repo}/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({ event_type: "improvement-rollback", client_payload: { previousDeployId: opts.previousDeployId ?? null, reason: opts.reason.slice(0, 500) } }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `github dispatch ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
