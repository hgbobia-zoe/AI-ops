// The PROPOSE endpoint's intent→employee routing: the proposal no longer hardcodes agentId:"viktor". An
// explicit agentId wins (and an unknown one is rejected); when omitted, the route classifies the owning
// employee deterministically from the session's latest instruction. Uses the real in-memory DB; only the
// bridge-token check is stubbed so a token-authed (cookie-less) responder is admitted.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSession, addInstruction, listSessionApprovalIds } from "@/lib/ai/sessions";
import { getApproval } from "@/lib/aiorg/approvals";

vi.mock("@/lib/ai/provider", () => ({ bridgeTokenValid: () => true }));

import { POST } from "./route";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/ai/propose", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": "t" },
    body: JSON.stringify(body),
  });
}

const card = { what: "x", why: "y", dataUsed: "z", expectedOutcome: "o", risk: "low", whatIfApproved: "q" };

function sessionWith(instruction: string) {
  const s = createSession({ agentId: "viktor", title: "Slack", input: { source: "slack" } });
  addInstruction(s.id, instruction, "U1");
  return s;
}

function approvalFor(sessionId: string) {
  const ids = listSessionApprovalIds(sessionId);
  return ids.length ? getApproval(ids[0]) : null;
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/ai/propose — intent→employee routing", () => {
  it("classifies the owning employee from the instruction when agentId is omitted", async () => {
    const s = sessionWith("move Marcus to the saturday crew shift");
    const res = await POST(makeReq({ sessionId: s.id, title: "Shift change", actionType: "schedule_change", card, idempotencyKey: "op:1" }));
    expect(res.status).toBe(200);
    expect(approvalFor(s.id)?.agentId).toBe("scheduling"); // NOT hardcoded "viktor"
  });

  it("honors an explicit (real) agentId from the responder", async () => {
    const s = sessionWith("send the client a follow up");
    const res = await POST(makeReq({ sessionId: s.id, agentId: "outreach", title: "Follow up", actionType: "send_email", card, idempotencyKey: "op:2" }));
    expect(res.status).toBe(200);
    expect(approvalFor(s.id)?.agentId).toBe("outreach");
  });

  it("rejects an unknown agentId rather than silently keeping it", async () => {
    const s = sessionWith("do a thing");
    const res = await POST(makeReq({ sessionId: s.id, agentId: "not-a-real-agent", title: "X", actionType: "append_note", card, idempotencyKey: "op:3" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_agentId" });
  });

  it("keeps a forbidden category propose-only (accepted, attributed to the owner) ", async () => {
    const s = sessionWith("give them a discount on the delivery fee");
    const res = await POST(makeReq({ sessionId: s.id, title: "Discount", actionType: "change_pricing", card, idempotencyKey: "op:4" }));
    expect(res.status).toBe(200);
    const a = approvalFor(s.id);
    expect(a?.agentId).toBe("quote-analyst");
    expect(a?.actionType).toBe("change_pricing"); // recorded as a proposal; execution stays forbidden elsewhere
  });
});
