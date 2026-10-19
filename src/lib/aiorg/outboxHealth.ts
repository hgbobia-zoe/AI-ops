// Did-It-Land verification lifecycle (WS03) — outbox HEALTH + staleness alarm. The outbox is the bridge
// for every Dispatch/AI → Goodshuffle write; if the office drainer stops (tab closed, signed out) or an
// op type nothing can drain piles up, approved work silently stops landing. This surfaces that, reusing
// the EXISTING staleness-alarm pattern (pure decider + kv dedupe + one-shot recovered note, exactly like
// responderHealth / recordInstaworkProbe) — not a new notification system. The runtime job (jobs.ts)
// calls runOutboxHealthTick each tick; the Slack post goes to the same ops channel as the sibling alarms.
//
// Deterministic: summarizeOutbox + decideOutboxAlert are pure (explicit rows + clock), unit-tested with
// no DB. Honest: a count the data can't support is never faked; "oldest pending age" is null when the
// queue is empty, never 0.

import { getDb } from "@/lib/db";
import { slackNotify } from "@/lib/notify/slack";
import { getJson, setJson } from "@/lib/kv";
import { decideJobAlert, formatAge, type JobAlertRecord } from "@/lib/ai/responderHealth";

// Op types a logged-in drainer (office extension and/or bookmarklet) actually knows how to replay. Kept
// in sync with extension/pull-injected.js (HANDLED) + src/lib/gsPull.ts. A PENDING op whose type is NOT
// here is "unhandled" — nothing will ever drain it, so it must be surfaced, never left to sit forever.
export const KNOWN_DRAINABLE_OPS: ReadonlySet<string> = new Set([
  "photo_upload",
  "note_append",
  "add_team_member",
  "set_delivery_fee",
  "email_send",
  "create_gs_task",
  "provision_user",
  "revoke_user",
  "create_project",
  "remove_waypoint",
]);

/** The kv row for the outbox alarm dedupe — its OWN namespaced key (never shares the responder's). */
const ALARM_KEY = "ai.outbox.alarm";

/** 2h cool-off + one-shot recovered note — matches the other alarm producers. */
export const OUTBOX_ALARM_COOLOFF_MS = 2 * 60 * 60 * 1000;

export interface OutboxThresholds {
  /** Oldest DUE-pending op older than this (hours) → stale. Default tolerates an overnight-closed office
   *  tab (the pull runs ~once/day + a 10-min drain while open) while still catching a genuinely stuck queue. */
  staleHours: number;
  /** DUE-pending depth above this → backlog alarm. */
  depthAlarm: number;
}

export function outboxThresholds(): OutboxThresholds {
  const h = Number(process.env.OUTBOX_PENDING_STALE_HOURS);
  const d = Number(process.env.OUTBOX_DEPTH_ALARM);
  return {
    staleHours: Number.isFinite(h) && h > 0 ? h : 6,
    depthAlarm: Number.isFinite(d) && d > 0 ? Math.floor(d) : 25,
  };
}

// ── Pure summary ──────────────────────────────────────────────────────────────────────────────────

/** The lightweight outbox row the summary needs (status/op/created_at/attempts/backoff/dead-letter). */
export interface OutboxHealthRow {
  op: string;
  status: string;
  created_at: string;
  attempts: number;
  next_attempt_at: string | null;
  dead_lettered_at: string | null;
}

export interface OutboxSummary {
  pending: number; //            all status='pending' (incl. ops waiting out a retry backoff)
  due: number; //                pending AND eligible now (next_attempt_at null or past)
  waitingRetry: number; //       pending but held behind a future backoff gate
  oldestDueAgeMs: number | null; // age of the oldest DUE-pending op, null when none are due
  deadLetter: number; //         status='dead' — bounded retries exhausted, needs a human
  legacyFailed: number; //       status='failed' — pre-WS03 rows that never retried (also needs attention)
  unhandled: number; //          pending ops of a type NO drainer handles (stuck forever)
  unhandledOps: string[]; //     the distinct unknown op types, for the alarm copy
}

/** PURE. Summarize the outbox from its rows + now. */
export function summarizeOutbox(
  rows: OutboxHealthRow[],
  now: number,
  knownOps: ReadonlySet<string> = KNOWN_DRAINABLE_OPS,
): OutboxSummary {
  let pending = 0;
  let due = 0;
  let waitingRetry = 0;
  let deadLetter = 0;
  let legacyFailed = 0;
  let unhandled = 0;
  let oldestDueMs: number | null = null;
  const unknownSet = new Set<string>();

  for (const r of rows) {
    if (r.status === "dead") {
      deadLetter++;
      continue;
    }
    if (r.status === "failed") {
      legacyFailed++;
      continue;
    }
    if (r.status !== "pending") continue; // done — not a health concern
    pending++;
    const eligible = !r.next_attempt_at || Date.parse(r.next_attempt_at) <= now;
    if (eligible) {
      due++;
      const age = now - Date.parse(r.created_at);
      if (Number.isFinite(age) && (oldestDueMs === null || age > oldestDueMs)) oldestDueMs = age;
      if (!knownOps.has(r.op)) {
        unhandled++;
        unknownSet.add(r.op);
      }
    } else {
      waitingRetry++;
    }
  }

  return {
    pending,
    due,
    waitingRetry,
    oldestDueAgeMs: oldestDueMs,
    deadLetter,
    legacyFailed,
    unhandled,
    unhandledOps: [...unknownSet],
  };
}

