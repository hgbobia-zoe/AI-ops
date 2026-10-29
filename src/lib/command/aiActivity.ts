// Command Center — honest AI-session freshness. The old dashboard showed "{liveCount} live" straight
// from the status column, so a session stuck in `running`/`paused` for 14 days still counted as "live".
// "Live" must mean a trustworthy CURRENT activity: a session only counts as ACTIVE when its status is a
// working one AND it was actually touched recently (a heartbeat window). A working-status session with no
// recent activity is reported honestly as IDLE/stale — never silently marked completed, never counted as
// live. Pure functions over data another layer already fetched. RULES CALCULATE.

import type { SessionStatus } from "@/lib/ai/sessions";
import type { Tone } from "@/lib/tone";

/** A live session only counts as "active now" if it was touched within this many minutes (heartbeat). */
export const AI_ACTIVE_WINDOW_MIN = 30;

export type AiActivityState =
  | "active" //     a working session with a fresh heartbeat (genuinely running now)
  | "waiting" //    paused on a human: awaiting approval
  | "idle" //       status claims working, but no recent activity (stale — the honesty case)
  | "paused" //     explicitly paused
  | "completed" //  finished OK
  | "error" //      failed
  | "cancelled"; // cancelled

export interface AiActivityClass {
  state: AiActivityState;
  label: string; // user-facing status label
  tone: Tone; // indicator colour (colour lives on the indicator, never the label)
  /** True when the status claims a live/working state but there is no recent heartbeat. */
  stale: boolean;
}

/** Classify one session's REAL activity from its status + last-touched time. `now`/`windowMin` injectable
 *  for tests. A null/absent timestamp is treated as infinitely old (never fresh). */
export function classifyAiActivity(
  status: SessionStatus,
  updatedAtIso: string | null | undefined,
  now: number = Date.now(),
  windowMin: number = AI_ACTIVE_WINDOW_MIN,
): AiActivityClass {
  const parsed = updatedAtIso ? Date.parse(updatedAtIso) : NaN;
  const ageMin = Number.isFinite(parsed) ? (now - parsed) / 60000 : Infinity;
  const fresh = ageMin <= windowMin;

  switch (status) {
    case "running":
      return fresh
        ? { state: "active", label: "Working", tone: "info", stale: false }
        : { state: "idle", label: "Idle", tone: "neutral", stale: true };
    case "awaiting_approval":
      // A genuine human-in-the-loop wait, so it's not "idle" — but flag it stale if it has sat for a while,
      // so an ancient unactioned approval doesn't masquerade as current activity.
      return { state: "waiting", label: "Needs approval", tone: "attention", stale: !fresh };
    case "paused":
      return { state: "paused", label: "Paused", tone: "neutral", stale: false };
    case "done":
      return { state: "completed", label: "Completed", tone: "positive", stale: false };
    case "failed":
      return { state: "error", label: "Error", tone: "critical", stale: false };
    case "cancelled":
      return { state: "cancelled", label: "Cancelled", tone: "neutral", stale: false };
  }
}

export interface AiActivityCounts {
  active: number; // working + fresh heartbeat (the honest "live now")
  waiting: number; // awaiting approval
  idle: number; // working status but stale (no recent heartbeat)
  ended: number; // paused / completed / error / cancelled
  total: number;
}

/** Roll up a set of sessions into honest activity counts. */
export function summarizeAiActivity(
  sessions: { status: SessionStatus; updatedAt: string | null }[],
  now: number = Date.now(),
  windowMin: number = AI_ACTIVE_WINDOW_MIN,
): AiActivityCounts {
  let active = 0;
  let waiting = 0;
  let idle = 0;
  let ended = 0;
  for (const s of sessions) {
    const c = classifyAiActivity(s.status, s.updatedAt, now, windowMin);
    if (c.state === "active") active++;
    else if (c.state === "waiting") waiting++;
    else if (c.state === "idle") idle++;
    else ended++;
  }
  return { active, waiting, idle, ended, total: sessions.length };
}
