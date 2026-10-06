import { describe, expect, it } from "vitest";
import { createSession, getSession, endSession, listSessionApprovalIds } from "./sessions";
import { proposeFromSession } from "./propose";
import { getBladeAiConfig, setBladeAiConfig, allBladeAiConfig, isValidBlade, AI_BLADES } from "./bladeConfig";
import type { NewApproval } from "@/lib/aiorg/approvals";

function sampleApproval(key: string): NewApproval {
  return {
    agentId: "outreach",
    owner: "Jessie",
    title: "Follow-up SMS",
    actionType: "send_sms",
    actionPayload: { transactionId: "123", body: "Hi, following up." },
    card: { what: "Send a follow-up", why: "Quote opened", dataUsed: "lead 123", expectedOutcome: "reply", risk: "low", whatIfApproved: "SMS queued" },
    idempotencyKey: key,
  };
}

describe("proposeFromSession — the session→approval bridge", () => {
  it("creates an approval, links it, and flips the session to awaiting_approval", () => {
    const s = createSession({ agentId: "outreach", blade: "salesos", title: "Propose" });
    const a = proposeFromSession(s.id, sampleApproval("prop-1"), "Hermann");
    expect(a).not.toBeNull();
    expect(a!.id).toMatch(/^AP-/);
    expect(listSessionApprovalIds(s.id)).toEqual([a!.id]);
    expect(getSession(s.id)?.status).toBe("awaiting_approval");
  });

  it("is idempotent on the approval idempotency key", () => {
    const s = createSession({ agentId: "outreach", title: "Propose twice" });
    const a = proposeFromSession(s.id, sampleApproval("prop-2"), "Hermann");
    const again = proposeFromSession(s.id, sampleApproval("prop-2"), "Hermann");
    expect(again!.id).toBe(a!.id);
    expect(listSessionApprovalIds(s.id)).toEqual([a!.id]); // linked once, not twice
  });

  it("refuses to propose from a closed session", () => {
    const s = createSession({ agentId: "outreach", title: "Closed" });
    endSession(s.id, "done", {});
    const a = proposeFromSession(s.id, sampleApproval("prop-3"), "Hermann");
    expect(a).toBeNull();
    expect(listSessionApprovalIds(s.id)).toEqual([]);
  });

  it("returns null for an unknown session", () => {
    expect(proposeFromSession("AS-nope", sampleApproval("prop-4"))).toBeNull();
  });
});

describe("blade AI config", () => {
  it("defaults: enabled, never auto-propose", () => {
    const c = getBladeAiConfig("dispatch");
    expect(c.enabled).toBe(true);
    expect(c.autoPropose).toBe(false);
  });

  it("merges a patch and stamps updatedAt", () => {
    const next = setBladeAiConfig("marketing", { autoPropose: true });
    expect(next.autoPropose).toBe(true);
    expect(next.enabled).toBe(true); // preserved
    expect(next.updatedAt).toBeTruthy();
    expect(getBladeAiConfig("marketing").autoPropose).toBe(true);
  });

  it("covers every BladeKey and validates blade ids", () => {
    const all = allBladeAiConfig();
    expect(Object.keys(all).sort()).toEqual([...AI_BLADES].sort());
    expect(isValidBlade("salesos")).toBe(true);
    expect(isValidBlade("nope")).toBe(false);
  });
});