// ── Pure alarm decision ─────────────────────────────────────────────────────────────────────────────

export interface OutboxAlarm {
  down: boolean; //      true when any threshold is tripped
  reasons: string[]; //  human one-liners for the Slack copy
}

/** PURE. Decide whether the outbox is unhealthy from the summary + thresholds. */
export function evaluateOutbox(summary: OutboxSummary, now: number, t: OutboxThresholds = outboxThresholds()): OutboxAlarm {
  const reasons: string[] = [];
  const staleMs = t.staleHours * 3_600_000;
  if (summary.oldestDueAgeMs !== null && summary.oldestDueAgeMs > staleMs) {
    reasons.push(`oldest pending write-back is ${formatAge(summary.oldestDueAgeMs)} old (drainer may be down — open the office Goodshuffle tab)`);
  }
  if (summary.due > t.depthAlarm) {
    reasons.push(`${summary.due} write-backs are waiting to drain`);
  }
  if (summary.deadLetter > 0) {
    reasons.push(`${summary.deadLetter} op${summary.deadLetter === 1 ? "" : "s"} dead-lettered (retries exhausted — needs a human)`);
  }
  if (summary.unhandled > 0) {
    reasons.push(`${summary.unhandled} queued op${summary.unhandled === 1 ? "" : "s"} of a type no drainer handles (${summary.unhandledOps.join(", ")})`);
  }
  if (summary.legacyFailed > 0) {
    reasons.push(`${summary.legacyFailed} legacy failed op${summary.legacyFailed === 1 ? "" : "s"} never retried`);
  }
  return { down: reasons.length > 0, reasons };
}

// ── Live wrappers (thin DB + kv + Slack glue) ─────────────────────────────────────────────────────────

/** Read the current outbox summary from the DB. */
export function liveOutboxSummary(now: number = Date.now()): OutboxSummary {
  const rows = getDb()
    .prepare("SELECT op, status, created_at, attempts, next_attempt_at, dead_lettered_at FROM gs_outbox WHERE status IN ('pending','dead','failed')")
    .all() as OutboxHealthRow[];
  return summarizeOutbox(rows, now);
}

interface AlarmState {
  job?: JobAlertRecord;
}

/** Apply the shared decideJobAlert decider against this alarm's OWN kv row (reuses the pure decider, not
 *  the responder's kv glue), so we Slack at most once per cool-off with a one-shot recovered note. */
function recordOutboxAlert(down: boolean, now: number, cooloffMs: number = OUTBOX_ALARM_COOLOFF_MS): { alert: "down" | "recovered" | null } {
  const s = getJson<AlarmState>(ALARM_KEY, {});
  const { alert, next } = decideJobAlert(s.job, down, now, cooloffMs);
  if (next) s.job = next;
  else delete s.job;
  setJson(ALARM_KEY, s);
  return { alert };
}

export interface OutboxHealthTick {
  ok: boolean;
  detail: string;
  summary: OutboxSummary;
}

/**
 * The runtime-job tick: summarize the outbox, decide the alarm, and (deduped) Slack the ops channel when
 * it goes unhealthy — with a one-shot recovered note when it clears. Returns a status line for the job
 * ledger. Never throws; a Slack hiccup never fails the tick.
 */
export async function runOutboxHealthTick(now: number = Date.now()): Promise<OutboxHealthTick> {
  const summary = liveOutboxSummary(now);
  const alarm = evaluateOutbox(summary, now);
  const { alert } = recordOutboxAlert(alarm.down, now);

  if (alert === "down") {
    await slackNotify(`⚠️ Goodshuffle write-back outbox is unhealthy: ${alarm.reasons.join("; ")}. Approved actions queue here and only land when the office Auto-Pull drains them.`).catch(() => {});
  } else if (alert === "recovered") {
    await slackNotify("✅ Goodshuffle write-back outbox recovered — the queue is draining again.").catch(() => {});
  }

  const detail = alarm.down
    ? alarm.reasons.join("; ")
    : summary.due === 0
      ? "outbox clear"
      : `${summary.due} queued, oldest ${formatAge(summary.oldestDueAgeMs)}${summary.waitingRetry ? `, ${summary.waitingRetry} awaiting retry` : ""}`;
  // A tripped alarm reports ok:false so /admin health shows it red; a healthy queue (even with normal
  // backlog) is ok:true.
  return { ok: !alarm.down, detail, summary };
}
