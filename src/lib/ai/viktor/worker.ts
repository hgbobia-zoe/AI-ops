// The in-app worker that answers session instructions. When a person messages Viktor in Slack or sends
// an instruction in the AI Command Center, this picks the instruction up, runs the Viktor agent, records
// the reply on the session timeline, and delivers it (Slack thread or the in-app activity stream).
//
// It replaces the office-machine responder entirely: no heartbeat, no CLI login, no bridge token. The
// claim step (a changeKey'd timeline event) makes it safe to call from several triggers at once (the Slack
// webhook, the in-app instruct call, and the runtime backstop drain): only the first claim works the item.
//
// Health is honest: every run records its outcome, and a failure is reported to the person and to ops
// rather than leaving a "working" state with nothing behind it.

import { flagOn } from "@/lib/flags";
import { getJson, setJson } from "@/lib/kv";
import { todayInOpsTz } from "@/lib/dates";
import { humanize } from "@/lib/salesos/outreach";
import { slackBotConfigured, slackPostMessage, slackNotify } from "@/lib/notify/slack";
import { slackApproverIds } from "@/lib/settings";
import {
  getSession,
  listSessionEvents,
  claimInstruction,
  appendEvent,
  setSessionResult,
  listPendingInstructions,
  listLiveSessions,
  NEUTRAL_EVENT_KINDS,
  isSessionTerminal,
  type AiSession,
} from "@/lib/ai/sessions";
import { assembleThreadContext, type TranscriptTurn } from "@/lib/ai/threadContext";
import { agentDisplayName } from "@/lib/ai/control";
import { runViktorAgent, viktorAgentConfigured, type ViktorClient, type ViktorRunResult } from "@/lib/ai/viktor/agent";

/** Kill switch: VIKTOR_AGENT=false turns the in-app agent off (instructions then wait unanswered). */
export function viktorAgentEnabled(): boolean {
  return flagOn("VIKTOR_AGENT");
}

export const ACK_AFTER_MS = 4000;
export const SLACK_ACK = "On it. Give me a moment to pull that together.";
export const FAILURE_REPLY =
  "Sorry, I could not finish that one because my AI backend had a problem. The team has been alerted. Please try again in a few minutes.";
export const DISABLED_REPLY =
  "I am switched off right now, so I cannot answer. Someone on the team can turn me back on in the app settings.";

// ── Health (what the AI Command Center and alerts read) ────────────────────────────────────────────────

const HEALTH_KEY = "ai.viktor.health";
const ALERT_KEY = "ai.viktor.lastAlertAt";
const ALERT_COOLOFF_MS = 30 * 60 * 1000;

export interface ViktorHealthRecord {
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  lastOkAt: string | null;
  consecutiveFailures: number;
  model: string | null;
}

export type ViktorHealthState = "ready" | "degraded" | "not_configured" | "disabled";

export interface ViktorHealth extends ViktorHealthRecord {
  state: ViktorHealthState;
  /** One plain sentence for the UI. */
  summary: string;
}

const EMPTY_HEALTH: ViktorHealthRecord = { lastRunAt: null, lastOk: null, lastError: null, lastOkAt: null, consecutiveFailures: 0, model: null };

/** Derive the health state from config + the last runs. PURE. */
export function deriveViktorHealth(rec: ViktorHealthRecord, opts: { enabled: boolean; configured: boolean }): ViktorHealth {
  if (!opts.enabled) return { ...rec, state: "disabled", summary: "Viktor is switched off (VIKTOR_AGENT=false). Instructions are recorded but not answered." };
  if (!opts.configured) return { ...rec, state: "not_configured", summary: "Viktor cannot answer: ANTHROPIC_API_KEY is not set on the server." };
  if (rec.consecutiveFailures > 0 && rec.lastOk === false) {
    return { ...rec, state: "degraded", summary: `Viktor's last ${rec.consecutiveFailures === 1 ? "answer" : `${rec.consecutiveFailures} answers`} failed: ${rec.lastError ?? "unknown error"}.` };
  }
  return { ...rec, state: "ready", summary: rec.lastOkAt ? "Viktor is answering in the app (in-app AI agent)." : "Viktor is ready (in-app AI agent). No instructions answered yet." };
}

export function viktorHealthNow(): ViktorHealth {
  let rec = EMPTY_HEALTH;
  try {
    rec = { ...EMPTY_HEALTH, ...getJson<Partial<ViktorHealthRecord>>(HEALTH_KEY, {}) };
  } catch {
    /* health is best-effort */
  }
  return deriveViktorHealth(rec, { enabled: viktorAgentEnabled(), configured: viktorAgentConfigured() });
}

