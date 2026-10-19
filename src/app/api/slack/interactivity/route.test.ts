// End-to-end tests for the shared Slack interactivity endpoint: signature verification, approver gating,
// the three decisions (approve / request changes / dismiss), idempotent duplicate clicks, and a downstream
// execution failure. Uses the real in-memory DB (vitest.setup clears it per file); fetch to the Slack
// response_url is stubbed, and only enqueueGsOp is spied so we can force a downstream failure.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { getDb } from "@/lib/db";
import { enqueueGsOp, listPendingGsOps } from "@/lib/db/repo";
import { createApproval, getApproval } from "@/lib/aiorg/approvals";
import { APPROVE_ACTION, REJECT_ACTION, REQUEST_CHANGES_ACTION } from "@/lib/slack/interactivity";

// enqueueGsOp defaults to the REAL implementation (the factory wraps it in a spy); the downstream-failure
// test overrides it ONCE to throw. Everything else in the repo module stays real.
vi.mock("@/lib/db/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/db/repo")>();
  return { ...actual, enqueueGsOp: vi.fn(actual.enqueueGsOp) };
});

import { POST } from "./route";

const SECRET = "test-signing-secret";
const APPROVER = "UAPP";

function sign(ts: string, body: string): string {
  return "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
}

function payloadBody(actionId: string, value: string, user = APPROVER): string {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: user, username: user.toLowerCase() },
      channel: { id: "C1" },
      message: { ts: "1700000000.0001" },
      response_url: "https://hooks.slack.com/actions/XXX",
      actions: [{ action_id: actionId, value }],
    }),
  }).toString();
}

function makeReq(body: string, opts: { sig?: string; ts?: string } = {}): Request {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return new Request("http://localhost/api/slack/interactivity", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": opts.sig ?? sign(ts, body),
    },
    body,
  });
}

let sent: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  getDb().prepare("DELETE FROM ai_approvals").run();
  getDb().prepare("DELETE FROM gs_outbox").run();
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.SLACK_APPROVER_USER_IDS = APPROVER;
  delete process.env.EMAIL_SEND_ENABLED;
  sent = [];
  vi.mocked(enqueueGsOp).mockClear(); // clear call history; keeps the factory's real implementation
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response("ok", { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.SLACK_APPROVER_USER_IDS;
  delete process.env.EMAIL_SEND_ENABLED;
});

const mkEmail = (key = "e1") =>
  createApproval({
    agentId: "outreach",
    owner: "Jessie",
    title: "Follow-up to Test Client",
    actionType: "send_email",
    actionPayload: { transactionId: "555", body: "Hello" },
    card: { what: "w", why: "y", dataUsed: "d", expectedOutcome: "e", risk: "r", whatIfApproved: "i" },
    idempotencyKey: key,
  });

describe("POST /api/slack/interactivity", () => {
  it("rejects an invalid signature with 401 and changes nothing", async () => {
    const a = mkEmail();
    const body = payloadBody(APPROVE_ACTION, a.id);
    const res = await POST(makeReq(body, { sig: "v0=deadbeef" }));
    expect(res.status).toBe(401);
    expect(getApproval(a.id)!.status).toBe("pending");
  });

  it("ignores an unauthorized actor (not on the allowlist) without deciding", async () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    const a = mkEmail();
    const body = payloadBody(APPROVE_ACTION, a.id, "USTRANGER");
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    // The decision stayed in the app — nothing executed, status unchanged.
    expect(getApproval(a.id)!.status).toBe("pending");
    expect(listPendingGsOps(50).length).toBe(0);
    // The clicker got an ephemeral "not set up to approve" notice.
    expect(sent[0]?.body.response_type).toBe("ephemeral");
  });

  it("approves and queues the outbox op, then shows 'queued to send' (not 'delivered')", async () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    const a = mkEmail();
    const res = await POST(makeReq(payloadBody(APPROVE_ACTION, a.id)));
    expect(res.status).toBe(200);
    expect(getApproval(a.id)!.status).toBe("queued");
    expect(listPendingGsOps(50).filter((o) => o.op === "email_send").length).toBe(1);
    const card = sent[0].body;
    expect(card.replace_original).toBe(true);
    expect(String(card.text)).toContain("queued");
    expect(String(card.text).toLowerCase()).not.toContain("delivered");
  });

  it("dismisses on reject and records nothing sent", async () => {
    const a = mkEmail();
    const res = await POST(makeReq(payloadBody(REJECT_ACTION, a.id)));
    expect(res.status).toBe(200);
    expect(getApproval(a.id)!.status).toBe("rejected");
    expect(String(sent[0].body.text)).toContain("Dismissed");
  });

  it("request-changes sends the item back for in-app correction WITHOUT mutating source data", async () => {
    const a = mkEmail();
    const res = await POST(makeReq(payloadBody(REQUEST_CHANGES_ACTION, a.id)));
    expect(res.status).toBe(200);
    const after = getApproval(a.id)!;
    expect(after.status).toBe("info_requested");
    expect(after.decisionNote).toContain("Open the app");
    // The stored payload is untouched — the click is not treated as the edit.
    expect(after.actionPayload.body).toBe("Hello");
    expect(listPendingGsOps(50).length).toBe(0);
    expect(String(sent[0].body.text).toLowerCase()).toContain("changes requested");
  });

  it("is idempotent on a duplicate approve click — one op, true outcome shown", async () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    const a = mkEmail();
    await POST(makeReq(payloadBody(APPROVE_ACTION, a.id)));
    await POST(makeReq(payloadBody(APPROVE_ACTION, a.id)));
    // Still exactly one enqueued op; status is the honest post-approve "queued" (WS03).
    expect(listPendingGsOps(50).filter((o) => o.op === "email_send").length).toBe(1);
    expect(getApproval(a.id)!.status).toBe("queued");
    // The second render shows the real (queued) state, not a fresh "approved".
    expect(String(sent[1].body.text)).toContain("queued");
  });

  it("a losing reject click after an approve still shows the TRUE outcome (approved), not a false dismiss", async () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    const a = mkEmail();
    await POST(makeReq(payloadBody(APPROVE_ACTION, a.id)));
    await POST(makeReq(payloadBody(REJECT_ACTION, a.id)));
    expect(getApproval(a.id)!.status).toBe("queued");
    // The reject render must NOT claim the item was dismissed.
    expect(String(sent[1].body.text)).not.toContain("Dismissed");
    expect(String(sent[1].body.text)).toContain("queued");
  });

  it("on a downstream enqueue failure, the card shows failure and the approval is marked failed", async () => {
    process.env.EMAIL_SEND_ENABLED = "true";
    const a = mkEmail();
    vi.mocked(enqueueGsOp).mockImplementationOnce(() => {
      throw new Error("outbox unavailable");
    });
    const res = await POST(makeReq(payloadBody(APPROVE_ACTION, a.id)));
    expect(res.status).toBe(200);
    expect(getApproval(a.id)!.status).toBe("failed");
    expect(listPendingGsOps(50).length).toBe(0);
    expect(String(sent[0].body.text).toLowerCase()).toContain("failed");
  });

  it("tells the clicker when the approval no longer exists", async () => {
    const res = await POST(makeReq(payloadBody(APPROVE_ACTION, "AP-missing")));
    expect(res.status).toBe(200);
    expect(String(sent[0].body.text)).toContain("no longer exists");
  });
});
