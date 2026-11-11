import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enqueueGsOp, ackGsOp, dismissGsOp, listGsOpsNeedingPerson, listPendingGsOps } from "@/lib/db/repo";
import {
  summarizeOutbox,
  evaluateOutbox,
  liveOutboxSummary,
  runOutboxHealthTick,
  outboxThresholds,
  KNOWN_DRAINABLE_OPS,
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

  it("a stuck op while other changes land → needs a person, but the office browser is NOT called down", () => {
    const s = summarizeOutbox([row({ created_at: iso(NOW - 258 * HOUR), op: "provision_user", label: "invite Sam to Quo" })], NOW, undefined, {
      staleMs: 6 * HOUR,
      lastLandedAt: iso(NOW - 10 * 60_000),
    });
    expect(s.stuckCount).toBe(1);
    expect(s.stuck[0].label).toBe("invite Sam to Quo");
    const a = evaluateOutbox(s, NOW, T);
    expect(a.down).toBe(true);
    expect(a.drainerDown).toBe(false);
    expect(a.reasons[0]).toMatch(/stuck in the queue/);
    expect(a.reasons[0]).toMatch(/invite Sam to Quo/);
    expect(a.reasons.join(" ")).not.toMatch(/signed out/);
  });

  it("an old op with nothing landing → the office browser looks stopped", () => {
    const s = summarizeOutbox([row({ created_at: iso(NOW - 8 * HOUR) })], NOW, undefined, { staleMs: 6 * HOUR, lastLandedAt: iso(NOW - 9 * HOUR) });
    const a = evaluateOutbox(s, NOW, T);
    expect(a.drainerDown).toBe(true);
    expect(a.reasons[0]).toMatch(/nothing has landed in 9h/);
  });

  it("dismissed ops are ignored, like landed ones", () => {
    const s = summarizeOutbox([row({ status: "dismissed", created_at: iso(NOW - 300 * HOUR) })], NOW);
    expect(s.pending).toBe(0);
    expect(evaluateOutbox(s, NOW, T).down).toBe(false);
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

// ── Dismissing a stuck or failed write-back ─────────────────────────────────────
describe("dismissGsOp + listGsOpsNeedingPerson", () => {
  it("lists dead ops and long-stuck pending ops, not fresh or landed ones", () => {
    const fresh = enqueueGsOp({ op: "note_append", transactionId: "1", label: "fresh", payload: { line: "a" } });
    const stuck = enqueueGsOp({ op: "provision_user", label: "stuck", payload: { system: "quo" } });
    const dead = enqueueGsOp({ op: "set_delivery_fee", transactionId: "2", label: "dead", payload: { amount: 10 } });
    const landed = enqueueGsOp({ op: "note_append", transactionId: "3", label: "landed", payload: { line: "b" } });
    const now = Date.now();
    getDb().prepare("UPDATE gs_outbox SET created_at = ? WHERE id IN (?, ?, ?)").run(iso(now - 48 * HOUR), stuck.id, dead.id, landed.id);
    getDb().prepare("UPDATE gs_outbox SET status = 'dead' WHERE id = ?").run(dead.id);
    getDb().prepare("UPDATE gs_outbox SET status = 'done' WHERE id = ?").run(landed.id);
    const ids = listGsOpsNeedingPerson(6 * HOUR, now).map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining([stuck.id, dead.id]));
    expect(ids).not.toContain(fresh.id);
    expect(ids).not.toContain(landed.id);
  });

  it("a dismissed op stops counting, records who and why, and never comes back to a drainer", () => {
    const op = enqueueGsOp({ op: "provision_user", label: "invite", payload: { system: "quo" } });
    getDb().prepare("UPDATE gs_outbox SET created_at = ? WHERE id = ?").run(iso(Date.now() - 300 * HOUR), op.id);
    expect(dismissGsOp(op.id, "Pat (Owner)", "Invited by hand").ok).toBe(true);
    const s = liveOutboxSummary();
    expect(s.pending).toBe(0);
    expect(listPendingGsOps().map((o) => o.id)).not.toContain(op.id);
    expect(listGsOpsNeedingPerson(6 * HOUR).map((o) => o.id)).not.toContain(op.id);
    expect(getDb().prepare("SELECT last_error FROM gs_outbox WHERE id = ?").get(op.id)).toEqual({ last_error: "Dismissed by Pat (Owner): Invited by hand" });
  });

  it("a landed op cannot be dismissed; an unknown id says so", () => {
    const op = enqueueGsOp({ op: "note_append", transactionId: "4", label: "x", payload: { line: "c" } });
    ackGsOp(op.id, true);
    expect(dismissGsOp(op.id, "Pat", "nope")).toEqual({ ok: false, from: "done", reason: "not_dismissable" });
    expect(dismissGsOp("missing", "Pat", "nope")).toEqual({ ok: false, reason: "not_found" });
  });
});

// ── Drift guard: the health list must match what the extension actually sends ──
describe("KNOWN_DRAINABLE_OPS", () => {
  it("matches the extension's HANDLED set (plus create_project, which background.js drains through the create gate)", () => {
    const src = readFileSync(join(process.cwd(), "extension", "pull-injected.js"), "utf8");
    const m = /const HANDLED = \{([^}]*)\}/.exec(src);
    expect(m).not.toBeNull();
    const handled = new Set([...m![1].matchAll(/([a-z_]+)\s*:/g)].map((x) => x[1]));
    expect(new Set([...handled, "create_project"])).toEqual(new Set(KNOWN_DRAINABLE_OPS));
  });
});
