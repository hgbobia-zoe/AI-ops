// Route-handoff configuration — team-editable policy for the multi-route-per-truck automation. Persisted in
// the settings KV with safe defaults, so behavior is unchanged until someone edits it. Nothing here is
// hard-coded into the handoff logic (the planner reads the buffer from this).

import { getJson, setJson } from "@/lib/kv";
import { clampBufferMinutes } from "./handoff";

export interface HandoffConfig {
  /** Master switch for the reconciliation scheduler (auto-finalize / flag). The VISIBILITY fix in
   *  getActiveRouteForTruck is always on — a forgotten close must never block the next driver — but the
   *  automated finalize/flag writes only run when this is enabled. Default ON: it is non-destructive
   *  (finalize requires verified completion; flag never changes a route's status). */
  enabled: boolean;
  /** Minutes before a later route's scheduled start at which the handoff window opens. Default 20,
   *  supported range 15-30 (clamped). */
  bufferMinutes: number;
  /** Alert dispatch (Slack) when a stale earlier route is a genuine conflict (truck physically still out).
   *  Default ON. */
  notifyOnConflict: boolean;
}

const KEY = "dispatch.handoff.config";
export const DEFAULT_HANDOFF_CONFIG: HandoffConfig = {
  enabled: true,
  bufferMinutes: 20,
  notifyOnConflict: true,
};

export function getHandoffConfig(): HandoffConfig {
  const stored = getJson<Partial<HandoffConfig>>(KEY, {});
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_HANDOFF_CONFIG.enabled,
    bufferMinutes: clampBufferMinutes(stored.bufferMinutes, DEFAULT_HANDOFF_CONFIG.bufferMinutes),
    notifyOnConflict:
      typeof stored.notifyOnConflict === "boolean" ? stored.notifyOnConflict : DEFAULT_HANDOFF_CONFIG.notifyOnConflict,
  };
}

export function saveHandoffConfig(patch: Partial<HandoffConfig>): HandoffConfig {
  const cur = getHandoffConfig();
  const next: HandoffConfig = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    bufferMinutes: clampBufferMinutes(patch.bufferMinutes, cur.bufferMinutes),
    notifyOnConflict: typeof patch.notifyOnConflict === "boolean" ? patch.notifyOnConflict : cur.notifyOnConflict,
  };
  setJson(KEY, next);
  return next;
}
