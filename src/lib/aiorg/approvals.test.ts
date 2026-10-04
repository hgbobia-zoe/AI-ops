import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { saveBookings, listPendingGsOps } from "@/lib/db/repo";
import {
  canDecide,
  applyDecision,
  executionPlan,
  isForbiddenActionType,
  buildOutboxPayload,
  plainToHtml,
  createApproval,
  getApproval,
  listPendingApprovals,
  countPendingByAgent,
  decideApproval,
  type ApprovalStatus,
} from "./approvals";
import { proposeOutreachApprovals, proposeLostQuoteApprovals } from "./proposers";

beforeEach(() => {
  getDb().prepare("DELETE FROM ai_approvals").run();
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM bookings").run();
  delete process.env.EMAIL_SEND_ENABLED;
  delete process.env.SMS_SEND_ENABLED;
});
afterEach(() => {
  delete process.env.EMAIL_SEND_ENABLED;
  delete process.env.SMS_SEND_ENABLED;
});

// ── Pure state machine ──────────────────────────────────────────────────────────
describe("approval state machine", () => {
  it("only pending / info_requested / edited are decidable", () => {
    expect(canDecide("pending")).toBe(true);
    expect(canDecide("info_requested")).toBe(true);
    expect(canDecide("edited")).toBe(true);
    for (const s of ["approved", "rejected", "executed", "failed"] as ApprovalStatus[]) {
      expect(canDecide(s)).toBe(false);
    }
  });

  it("maps a decision to the next status, or null when not decidable", () => {
    expect(applyDecision("pending", "approve")).toBe("approved");
    expect(applyDecision("pending", "reject")).toBe("rejected");
    expect(applyDecision("pending", "edit")).toBe("edited");
    expect(applyDecision("pending", "request_info")).toBe("info_requested");
    expect(applyDecision("executed", "approve")).toBeNull();
    expect(applyDecision("rejected", "reject")).toBeNull();
  });
});

// ── Pure execution plan ──────────────────────────────────────────────────────────
describe("executionPlan", () => {
  it("routes the executable action types to the proven outbox ops + gates", () => {
    expect(executionPlan("send_email")).toEqual({ kind: "outbox", op: "email_send", gate: "EMAIL_SEND_ENABLED" });
    expect(executionPlan("append_note")).toEqual({ kind: "outbox", op: "note_append", gate: null });
    expect(executionPlan("create_gs_task")).toEqual({ kind: "outbox", op: "create_gs_task", gate: null });
  });

  it("holds SMS (no async path) and forbids money/pricing/schedule/hiring/instawork", () => {
    expect(executionPlan("send_sms").kind).toBe("held");
    for (const t of ["modify_quote", "change_pricing", "schedule_change", "hiring", "firing", "instawork_gig"] as const) {
      expect(executionPlan(t).kind).toBe("forbidden");
      expect(isForbiddenActionType(t)).toBe(true);
    }
    expect(isForbiddenActionType("send_email")).toBe(false);
  });
});

// ── Pure outbox payload builder ──────────────────────────────────────────────────
describe("buildOutboxPayload", () => {
  it("converts an email body to Goodshuffle per-line HTML", () => {
    const { transactionId, opPayload } = buildOutboxPayload("email_send", { transactionId: "123", body: "Hi there\nThanks", subject: "Re: hi" });
    expect(transactionId).toBe("123");
    expect(opPayload.subject).toBe("Re: hi");
    expect(opPayload.content).toBe("<div>Hi there</div><div>Thanks</div>");
  });
  it("passes through existing HTML and builds note / task shapes", () => {
    expect(plainToHtml("<div>x</div>")).toBe("<div>x</div>");
    expect(buildOutboxPayload("note_append", { transactionId: "9", body: "logged line" }).opPayload).toEqual({ line: "logged line" });
    expect(buildOutboxPayload("create_gs_task", { transactionId: "9", title: "T", note: "N" }).opPayload).toEqual({ transactionID: "9", title: "T", note: "N" });
  });
});

// ── Store + idempotency ──────────────────────────────────────────────────────────
describe("createApproval idempotency", () => {
  it("never duplicates on the same idempotency key", () => {
    const base = { agentId: "outreach", owner: "Jessie", title: "t", actionType: "send_email" as const, actionPayload: { transactionId: "1", body: "hi" }, card: { what: "w", why: "y", dataUsed: "d", expectedOutcome: "e", risk: "r", whatIfApproved: "i" }, idempotencyKey: "k1" };
    const a = createApproval(base);
    const b = createApproval(base);
    expect(a.id).toBe(b.id);
    expect(listPendingApprovals().length).toBe(1);
  });
});

// ── Approve -> outbox routing (gate-on, gate-off, forbidden, idempotent) ──────────
const mkEmail = (key = "e1") =>
  createApproval({ agentId: "outreach", owner: "Jessie", title: "Email", actionType: "send_email", actionPayload: { transactionId: "555", body: "Hello" }, card: { what: "w", why: "y", dataUsed: "d", expectedOutcome: "e", risk: "r", whatIfApproved: "i" }, idempotencyKey: key });

