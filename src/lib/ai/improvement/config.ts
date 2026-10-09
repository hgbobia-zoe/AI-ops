// Self-Improvement Controller — configuration. The change budget is CONFIGURABLE (audit gate 4: "do not use
// arbitrary limits"), stored in the settings KV and resolved over the safe defaults. Server-only.

import { getJson, setJson } from "@/lib/kv";
import { resolveBudget, DEFAULT_BUDGET } from "./budget";
import type { ChangeBudget } from "./types";

const BUDGET_KEY = "improvement.budget";
const ENABLED_KEY = "improvement.autonomy"; // master switches for the autonomous steps (default OFF)

/** The active change budget: the configured override merged over the defaults (bad values ignored). */
export function improvementBudget(): ChangeBudget {
  return resolveBudget(getJson<Partial<ChangeBudget>>(BUDGET_KEY, {}));
}

export function setImprovementBudget(override: Partial<ChangeBudget>): void {
  setJson(BUDGET_KEY, override ?? {});
}

export const DEFAULT_IMPROVEMENT_BUDGET = DEFAULT_BUDGET;

/** Autonomy switches. ALL default OFF — the loop runs human-supervised until each is deliberately enabled.
 *  autoMerge/autoDeploy stay meaningless until CI + verify + rollback exist (they do now), and even then a
 *  human turns them on; the controller never flips them for itself. */
export interface AutonomyConfig {
  autoMerge: boolean; //    may the controller merge a PR when all gates are green?
  autoDeploy: boolean; //   may a merge trigger a deploy automatically?
  autoRollback: boolean; // may the controller trigger a rollback on a failed health check?
}

const AUTONOMY_DEFAULT: AutonomyConfig = { autoMerge: false, autoDeploy: false, autoRollback: false };

export function autonomyConfig(): AutonomyConfig {
  const v = getJson<Partial<AutonomyConfig>>(ENABLED_KEY, {});
  return {
    autoMerge: v.autoMerge === true,
    autoDeploy: v.autoDeploy === true,
    autoRollback: v.autoRollback === true,
  };
}

export function setAutonomyConfig(cfg: Partial<AutonomyConfig>): void {
  setJson(ENABLED_KEY, { ...autonomyConfig(), ...cfg });
}

export { AUTONOMY_DEFAULT };