function recordRun(r: ViktorRunResult): ViktorHealthRecord {
  const prev = { ...EMPTY_HEALTH, ...getJson<Partial<ViktorHealthRecord>>(HEALTH_KEY, {}) };
  const now = new Date().toISOString();
  const next: ViktorHealthRecord = r.ok
    ? { lastRunAt: now, lastOk: true, lastError: null, lastOkAt: now, consecutiveFailures: 0, model: r.model }
    : { ...prev, lastRunAt: now, lastOk: false, lastError: r.error ?? "unknown error", consecutiveFailures: prev.consecutiveFailures + 1, model: r.model };
  try {
    setJson(HEALTH_KEY, next);
  } catch {
    /* best-effort */
  }
  return next;
}

/** One ops alert per cool-off window, so a burst of failures doesn't spam the channel. */
function alertOnce(text: string): void {
  try {
    const last = getJson<number>(ALERT_KEY, 0);
    if (Date.now() - last < ALERT_COOLOFF_MS) return;
    setJson(ALERT_KEY, Date.now());
  } catch {
    /* if the dedupe store fails, still alert */
  }
  void slackNotify(text).catch(() => {});
}

// ── Instruction pickup ────────────────────────────────────────────────────────────────────────────────

interface SlackTarget {
  channel: string;
  threadTs: string | null;
  user: string | null;
}

function slackTargetOf(session: AiSession): SlackTarget | null {
  const input = session.input as { source?: string; slack?: { channel?: string; threadTs?: string | null; user?: string | null } } | null;
  if (input?.source !== "slack" || !input.slack?.channel) return null;
  return { channel: input.slack.channel, threadTs: input.slack.threadTs ?? null, user: input.slack.user ?? null };
}

export const WORKING_LABEL = "Viktor is working on it";
/** A claim older than this with no reply means the run died (e.g. a deploy restarted the server). */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

/** The session's unanswered instruction: its newest non-neutral event is an instruction, or a Viktor claim
 *  that went stale with no reply after it (then `reclaim` is true so a fresh claim key is used). */
export function pendingInstructionOf(sessionId: string, now: number = Date.now()): { text: string; ts: string; actor: string | null; reclaim: boolean } | null {
  const events = listSessionEvents(sessionId, 10).filter((e) => !NEUTRAL_EVENT_KINDS.includes(e.kind));
  const latest = events[0];
  if (!latest) return null;
  if (latest.kind === "instruction") return { text: latest.label ?? "", ts: latest.ts, actor: latest.actor ?? null, reclaim: false };
  const prev = events[1];
  if (
    latest.kind === "step" &&
    latest.actor === "Viktor" &&
    latest.label === WORKING_LABEL &&
    now - Date.parse(latest.ts) > STALE_CLAIM_MS &&
    prev?.kind === "instruction"
  ) {
    return { text: prev.label ?? "", ts: prev.ts, actor: prev.actor ?? null, reclaim: true };
  }
  return null;
}

export type InstructionOutcome = "answered" | "failed" | "skipped" | "disabled";

export interface HandleOptions {
  /** Whether the person asking may see money. In-app: from their role. Slack: approver allowlist. */
  showMoney?: boolean;
  /** Injected model client (tests). */
  client?: ViktorClient;
  /** Post a short "on it" in Slack if the answer takes longer than this. 0 disables. */
  ackAfterMs?: number;
}