describe("decideApproval execution routing", () => {
  it("holds the send when EMAIL_SEND_ENABLED is off (records decision, enqueues nothing)", () => {
    const a = mkEmail();
    const r = decideApproval(a.id, "approve", "Tester");
    expect(r.outcome).toBe("held_gate_off");
    expect(getApproval(a.id)!.status).toBe("approved");
    expect(getApproval(a.id)!.outboxOpId).toBeNull();
    expect(listPendingGsOps(50).length).toBe(0);
  });

  it("enqueues the email_send outbox op when the gate is on, and never double-executes", () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    const a = mkEmail();
    const r = decideApproval(a.id, "approve", "Tester");
    expect(r.outcome).toBe("executed_queued");
    const out = getApproval(a.id)!;
    expect(out.status).toBe("executed");
    expect(out.outboxOpId).toBeTruthy();
    const ops = listPendingGsOps(50).filter((o) => o.op === "email_send");
    expect(ops.length).toBe(1);
    expect(ops[0].transactionId).toBe("555");
    // Idempotent: approving again does not enqueue a second op.
    const again = decideApproval(a.id, "approve", "Tester");
    expect(again.outcome).toBe("already_decided");
    expect(listPendingGsOps(50).filter((o) => o.op === "email_send").length).toBe(1);
  });

  it("records intent only for a forbidden action (never executes)", () => {
    const a = createApproval({ agentId: "quote-analyst", owner: "Jessie", title: "Reprice", actionType: "change_pricing", actionPayload: { transactionId: "9" }, card: { what: "w", why: "y", dataUsed: "d", expectedOutcome: "e", risk: "r", whatIfApproved: "i" }, idempotencyKey: "f1" });
    const r = decideApproval(a.id, "approve", "Tester");
    expect(r.outcome).toBe("forbidden");
    expect(getApproval(a.id)!.status).toBe("approved");
    expect(getApproval(a.id)!.outboxOpId).toBeNull();
    expect(listPendingGsOps(50).length).toBe(0);
  });

  it("holds an approved SMS (no async outbox op)", () => {
    process.env.SMS_SEND_ENABLED = "true";
    const a = createApproval({ agentId: "outreach", owner: "Jessie", title: "Text", actionType: "send_sms", actionPayload: { transactionId: "7", body: "hi" }, card: { what: "w", why: "y", dataUsed: "d", expectedOutcome: "e", risk: "r", whatIfApproved: "i" }, idempotencyKey: "s1" });
    const r = decideApproval(a.id, "approve", "Tester");
    expect(r.outcome).toBe("held_no_path");
    expect(getApproval(a.id)!.status).toBe("approved");
    expect(listPendingGsOps(50).length).toBe(0);
  });

  it("records reject / edit / request_info without executing", () => {
    const a = mkEmail();
    expect(decideApproval(a.id, "reject", "Tester", { note: "not now" }).outcome).toBe("rejected");
    expect(getApproval(a.id)!.status).toBe("rejected");
    // A rejected request is no longer decidable (idempotent no-op).
    expect(decideApproval(a.id, "approve", "Tester").outcome).toBe("already_decided");

    const b = mkEmail("e2");
    expect(decideApproval(b.id, "edit", "Tester", { editedPayload: { transactionId: "555", body: "edited body" } }).outcome).toBe("edited");
    expect(getApproval(b.id)!.actionPayload.body).toBe("edited body");
    expect(getApproval(b.id)!.status).toBe("edited");

    const c = mkEmail("e3");
    expect(decideApproval(c.id, "request_info", "Tester", { note: "which event?" }).outcome).toBe("info_requested");
    expect(getApproval(c.id)!.decisionNote).toBe("which event?");
  });
});

// ── Proposers build the six-field card from real facts ───────────────────────────
describe("proposers (deterministic six-field cards)", () => {
  it("Outreach proposes a send_email with all six card fields filled, idempotently", async () => {
    saveBookings([
      { bookingId: "L1", eventName: "Smith Wedding", eventDate: "2099-06-01", statusLabel: "New Project", signed: false, grandTotal: 12000, clientName: "Pat Smith", clientEmail: "pat@example.com", clientPhone: "" },
    ]);
    const r = await proposeOutreachApprovals();
    expect(r.created).toBe(1);
    const pending = listPendingApprovals();
    expect(pending.length).toBe(1);
    const a = pending[0];
    expect(a.agentId).toBe("outreach");
    expect(a.actionType).toBe("send_email");
    for (const v of Object.values(a.card)) expect(v.length).toBeGreaterThan(0);
    expect(a.card.dataUsed).toContain("L1");
    expect(a.actionPayload.body).toBeTruthy();
    // Re-running is idempotent for the same day.
    const r2 = await proposeOutreachApprovals();
    expect(r2.created).toBe(0);
    expect(listPendingApprovals().length).toBe(1);
    // Command-center per-agent count reflects the real pending request.
    expect(countPendingByAgent().outreach).toBe(1);
  });

  it("Lost Quote proposes a $-bearing win-back on a worthwhile lost deal", async () => {
    saveBookings([
      { bookingId: "LQ1", eventName: "Jones Gala", eventDate: "2024-01-01", statusLabel: "Lost", signed: false, grandTotal: 8000, clientName: "Jo Jones", clientEmail: "jo@example.com", clientPhone: "" },
    ]);
    const r = await proposeLostQuoteApprovals();
    expect(r.created).toBe(1);
    const a = listPendingApprovals().find((x) => x.agentId === "lost-quote")!;
    expect(a.financial).toBe(true);
    expect(a.actionType).toBe("send_email");
    expect(a.card.why.toLowerCase()).toContain("lost");
  });
});
