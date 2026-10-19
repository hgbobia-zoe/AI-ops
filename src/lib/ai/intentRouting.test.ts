import { describe, it, expect } from "vitest";
import { classifyIntentAgent } from "./intentRouting";
import { getEmployee } from "@/lib/aiorg/registry";
import { isForbiddenActionType } from "@/lib/aiorg/approvals";

describe("classifyIntentAgent", () => {
  it("routes a scheduling / crew / shift ask to the scheduling employee (forbidden schedule_change)", () => {
    for (const t of ["move Marcus to the saturday crew", "reschedule the friday shift", "change staffing for the weekend"]) {
      const r = classifyIntentAgent(t);
      expect(r.agentId).toBe("scheduling");
      expect(r.bot).toBe("scheduling");
      expect(r.actionType).toBe("schedule_change");
      expect(r.forbidden).toBe(true);
    }
  });

  it("routes a quote / outreach / customer-comms ask to Sales (outreach)", () => {
    for (const t of ["follow up with the Johnson lead", "send the client a quote email", "text the customer back about their proposal"]) {
      const r = classifyIntentAgent(t);
      expect(r.agentId).toBe("outreach");
      expect(r.bot).toBe("sales");
    }
  });

  it("routes an inventory ask to the inventory employee", () => {
    const r = classifyIntentAgent("we double booked the 20x30 tent inventory");
    expect(r.agentId).toBe("inventory-exception");
    expect(r.bot).toBe("inventory");
  });

  it("routes a route/dispatch ask to dispatch-route", () => {
    const r = classifyIntentAgent("the truck is behind on its delivery route, update the ETA");
    expect(r.agentId).toBe("dispatch-route");
  });

  it("keeps money/pricing propose-only and attributes it to the quote analyst", () => {
    const r = classifyIntentAgent("give them a 10% discount on the delivery fee");
    expect(r.agentId).toBe("quote-analyst");
    expect(r.actionType).toBe("change_pricing");
    expect(r.forbidden).toBe(true);
  });

  it("routes hiring to the hiring employee (forbidden)", () => {
    const r = classifyIntentAgent("we need to hire another driver");
    expect(r.agentId).toBe("hiring");
    expect(isForbiddenActionType(r.actionType)).toBe(true);
  });

  it("falls back to Viktor (ops) with a safe append_note when nothing matches", () => {
    const r = classifyIntentAgent("good morning, how are you");
    expect(r.agentId).toBe("viktor");
    expect(r.bot).toBe("ops");
    expect(r.matched).toBe(false);
    expect(r.forbidden).toBe(false);
  });

  it("every rule's agentId is a real registry employee", () => {
    for (const t of [
      "reschedule the crew",
      "send a quote",
      "inventory conflict",
      "dispatch route eta",
      "change the price",
      "hire someone",
      "post an instawork gig",
      "finance revenue report",
      "marketing campaign content",
    ]) {
      expect(getEmployee(classifyIntentAgent(t).agentId)).toBeTruthy();
    }
  });

  it("uses word boundaries so 'rate' does not fire on 'accurate'", () => {
    // "accurate" contains "rate" as a substring but must NOT trigger the pricing rule.
    const r = classifyIntentAgent("please give me an accurate headcount for the event");
    expect(r.domain).not.toBe("pricing");
  });
});
