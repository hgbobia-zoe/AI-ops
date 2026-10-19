import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { enqueueGsOp, ackGsOp, listPendingGsOps, listDeadLetterGsOps, getGsOpById } from "@/lib/db/repo";
import { createApproval, decideApproval, getApproval, getApprovalLifecycle, actionPhase } from "./approvals";
import {
  backoffMs,
  decideAckTransition,
  reconcileApprovalForOp,
  DEFAULT_MAX_ATTEMPTS,
  BACKOFF_CAP_MS,
  retryConfig,
} from "./outboxLifecycle";

const CFG = { defaultMaxAttempts: 3, baseMs: 1000, capMs: 100000 };

beforeEach(() => {
  getDb().prepare("DELETE FROM ai_approvals").run();
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM audit_logs").run();
  delete process.env.EMAIL_SEND_ENABLED;
  delete process.env.OUTBOX_MAX_ATTEMPTS;
});
afterEach(() => {
  delete process.env.EMAIL_SEND_ENABLED;
  delete process.env.OUTBOX_MAX_ATTEMPTS;
});

// ── Pure backoff + transition ─────────────────────────────────────────────────────
describe("backoffMs", () => {
  it("is exponential and capped", () => {
    expect(backoffMs(1, CFG)).toBe(1000);
    expect(backoffMs(2, CFG)).toBe(2000);
    expect(backoffMs(3, CFG)).toBe(4000);
    expect(backoffMs(99, CFG)).toBe(CFG.capMs); // capped
  });
  it("respects the real cap constant via default config", () => {
    expect(backoffMs(99)).toBe(BACKOFF_CAP_MS);
  });
});

describe("decideAckTransition", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("success → done, no backoff, no dead-letter", () => {
    const t = decideAckTransition({ attempts: 0, maxAttempts: null }, true, undefined, now, CFG);
    expect(t).toMatchObject({ status: "done", attempts: 1, nextAttemptAt: null, deadLetteredAt: null, retrying: false });
  });

  it("transient failure below budget → pending + backoff gate (retrying)", () => {
    const t = decideAckTransition({ attempts: 0, maxAttempts: null }, false, "boom", now, CFG);
    expect(t.status).toBe("pending");
    expect(t.attempts).toBe(1);
    expect(t.retrying).toBe(true);
    expect(t.lastError).toBe("boom");
    expect(Date.parse(t.nextAttemptAt!)).toBe(now + 1000); // base backoff for attempt 1
    expect(t.deadLetteredAt).toBeNull();
  });

  it("failure at the budget → dead-letter (never retried past the limit)", () => {
    const t = decideAckTransition({ attempts: CFG.defaultMaxAttempts - 1, maxAttempts: null }, false, "boom", now, CFG);
    expect(t.status).toBe("dead");
    expect(t.attempts).toBe(CFG.defaultMaxAttempts);
    expect(t.retrying).toBe(false);
    expect(t.deadLetteredAt).toBe(new Date(now).toISOString());
  });

  it("honors a per-op max_attempts over the config default", () => {
    const t = decideAckTransition({ attempts: 0, maxAttempts: 1 }, false, "x", now, CFG);
    expect(t.status).toBe("dead"); // budget of 1 → first failure is terminal
  });

  it("env OUTBOX_MAX_ATTEMPTS overrides the default", () => {
    process.env.OUTBOX_MAX_ATTEMPTS = "9";
    expect(retryConfig().defaultMaxAttempts).toBe(9);
    delete process.env.OUTBOX_MAX_ATTEMPTS;
    expect(retryConfig().defaultMaxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });
});

