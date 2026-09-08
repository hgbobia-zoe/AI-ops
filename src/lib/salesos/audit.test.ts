import { describe, it, expect } from "vitest";
import { logSalesEventBy, leadActivity, recentSalesActivity, ACTION_LABEL, SALES_ACTIONS } from "./audit";

describe("salesos audit trail", () => {
  it("records a sales event against a lead, attributed to an actor, newest first", () => {
    logSalesEventBy("OUTREACH_DRAFTED", "L-1", "Jessie Medalla", { source: "ai" });
    logSalesEventBy("MESSAGE_SENT", "L-1", "JM", { chars: 42, edited: true });

    const act = leadActivity("L-1");
    expect(act).toHaveLength(2);
    expect(act[0]).toMatchObject({ action: "MESSAGE_SENT", actor: "JM", actionLabel: "Sent text" });
    expect(act[0].detail).toMatchObject({ chars: 42, edited: true });
    expect(act[1]).toMatchObject({ action: "OUTREACH_DRAFTED", actor: "Jessie Medalla" });
  });

  it("scopes activity per lead", () => {
    logSalesEventBy("LEAD_VIEWED", "L-A", "HG");
    logSalesEventBy("LEAD_VIEWED", "L-B", "LM");
    expect(leadActivity("L-A").every((a) => a.leadId === "L-A")).toBe(true);
    expect(leadActivity("L-A").some((a) => a.actor === "LM")).toBe(false);
  });

  it("surfaces a global recent feed across the sales-action vocabulary", () => {
    logSalesEventBy("CALL_LOGGED", "L-9", "JM", { outcome: "Got voicemail" });
    const feed = recentSalesActivity(50);
    expect(feed.some((f) => f.action === "CALL_LOGGED" && f.leadId === "L-9")).toBe(true);
  });

  it("every action in the vocabulary has a human label", () => {
    for (const a of SALES_ACTIONS) expect(ACTION_LABEL[a]).toBeTruthy();
  });
});
