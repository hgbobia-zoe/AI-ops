// AI Control Plane — the server-side aggregator for the Command Center. Composes the session store, the
// provider status, the bridge status, per-blade config and the existing approvals queue into one read.
// Deterministic and defensive (a dead source degrades one field, never the page). Server-only.

import {
  listRecentSessions,
  listLiveSessions,
  countLiveSessionsByBlade,
  countLiveSessionsByAgent,
  type AiSession,
} from "@/lib/ai/sessions";
import { activeAiProviderId, bridgeConnected, aiConfigured, aiProviderById } from "@/lib/ai/provider";
import { allBladeAiConfig, type BladeAiConfig } from "@/lib/ai/bladeConfig";
import { listPendingApprovals } from "@/lib/aiorg/approvals";
import { getEmployee } from "@/lib/aiorg/registry";
import type { BladeKey } from "@/lib/aiorg/types";

export interface AiControlProviderStatus {
  activeId: string;
  activeName: string;
  mode: "inline" | "deferred";
  bridgeConnected: boolean;
  inlineReady: boolean;
}

export interface AiControlOverview {
  provider: AiControlProviderStatus;
  liveCount: number;
  recent: AiSession[];
  liveByBlade: Record<string, number>;
  liveByAgent: Record<string, number>;
  bladeConfig: Record<BladeKey, BladeAiConfig>;
  pendingApprovals: number;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function aiControlOverview(): AiControlOverview {
  const activeId = safe(() => activeAiProviderId(), "session-bridge");
  const def = aiProviderById(activeId);
  return {
    provider: {
      activeId,
      activeName: def.name,
      mode: def.mode,
      bridgeConnected: safe(() => bridgeConnected(), false),
      inlineReady: safe(() => aiConfigured(), false),
    },
    liveCount: safe(() => listLiveSessions(500).length, 0),
    recent: safe(() => listRecentSessions(60), []),
    liveByBlade: safe(() => countLiveSessionsByBlade(), {}),
    liveByAgent: safe(() => countLiveSessionsByAgent(), {}),
    bladeConfig: safe(() => allBladeAiConfig(), {} as Record<BladeKey, BladeAiConfig>),
    pendingApprovals: safe(() => listPendingApprovals(500).length, 0),
  };
}

/** A friendly agent name for a session row (falls back to the raw id when the registry lacks it). */
export function agentDisplayName(agentId: string): string {
  return safe(() => getEmployee(agentId)?.name ?? agentId, agentId);
}