// ── reconcileApprovalForOp (pure-ish, over the DB) ─────────────────────────────────
describe("reconcileApprovalForOp", () => {
  function seedApproval(status: string, opId: string): string {
    const id = `AP-test-${status}`;
    getDb()
      .prepare(
        `INSERT INTO ai_approvals (id, agent_id, owner, title, action_type, status, created_at, outbox_op_id)
         VALUES (@id,'outreach','Jessie','t','send_email',@status,@now,@op)`,
      )
      .run({ id, status, op: opId, now: new Date().toISOString() });
    return id;
  }

  it("op done → approval CONFIRMED (destination acceptance)", () => {
    const id = seedApproval("queued", "GO-1");
    const r = reconcileApprovalForOp("GO-1", { status: "done", attempts: 1, nextAttemptAt: null, deadLetteredAt: null, lastError: null, retrying: false });
    expect(r).toMatchObject({ reconciled: true, to: "confirmed" });
    expect(getApproval(id)!.status).toBe("confirmed");
  });

  it("op dead → approval FAILED with a dead-letter reason", () => {
    const id = seedApproval("queued", "GO-2");
    const r = reconcileApprovalForOp("GO-2", { status: "dead", attempts: 3, nextAttemptAt: null, deadLetteredAt: "x", lastError: "boom", retrying: false });
    expect(r.to).toBe("failed");
    const a = getApproval(id)!;
    expect(a.status).toBe("failed");
    expect(a.decisionNote).toContain("Dead-lettered");
  });

  it("op pending (retrying) → approval stays QUEUED with the attempt noted", () => {
    const id = seedApproval("queued", "GO-3");
    reconcileApprovalForOp("GO-3", { status: "pending", attempts: 2, nextAttemptAt: "2026-01-01T00:00:00Z", deadLetteredAt: null, lastError: "timeout", retrying: true });
    const a = getApproval(id)!;
    expect(a.status).toBe("queued");
    expect(a.decisionNote).toContain("Attempt 2");
  });

  it("promotes a LEGACY 'executed' row forward (confirmed)", () => {
    const id = seedApproval("executed", "GO-4");
    reconcileApprovalForOp("GO-4", { status: "done", attempts: 1, nextAttemptAt: null, deadLetteredAt: null, lastError: null, retrying: false });
    expect(getApproval(id)!.status).toBe("confirmed");
  });

  it("is a no-op for an op with no linked approval, and idempotent on a terminal approval", () => {
    expect(reconcileApprovalForOp("GO-none", { status: "done", attempts: 1, nextAttemptAt: null, deadLetteredAt: null, lastError: null, retrying: false }).reconciled).toBe(false);
    const id = seedApproval("confirmed", "GO-5");
    const r = reconcileApprovalForOp("GO-5", { status: "dead", attempts: 3, nextAttemptAt: null, deadLetteredAt: "x", lastError: "late", retrying: false });
    expect(r.reconciled).toBe(false); // already terminal — not moved
    expect(getApproval(id)!.status).toBe("confirmed");
  });
});

