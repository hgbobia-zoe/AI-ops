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
import { postStatus } from "@/lib/notify/status";
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
  "email_template",
  "create_gs_task",
  "provision_user",
  "revoke_user",
  "create_project",
  "remove_waypoint",
  "gs_status",
  "disable_esignature",
  "mark_lost",
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
  label?: string | null;
}

/** One change that has waited past the stale threshold, for the alarm copy. */
export interface StuckOp {
  op: string;
  label: string | null;
  ageMs: number;
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
  stuckCount: number; //         DUE-pending ops older than the stale threshold
  stuck: StuckOp[]; //           the oldest few of those, oldest first
  lastLandedAgeMs: number | null; // how long since ANY write-back landed; null when unknown
}

export interface SummaryOptions {
  /** A due op older than this counts as stuck. Default: the configured stale threshold. */
  staleMs?: number;
  /** When the newest write-back landed (status done). Lets the alarm tell "the office browser stopped"
   *  apart from "a few items are stuck while everything else lands". */
  lastLandedAt?: string | null;
}

/** PURE. Summarize the outbox from its rows + now. */
export function summarizeOutbox(
  rows: OutboxHealthRow[],
  now: number,
  knownOps: ReadonlySet<string> = KNOWN_DRAINABLE_OPS,
  opts: SummaryOptions = {},
): OutboxSummary {
  const staleMs = opts.staleMs ?? outboxThresholds().staleHours * 3_600_000;
  let pending = 0;
  let due = 0;
  let waitingRetry = 0;
  let deadLetter = 0;
  let legacyFailed = 0;
  let unhandled = 0;
  let oldestDueMs: number | null = null;
  const unknownSet = new Set<string>();
  const stuck: StuckOp[] = [];

  for (const r of rows) {
    if (r.status === "dead") {
      deadLetter++;
      continue;
    }
    if (r.status === "failed") {
      legacyFailed++;
      continue;
    }
    if (r.status !== "pending") continue; // done or dismissed: not a health concern
    pending++;
    const eligible = !r.next_attempt_at || Date.parse(r.next_attempt_at) <= now;
    if (eligible) {
      due++;
      const age = now - Date.parse(r.created_at);
      if (Number.isFinite(age)) {
        if (oldestDueMs === null || age > oldestDueMs) oldestDueMs = age;
        if (age > staleMs) stuck.push({ op: r.op, label: r.label ?? null, ageMs: age });
      }
      if (!knownOps.has(r.op)) {
        unhandled++;
        unknownSet.add(r.op);
      }
    } else {
      waitingRetry++;
    }
  }

  stuck.sort((a, b) => b.ageMs - a.ageMs);
  const landedMs = opts.lastLandedAt ? now - Date.parse(opts.lastLandedAt) : NaN;
  return {
    pending,
    due,
    waitingRetry,
    oldestDueAgeMs: oldestDueMs,
    deadLetter,
    legacyFailed,
    unhandled,
    unhandledOps: [...unknownSet],
    stuckCount: stuck.length,
    stuck: stuck.slice(0, 3),
    lastLandedAgeMs: Number.isFinite(landedMs) ? Math.max(0, landedMs) : null,
  };
}

// ── Pure alarm decision ─────────────────────────────────────────────────────────────────────────────

export interface OutboxAlarm {
  down: boolean; //        true when any threshold is tripped
  drainerDown: boolean; // true only when nothing is landing at all (the office browser looks stopped)
  reasons: string[]; //    human one-liners for the Slack copy
}

const plural = (n: number, one: string, many: string = one + "s"): string => `${n} ${n === 1 ? one : many}`;

/** PURE. Decide whether the outbox is unhealthy from the summary + thresholds. */
export function evaluateOutbox(summary: OutboxSummary, now: number, t: OutboxThresholds = outboxThresholds()): OutboxAlarm {
  const reasons: string[] = [];
  const staleMs = t.staleHours * 3_600_000;
  let drainerDown = false;
  if (summary.oldestDueAgeMs !== null && summary.oldestDueAgeMs > staleMs) {
    const landing = summary.lastLandedAgeMs !== null && summary.lastLandedAgeMs <= staleMs;
    if (landing) {
      // Other changes land, so the office browser works. These items are stuck on their own.
      const n = Math.max(summary.stuckCount, 1);
      const names = summary.stuck.map((s) => s.label || s.op).join(", ");
      reasons.push(
        `${plural(n, "change")} stuck in the queue, oldest ${formatAge(summary.oldestDueAgeMs)}${names ? ` (${names})` : ""}. Other changes are landing, so Auto-Pull is running`,
      );
    } else {
      drainerDown = true;
      const since = summary.lastLandedAgeMs !== null ? `nothing has landed in ${formatAge(summary.lastLandedAgeMs)}` : "nothing has landed recently";
      reasons.push(`${since} and the oldest change has waited ${formatAge(summary.oldestDueAgeMs)}. Auto-Pull may have stopped: no teammate's Chrome looks signed in to Goodshuffle`);
    }
  }
  if (summary.due > t.depthAlarm) {
    reasons.push(`${summary.due} write-backs are waiting to drain`);
  }
  if (summary.deadLetter > 0) {
    reasons.push(`${plural(summary.deadLetter, "change")} failed after every retry (dead-lettered) and ${summary.deadLetter === 1 ? "needs" : "need"} a person`);
  }
  if (summary.unhandled > 0) {
    reasons.push(`${plural(summary.unhandled, "queued change")} of a type nothing can send (${summary.unhandledOps.join(", ")})`);
  }
  if (summary.legacyFailed > 0) {
    reasons.push(`${plural(summary.legacyFailed, "old failed change")} never retried`);
  }
  return { down: reasons.length > 0, drainerDown, reasons };
}

// ── Live wrappers (thin DB + kv + Slack glue) ─────────────────────────────────────────────────────────

/** Read the current outbox summary from the DB. */
export function liveOutboxSummary(now: number = Date.now()): OutboxSummary {
  const db = getDb();
  const rows = db
    .prepare("SELECT op, status, created_at, attempts, next_attempt_at, dead_lettered_at, label FROM gs_outbox WHERE status IN ('pending','dead','failed')")
    .all() as OutboxHealthRow[];
  const last = db.prepare("SELECT MAX(updated_at) AS at FROM gs_outbox WHERE status = 'done'").get() as { at: string | null } | undefined;
  return summarizeOutbox(rows, now, KNOWN_DRAINABLE_OPS, { lastLandedAt: last?.at ?? null });
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
    await postStatus(
      alarm.drainerDown
        ? {
            system: "Goodshuffle write-back",
            level: "degraded",
            title: "Goodshuffle write-backs are not landing",
            impact: "Approved changes (photos, emails, tasks, status updates) wait in the queue until the office Auto-Pull sends them.",
            fix: "Make sure an office computer has Goodshuffle open and signed in.",
            detail: alarm.reasons.join("; "),
          }
        : {
            system: "Goodshuffle write-back",
            level: "degraded",
            title: "Some Goodshuffle write-backs need a person",
            impact: "Most changes are landing. The items listed are stuck or failed and will not land on their own.",
            fix: "Open the Automation page, Goodshuffle write-backs. Redo each item in the app if it is still needed, then dismiss it with a reason.",
            detail: alarm.reasons.join("; "),
          },
      now,
    );
  } else if (alert === "recovered") {
    await postStatus({
      system: "Goodshuffle write-back",
      level: "recovered",
      title: "Goodshuffle write-backs are landing again",
      impact: "The queue is draining.",
    }, now);
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
