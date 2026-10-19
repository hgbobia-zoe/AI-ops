import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { enqueueGsOp, ackGsOp } from "@/lib/db/repo";
import {
  summarizeOutbox,
  evaluateOutbox,
  liveOutboxSummary,
  runOutboxHealthTick,
  outboxThresholds,
  type OutboxHealthRow,
} from "./outboxHealth";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

const T = { staleHours: 6, depthAlarm: 25 };

function row(over: Partial<OutboxHealthRow>): OutboxHealthRow {
  return { op: "note_append", status: "pending", created_at: iso(NOW), attempts: 0, next_attempt_at: null, dead_lettered_at: null, ...over };
}

beforeEach(() => {
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM ai_approvals").run();
  getDb().prepare("DELETE FROM settings").run(); // the alarm's kv dedupe row lives here
  delete process.env.OUTBOX_PENDING_STALE_HOURS;
  delete process.env.OUTBOX_DEPTH_ALARM;
});
afterEach(() => {
  delete process.env.OUTBOX_PENDING_STALE_HOURS;
  delete process.env.OUTBOX_DEPTH_ALARM;
});

// ── Pure summary ────────────────────────────────────────────────────────────────
describe("summarizeOutbox", () => {
  it("empty queue → nothing due, oldest age null (never faked to 0)", () => {
    const s = summarizeOutbox([], NOW);
    expect(s.due).toBe(0);
    expect(s.oldestDueAgeMs).toBeNull();
  });

  it("separates due vs waiting-retry, and ages the oldest DUE op", () => {
    const s = summarizeOutbox(
      [
        row({ created_at: iso(NOW - 2 * HOUR) }), // due, 2h old
        row({ created_at: iso(NOW - 8 * HOUR) }), // due, 8h old → oldest
        row({ next_attempt_at: iso(NOW + HOUR) }), // waiting out backoff → not due
      ],
      NOW,
    );
    expect(s.pending).toBe(3);
    expect(s.due).toBe(2);
    expect(s.waitingRetry).toBe(1);
    expect(s.oldestDueAgeMs).toBe(8 * HOUR);
  });

  it("counts dead-letter, legacy failed, and UNHANDLED (unknown op types)", () => {
    const s = summarizeOutbox(
      [
        row({ status: "dead" }),
        row({ status: "failed" }),
        row({ op: "mystery_op" }), // nothing drains this
        row({ op: "frobnicate" }),
        row({ op: "email_send" }), // known
      ],
      NOW,
    );
    expect(s.deadLetter).toBe(1);
    expect(s.legacyFailed).toBe(1);
    expect(s.unhandled).toBe(2);
    expect(s.unhandledOps.sort()).toEqual(["frobnicate", "mystery_op"]);
  });

  it("a 'done' op is not a health concern", () => {
    const s = summarizeOutbox([row({ status: "done" })], NOW);
    expect(s.pending).toBe(0);
    expect(s.due).toBe(0);
  });
});

// ── Pure alarm thresholds ──────────────────────────────────────────────────────
describe("evaluateOutbox", () => {
  it("healthy queue → not down", () => {
    const s = summarizeOutbox([row({ created_at: iso(NOW - HOUR) })], NOW);
    expect(evaluateOutbox(s, NOW, T).down).toBe(false);
  });

  it("stale oldest op → down (drainer likely stopped)", () => {
    const s = summarizeOutbox([row({ created_at: iso(NOW - 7 * HOUR) })], NOW);
    const a = evaluateOutbox(s, NOW, T);
    expect(a.down).toBe(true);
    expect(a.reasons.join(" ")).toMatch(/old/);
  });

  it("backlog over depth → down", () => {
    const rows = Array.from({ length: 30 }, () => row({ created_at: iso(NOW - HOUR) }));
    const a = evaluateOutbox(summarizeOutbox(rows, NOW), NOW, T);
    expect(a.down).toBe(true);
    expect(a.reasons.join(" ")).toMatch(/waiting to drain/);
  });

  it("any dead-letter or unhandled op → down", () => {
    expect(evaluateOutbox(summarizeOutbox([row({ status: "dead" })], NOW), NOW, T).down).toBe(true);
    expect(evaluateOutbox(summarizeOutbox([row({ op: "mystery" })], NOW), NOW, T).down).toBe(true);
  });

  it("thresholds come from env with sane defaults", () => {
    expect(outboxThresholds()).toEqual({ staleHours: 6, depthAlarm: 25 });
    process.env.OUTBOX_PENDING_STALE_HOURS = "2";
    process.env.OUTBOX_DEPTH_ALARM = "5";
    expect(outboxThresholds()).toEqual({ staleHours: 2, depthAlarm: 5 });
  });
});

// ── Live wrappers + dedupe ──────────────────────────────────────────────────────
describe("liveOutboxSummary + runOutboxHealthTick", () => {
  it("reads the real queue and reports the oldest DUE pending op", () => {
    const op = enqueueGsOp({ op: "note_append", transactionId: "9", label: "x", payload: { line: "hi" } });
    getDb().prepare("UPDATE gs_outbox SET created_at = ? WHERE id = ?").run(iso(NOW - 10 * HOUR), op.id);
    const s = liveOutboxSummary(NOW);
    expect(s.due).toBe(1);
    expect(s.oldestDueAgeMs).toBe(10 * HOUR);
  });

  it("a dead-lettered op is visible and makes the tick report unhealthy", async () => {
    process.env.OUTBOX_MAX_ATTEMPTS = "1";
    const op = enqueueGsOp({ op: "email_send", transactionId: "1", label: "x", payload: { content: "<div>hi</div>" } });
    ackGsOp(op.id, false, "boom"); // budget 1 → immediate dead-letter
    delete process.env.OUTBOX_MAX_ATTEMPTS;
    const r = await runOutboxHealthTick(NOW);
    expect(r.ok).toBe(false);
    expect(r.summary.deadLetter).toBe(1);
    expect(r.detail).toMatch(/dead-lettered/);
  });

  it("deduped alarm: fires once, stays quiet within the cool-off, then a one-shot recovered note", async () => {
    // Unhealthy: a stale op.
    const op = enqueueGsOp({ op: "note_append", transactionId: "9", label: "x", payload: { line: "hi" } });
    getDb().prepare("UPDATE gs_outbox SET created_at = ? WHERE id = ?").run(iso(NOW - 48 * HOUR), op.id);

    const first = await runOutboxHealthTick(NOW);
    expect(first.ok).toBe(false);
    // Within the cool-off a second unhealthy tick must not re-alert — but it still reports ok:false.
    const second = await runOutboxHealthTick(NOW + 60_000);
    expect(second.ok).toBe(false);

    // Clear the queue → the next tick is healthy (and would emit the one-shot recovered note).
    ackGsOp(op.id, true);
    const recovered = await runOutboxHealthTick(NOW + 120_000);
    expect(recovered.ok).toBe(true);
    expect(recovered.summary.due).toBe(0);
  });
});
