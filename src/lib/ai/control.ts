// AI Control Plane — the server-side aggregator for the Command Center. Composes the session store, the
// provider status, the bridge status, per-blade config and the existing approvals queue into one read.
// Deterministic and defensive (a dead source degrades one field, never the page). Server-only.

import {
  listRecentSessions,
  listLiveSessions,
  listRecentSessionCards,
  countLiveSessionsByBlade,
  countLiveSessionsByAgent,
  countCompletedToday,
  sessionIdForApproval,
  type AiSession,
  type AiSessionCard,
} from "@/lib/ai/sessions";
import { activeAiProviderId, bridgeConnected, aiConfigured, aiProviderById } from "@/lib/ai/provider";
import { allBladeAiConfig, type BladeAiConfig } from "@/lib/ai/bladeConfig";
import { listPendingApprovals } from "@/lib/aiorg/approvals";
import { getEmployee } from "@/lib/aiorg/registry";
import { todayInOpsTz } from "@/lib/dates";
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

// ── AI Command Center overview (the operate surface) ──────────────────────────
export interface PendingApprovalLite {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  owner: string;
  actionType: string;
  financial: boolean;
  sessionId: string | null;
}

export interface AiCommandOverview {
  provider: AiControlProviderStatus;
  cards: AiSessionCard[];
  counts: { active: number; waiting: number; needsApproval: number; errors: number; completedToday: number };
  pendingApprovals: PendingApprovalLite[];
  recentlyCompleted: AiSessionCard[];
}

/** One read behind the AI Command Center: every (non-archived) session with its current activity, the
 *  five-state summary, the live pending-approval queue, and what finished recently. */
export function aiCommandOverview(showMoney = true): AiCommandOverview {
  const activeId = safe(() => activeAiProviderId(), "session-bridge");
  const def = aiProviderById(activeId);
  const cards = safe(() => listRecentSessionCards(200), [] as AiSessionCard[]);
  const today = safe(() => todayInOpsTz(), new Date().toISOString().slice(0, 10));

  const approvals = safe(() => listPendingApprovals(50), [])
    .filter((a) => showMoney || !a.financial)
    .map((a) => ({
      id: a.id,
      title: a.title,
      agentId: a.agentId,
      agentName: agentDisplayName(a.agentId),
      owner: a.owner,
      actionType: a.actionType,
      financial: a.financial,
      sessionId: safe(() => sessionIdForApproval(a.id), null),
    }));

  return {
    provider: {
      activeId,
      activeName: def.name,
      mode: def.mode,
      bridgeConnected: safe(() => bridgeConnected(), false),
      inlineReady: safe(() => aiConfigured(), false),
    },
    cards,
    counts: {
      active: cards.filter((c) => c.status === "running").length,
      waiting: cards.filter((c) => c.status === "paused").length,
      needsApproval: cards.filter((c) => c.status === "awaiting_approval").length,
      errors: cards.filter((c) => c.status === "failed").length,
      completedToday: safe(() => countCompletedToday(today), 0),
    },
    pendingApprovals: approvals,
    recentlyCompleted: cards.filter((c) => c.status === "done").slice(0, 6),
  };
}
