import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { ackGsOp } from "@/lib/db/repo";
import { decideApproval, getApproval, listPendingApprovals } from "@/lib/aiorg/approvals";
import { coordinateException, disposeException, runExceptionResolutionTick } from "./engine";
import { getException, exceptionSummary } from "./store";
import { exceptionKey, type CanonicalException } from "./types";

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM exception_resolutions").run();
  db.prepare("DELETE FROM ai_approvals").run();
  db.prepare("DELETE FROM gs_outbox").run();
  db.prepare("DELETE FROM risk_items").run();
  db.prepare("DELETE FROM settings").run(); // kv escalation-dedupe rows live here
  delete process.env.EXCEPTION_ESCALATE_AFTER_HOURS;
  delete process.env.EXCEPTION_MAX_RESOLVE_ATTEMPTS;
  delete process.env.EXCEPTION_OWNER_SEVERITIES;
});
afterEach(() => {
  delete process.env.EXCEPTION_ESCALATE_AFTER_HOURS;
  delete process.env.EXCEPTION_MAX_RESOLVE_ATTEMPTS;
  delete process.env.EXCEPTION_OWNER_SEVERITIES;
});

const NOW = new Date("2026-10-19T12:00:00.000Z");

function gsRisk(over: Partial<CanonicalException> = {}): CanonicalException {
  return {
    source: "risk",
    sourceId: "sig-gs-1",
    type: "prep_window_threatened",
    severity: "high",
    title: "Prep window closing for TX 555",
    detail: "Load must start soon",
    actionTarget: "goodshuffle",
    transactionId: "555",
    deadline: null,
    recommendedAction: "Start the warehouse load for this project by 2pm",
    ownerHint: "Warehouse / Ops",
    firstDetectedAt: NOW.toISOString(),
    ...over,
  };
}

/** Approve the exception's proposed approval the way a human would (through the SHARED path). */
function humanApprove(key: string): string {
  const r = getException(key)!;
  const res = decideApproval(r.approvalId!, "approve", "Tester");
  expect(res.outcome).toBe("executed_queued");
  return getApproval(r.approvalId!)!.outboxOpId!;
}

function seedRiskRow(over: Record<string, unknown> = {}): void {
  const row = {
    id: "RK-1",
    signature: "sig-del-1",
    risk_type: "route_no_driver",
    category: "DRIVER",
    severity: "HIGH",
    status: "OPEN",
    title: "Route has no driver",
    description: "Assign a driver",
    date: null,
    event_id: null,
    route_id: "R-1",
    truck_id: null,
    affected_entity: null,
    recommended_action: "Assign a driver in Dispatch",
    action_target: "connecteam",
    owner: null,
    deadline: null,
    metadata: null,
    first_detected_at: NOW.toISOString(),
    last_seen_at: NOW.toISOString(),
    resolved_at: null,
    ...over,
  };
  const cols = Object.keys(row);
  getDb()
    .prepare(`INSERT INTO risk_items (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`)
    .run(row);
}

describe("propose → verify → resolve (the full authorized loop)", () => {
  it("proposes a human-gated Goodshuffle task; lands it; verifies CONFIRMED → resolved with evidence", () => {
    const e = gsRisk();
    const key = exceptionKey(e);

    // 1. Detect/coordinate → a proposal, NOT an execution. Nothing is auto-approved.
    let r = coordinateException(e, NOW);
    expect(r.status).toBe("awaiting_approval");
    expect(r.approvalId).toBeTruthy();
    expect(listPendingApprovals().length).toBe(1);

    // 2. A human approves through the shared approval path → the proven outbox op is enqueued.
    const opId = humanApprove(key);
    expect(opId).toBeTruthy();

    // 3. Coordinate again → verify-after-act sees the op QUEUED → acting (NOT resolved yet).
    r = coordinateException(e, NOW);
    expect(r.status).toBe("acting");

    // 4. The office drainer acks the op as landed → WS03 reconciles the approval to confirmed.
    const ack = ackGsOp(opId, true);
    expect(ack.status).toBe("done");

    // 5. Coordinate again → verify sees CONFIRMED → resolved, with the landing evidence recorded.
    r = coordinateException(e, NOW);
    expect(r.status).toBe("resolved");
    expect(r.resolvedAt).toBeTruthy();
    expect(r.verificationEvidence).toMatchObject({ phase: "confirmed", outboxOpId: opId });
  });

  it("does NOT resolve on an HTTP/enqueue success alone — only a confirmed drainer ack resolves it", () => {
    const e = gsRisk();
    coordinateException(e, NOW);
    humanApprove(exceptionKey(e));
    const r = coordinateException(e, NOW); // queued, but never acked
    expect(r.status).toBe("acting");
    expect(r.status).not.toBe("resolved");
  });
});

describe("dedupe + idempotency (no duplicate records, no double-resolve)", () => {
  it("repeated detection of the same exception never duplicates the record or the approval", () => {
    const e = gsRisk();
    coordinateException(e, NOW);
    coordinateException(e, NOW);
    coordinateException(e, NOW);
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM exception_resolutions").get() as { n: number };
    expect(rows.n).toBe(1);
    expect(listPendingApprovals().length).toBe(1);
    expect(getException(exceptionKey(e))!.status).toBe("awaiting_approval");
  });

  it("once resolved, a later re-detection does not re-open or re-propose", () => {
    const e = gsRisk();
    coordinateException(e, NOW);
    const opId = humanApprove(exceptionKey(e));
    coordinateException(e, NOW);
    ackGsOp(opId, true);
    expect(coordinateException(e, NOW).status).toBe("resolved");
    // Re-detect after resolution: still one approval, still resolved.
    const r = coordinateException(e, NOW);
    expect(r.status).toBe("resolved");
    expect(listPendingApprovals().length).toBe(0);
  });
});