// ── End-to-end through ackGsOp (the single shared choke point) ──────────────────────
describe("ackGsOp lifecycle + approval reconciliation", () => {
  function approvedEmailOp(key: string): { approvalId: string; opId: string } {
    process.env.EMAIL_SEND_ENABLED = "true";
    const a = createApproval({
      agentId: "outreach",
      owner: "Jessie",
      title: "Email",
      actionType: "send_email",
      actionPayload: { transactionId: "555", body: "Hello" },
      card: { what: "w", why: "y", dataUsed: "d", expectedOutcome: "e", risk: "r", whatIfApproved: "i" },
      idempotencyKey: key,
    });
    const r = decideApproval(a.id, "approve", "Tester");
    return { approvalId: a.id, opId: r.approval.outboxOpId! };
  }

  it("SUCCESS: enqueue → queued, ack done → op done + approval confirmed", () => {
    const { approvalId, opId } = approvedEmailOp("e-ok");
    expect(getApproval(approvalId)!.status).toBe("queued");
    const res = ackGsOp(opId, true);
    expect(res.status).toBe("done");
    expect(res.approvalReconciledTo).toBe("confirmed");
    expect(getGsOpById(opId)!.status).toBe("done");
    expect(getApproval(approvalId)!.status).toBe("confirmed");
    // A confirmed op is no longer pending.
    expect(listPendingGsOps(50).some((o) => o.id === opId)).toBe(false);
  });

  it("TRANSIENT then PERMANENT: retries with backoff, then dead-letters and fails the approval", () => {
    process.env.OUTBOX_MAX_ATTEMPTS = "3";
    const { approvalId, opId } = approvedEmailOp("e-fail");

    // Attempt 1 fails → held for retry (pending, but gated behind a future backoff → not due now).
    expect(ackGsOp(opId, false, "err1").status).toBe("pending");
    expect(getApproval(approvalId)!.status).toBe("queued");
    expect(listPendingGsOps(50).some((o) => o.id === opId)).toBe(false); // waiting out backoff

    // Clear the backoff gate to simulate the next eligible cycle, and fail again.
    getDb().prepare("UPDATE gs_outbox SET next_attempt_at = NULL WHERE id = ?").run(opId);
    expect(listPendingGsOps(50).some((o) => o.id === opId)).toBe(true); // due again
    expect(ackGsOp(opId, false, "err2").status).toBe("pending");

    // Third failure hits the budget → dead-letter + approval failed.
    getDb().prepare("UPDATE gs_outbox SET next_attempt_at = NULL WHERE id = ?").run(opId);
    const res = ackGsOp(opId, false, "err3");
    expect(res.status).toBe("dead");
    expect(res.approvalReconciledTo).toBe("failed");
    expect(getGsOpById(opId)!.status).toBe("dead");
    expect(listDeadLetterGsOps(50).some((o) => o.id === opId)).toBe(true);
    const a = getApproval(approvalId)!;
    expect(a.status).toBe("failed");
    expect(a.decisionNote).toContain("Dead-lettered");
  });

  it("duplicate/unknown ack is idempotent (noop on an unknown id)", () => {
    expect(ackGsOp("GO-does-not-exist", true).status).toBe("noop");
  });

  it("a non-approval op (direct enqueue) acks cleanly with no reconciliation", () => {
    const op = enqueueGsOp({ op: "note_append", transactionId: "9", label: "x", payload: { line: "hi" } });
    const res = ackGsOp(op.id, true);
    expect(res.status).toBe("done");
    expect(res.approvalReconciledTo).toBeUndefined();
  });
});

// ── Correlated lifecycle read (the WS05 contract) ──────────────────────────────────
describe("getApprovalLifecycle + actionPhase", () => {
  it("correlates approval → op → phase", () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    const a = createApproval({
      agentId: "outreach", owner: "Jessie", title: "Email", actionType: "send_email",
      actionPayload: { transactionId: "555", body: "Hi" },
      card: { what: "w", why: "y", dataUsed: "d", expectedOutcome: "e", risk: "r", whatIfApproved: "i" },
      idempotencyKey: "lc-1",
    });
    decideApproval(a.id, "approve", "Tester");
    const lc = getApprovalLifecycle(a.id)!;
    expect(lc.phase).toBe("queued");
    expect(lc.op).toBeTruthy();
    ackGsOp(lc.op!.id, true);
    expect(getApprovalLifecycle(a.id)!.phase).toBe("confirmed");
  });

  it("actionPhase is pure and honest about a dead-lettered in-flight op", () => {
    expect(actionPhase("pending")).toBe("proposed");
    expect(actionPhase("approved")).toBe("held");
    expect(actionPhase("queued")).toBe("queued");
    expect(actionPhase("queued", "dead")).toBe("failed"); // op dead-lettered under an in-flight approval
    expect(actionPhase("executed", "done")).toBe("queued"); // legacy in-flight
    expect(actionPhase("confirmed")).toBe("confirmed");
    expect(actionPhase("failed")).toBe("failed");
  });
});
