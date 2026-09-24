// Core Communications rules — the deterministic, safety-critical bits: reason classification, the
// vendor-agnostic adapter, and (most importantly) that the voice agent can NEVER bypass a permission.

import { describe, it, expect } from "vitest";
import { classifyReason } from "./reasons";
import { adaptEvent } from "./adapter";
import { allowedActionNames } from "./toolRegistry";
import { executeTool } from "./tools";

describe("classifyReason", () => {
  it("routes a delivery question to DELIVERY_STATUS", () => {
    expect(classifyReason("When will my delivery arrive on Saturday?").reason).toBe("DELIVERY_STATUS");
  });
  it("routes a damage report to DAMAGE", () => {
    expect(classifyReason("One of the chairs arrived broken").reason).toBe("DAMAGE");
  });
  it("never fabricates a specific reason for empty/unknown text", () => {
    expect(classifyReason("").reason).toBe("OTHER");
    expect(classifyReason("").confidence).toBe(0);
    expect(classifyReason("hello there").reason).toBe("GENERAL_QUESTION");
  });
});

describe("adaptEvent", () => {
  it("maps an OpenPhone-style call.completed to canonical call.ended", () => {
    const r = adaptEvent({ type: "call.completed", id: "e1", callId: "c1", direction: "incoming", from: "+13015550001" });
    expect(r.canonicalType).toBe("call.ended");
    expect(r.recognized).toBe(true);
    expect(r.event.conversationId).toBe("c1");
    expect(r.event.direction).toBe("inbound");
  });
  it("maps an inbound message to sms.received", () => {
    const r = adaptEvent({ type: "message.received", id: "m1", direction: "incoming" });
    expect(r.canonicalType).toBe("sms.received");
    expect(r.event.channel).toBe("sms");
  });
  it("never drops an unmappable event — it logs as unknown", () => {
    const r = adaptEvent({ type: "some.future.thing", id: "x1" });
    expect(r.canonicalType).toBe("unknown");
    expect(r.recognized).toBe(false);
    expect(r.event.eventType).toBe("unknown");
  });
});

describe("permission enforcement (the agent can never self-authorize)", () => {
  it("blocks a DISABLED tool for everyone", async () => {
    const res = await executeTool("modifyOrder", { bookingId: "1" }, { caller: "human", approved: true });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
  });
  it("blocks a controlled action when the agent (sona) invokes it", async () => {
    const res = await executeTool("sendCustomerSMS", { phone: "+13015550001", body: "hi" }, { caller: "sona" });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.permission).toBe("HUMAN_APPROVAL_REQUIRED");
  });
  it("blocks a controlled action for a human who has NOT approved", async () => {
    const res = await executeTool("createCallbackRequest", { bookingId: "1" }, { caller: "human", approved: false });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
  });
  it("excludes DISABLED tools from the allowed-action list", () => {
    const names = allowedActionNames();
    expect(names).not.toContain("modifyOrder");
    expect(names).not.toContain("processPayment");
    expect(names).toContain("identifyCaller");
  });
});