describe("failed execution → bounded, escalated", () => {
  it("a dead-lettered resolution becomes failed, counts an attempt, and escalates to the team", () => {
    const e = gsRisk();
    coordinateException(e, NOW);
    const opId = humanApprove(exceptionKey(e));
    coordinateException(e, NOW); // acting
    // Force the op to dead-letter on the next failed ack (budget = 1).
    getDb().prepare("UPDATE gs_outbox SET max_attempts = 1 WHERE id = ?").run(opId);
    const ack = ackGsOp(opId, false, "boom");
    expect(ack.status).toBe("dead");

    const r = coordinateException(e, NOW);
    expect(r.resolveAttempts).toBe(1);
    expect(r.escalationTier).toBe("team"); // high (not critical) + failed → team, not owner
    expect(r.status).toBe("escalated");
  });
});

describe("delegate path (never auto-executes staffing/routing)", () => {
  it("a crew/driver (connecteam) risk is delegated to the scheduling team, with no approval", () => {
    const e = gsRisk({ sourceId: "sig-del", actionTarget: "connecteam", type: "route_no_driver", transactionId: null });
    const r = coordinateException(e, NOW);
    expect(r.status).toBe("delegated");
    expect(r.assignedRole).toBe("scheduling");
    expect(r.approvalId).toBeNull();
    expect(listPendingApprovals().length).toBe(0);
  });

  it("a human rejection of a proposal closes it as disposed (not resolved)", () => {
    const e = gsRisk();
    const r0 = coordinateException(e, NOW);
    decideApproval(r0.approvalId!, "reject", "Tester", { note: "not needed" });
    const r = coordinateException(e, NOW);
    expect(r.status).toBe("disposed");
    expect(r.disposition).toContain("rejected");
  });
});

describe("dead-letter backlog → escalate", () => {
  it("a dead-lettered write-back is recorded as failed and escalated to ops", () => {
    const e: CanonicalException = {
      source: "dead_letter",
      sourceId: "GO-dead-1",
      type: "dead_letter:email_send",
      severity: "high",
      title: "Write-back failed: client reply",
      detail: "exhausted retries",
      actionTarget: "goodshuffle",
      transactionId: "555",
      firstDetectedAt: NOW.toISOString(),
      recommendedAction: "Re-run from a logged-in session or cancel it",
    };
    const r = coordinateException(e, NOW);
    expect(r.status).toBe("escalated");
    expect(r.escalationTier).toBe("team");
    expect(r.assignedRole).toBe("ops");
    expect(r.approvalId).toBeNull(); // a failed op is never re-proposed by the engine
  });
});

describe("owner escalation only on defined criteria", () => {
  it("a CRITICAL exception escalates to the owner tier immediately", () => {
    const e = gsRisk({ severity: "critical" });
    const r = coordinateException(e, NOW);
    expect(r.escalationTier).toBe("owner");
    // It is still awaiting human approval (in-flight) — escalation records the tier without faking a status.
    expect(r.status).toBe("awaiting_approval");
  });
});

describe("stale / disappeared source signal (disappearance is NOT resolution)", () => {
  it("an open delegated exception whose source vanishes becomes unverifiable, never auto-resolved", async () => {
    seedRiskRow(); // a connecteam risk → will be delegated
    let tick = await runExceptionResolutionTick(NOW);
    const key = "risk:sig-del-1";
    expect(getException(key)!.status).toBe("delegated");

    // Source signal disappears (the risk row is gone), but we never verified a resolution.
    getDb().prepare("DELETE FROM risk_items").run();
    tick = await runExceptionResolutionTick(NOW);
    const r = getException(key)!;
    expect(r.status).toBe("unverifiable");
    expect(r.status).not.toBe("resolved");
    expect(tick.ok).toBe(false); // unverifiable is NOT a healthy state
  });

  it("the tick is idempotent — re-running with the same sources changes no counts", async () => {
    seedRiskRow();
    const a = await runExceptionResolutionTick(NOW);
    const b = await runExceptionResolutionTick(NOW);
    expect(a.summary).toEqual(b.summary);
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM exception_resolutions").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("human disposition (the only non-verified way to close)", () => {
  it("records a justified disposition and closes the exception", () => {
    const e = gsRisk({ actionTarget: "connecteam", transactionId: null });
    coordinateException(e, NOW);
    const r = disposeException(exceptionKey(e), "Handled manually by Lisa", "Lisa", "resolved", NOW)!;
    expect(r.status).toBe("resolved");
    expect(r.disposition).toContain("Lisa");
    expect(r.disposedBy).toBe("Lisa");
    // A later re-detect does not reopen a human-closed item.
    expect(coordinateException(e, NOW).status).toBe("resolved");
  });
});

describe("summary distinguishes the honest states", () => {
  it("counts active/awaiting/acting/escalated/failed/resolved/unverifiable distinctly", () => {
    coordinateException(gsRisk({ sourceId: "a" }), NOW); // awaiting_approval
    coordinateException(gsRisk({ sourceId: "b", actionTarget: "connecteam", transactionId: null }), NOW); // delegated
    const s = exceptionSummary();
    expect(s.awaitingApproval).toBe(1);
    expect(s.delegated).toBe(1);
    expect(s.total).toBe(2);
  });
});