/** Answer one session's pending instruction. Safe to call repeatedly or concurrently. Never throws. */
export async function handleSessionInstruction(sessionId: string, opts: HandleOptions = {}): Promise<InstructionOutcome> {
  try {
    const session = getSession(sessionId);
    if (!session || isSessionTerminal(session.status) || session.archived) return "skipped";
    const pending = pendingInstructionOf(sessionId);
    if (!pending || !pending.text.trim()) return "skipped";
    const slack = slackTargetOf(session);

    if (!viktorAgentEnabled()) {
      // Say so once per instruction rather than going silent.
      const ev = claimInstruction(sessionId, pending.ts, "Viktor is switched off, so this was not answered", "Viktor");
      if (ev && slack && slackBotConfigured()) void slackPostMessage(slack.channel, DISABLED_REPLY, slack.threadTs).catch(() => {});
      return ev ? "disabled" : "skipped";
    }

    // Claim first: a changeKey'd step, so a second trigger for the same instruction gets null and stops.
    const claimed = pending.reclaim
      ? appendEvent(sessionId, { kind: "step", actor: "Viktor", label: "Viktor is retrying (the last attempt was interrupted)", changeKey: `reclaim:${sessionId}:${pending.ts}` })
      : claimInstruction(sessionId, pending.ts, WORKING_LABEL, "Viktor");
    if (!claimed) return "skipped";

    // Slack: if the answer is slow, post a short ack so the thread never feels dropped.
    let done = false;
    const ackMs = opts.ackAfterMs ?? ACK_AFTER_MS;
    if (slack && slackBotConfigured() && ackMs > 0) {
      setTimeout(() => {
        if (!done) void slackPostMessage(slack.channel, SLACK_ACK, slack.threadTs).catch(() => {});
      }, ackMs).unref?.();
    }

    let history: TranscriptTurn[] = [];
    try {
      const ctx = await assembleThreadContext({ sessionId, slack: slack ? { channel: slack.channel, threadTs: slack.threadTs } : null, excludeText: pending.text });
      history = ctx.turns;
    } catch {
      history = [];
    }

    const askedBy = pending.actor ?? session.owner ?? session.startedBy ?? "unknown";
    const showMoney = opts.showMoney ?? (slack?.user ? safeIsApprover(slack.user) : false);
    const isViktor = session.agentId === "viktor";
    const sessionNote = isViktor
      ? undefined
      : `You are acting for the AI employee "${agentDisplayName(session.agentId)}"${session.blade ? ` on the ${session.blade} blade` : ""}. Session: "${session.title}".${session.objective ? ` Objective: ${session.objective}.` : ""}`;

    const result = await runViktorAgent(
      {
        instruction: pending.text,
        history,
        surface: slack ? "slack" : "app",
        sessionNote,
        today: todayInOpsTz(),
        ctx: { sessionId, instructionTs: pending.ts, askedBy, instruction: pending.text, showMoney, blade: session.blade },
      },
      opts.client,
    );
    done = true;
    recordRun(result);

    if (result.ok) {
      const text = humanize(result.text);
      setSessionResult(sessionId, { text, type: "answer", via: "viktor-agent", model: result.model, writes: result.writes });
      // The full reply goes on the timeline (label) so the in-app stream and the thread history both show it.
      appendEvent(sessionId, { kind: "message", actor: "Viktor", label: text, changeKey: `reply:${sessionId}:${pending.ts}` });
      if (slack && slackBotConfigured()) void slackPostMessage(slack.channel, text, slack.threadTs).catch(() => {});
      return "answered";
    }

    appendEvent(sessionId, { kind: "error", actor: "Viktor", label: `Viktor could not answer: ${result.error ?? "unknown error"}`, changeKey: `fail:${sessionId}:${pending.ts}` });
    if (slack && slackBotConfigured()) void slackPostMessage(slack.channel, FAILURE_REPLY, slack.threadTs).catch(() => {});
    alertOnce(`Viktor (in-app AI agent) failed to answer an instruction: ${result.error ?? "unknown error"}. Session ${sessionId}. Check ANTHROPIC_API_KEY and the AI Command Center.`);
    return "failed";
  } catch {
    return "failed";
  }
}

function safeIsApprover(slackUserId: string): boolean {
  try {
    return slackApproverIds().includes(slackUserId);
  } catch {
    return false;
  }
}

/** Backstop: answer anything still pending (e.g. a restart dropped an in-flight trigger). Oldest first,
 *  one at a time, bounded per call. Money stays hidden here (no live viewer to check). */
export async function drainPendingInstructions(limit = 5): Promise<{ answered: number; failed: number; pending: number }> {
  let answered = 0;
  let failed = 0;
  const ids = new Set(listPendingInstructions(limit).map((p) => p.sessionId));
  // Also pick up claims a restart interrupted (newest non-neutral event is a stale "working on it").
  for (const s of listLiveSessions(100)) {
    if (ids.size >= limit) break;
    if (!ids.has(s.id) && pendingInstructionOf(s.id)?.reclaim) ids.add(s.id);
  }
  const queue = [...ids];
  for (const sessionId of queue) {
    const out = await handleSessionInstruction(sessionId, { ackAfterMs: 0 });
    if (out === "answered") answered++;
    else if (out === "failed") failed++;
  }
  return { answered, failed, pending: queue.length };
}
