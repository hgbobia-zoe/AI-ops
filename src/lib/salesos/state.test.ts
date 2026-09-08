import { describe, it, expect } from "vitest";
import { deterministicState, foldReply, type StateFacts, type ResolvedState } from "./state";
import { nextBestAction } from "./nba";

const facts = (o: Partial<StateFacts>): StateFacts => ({ signed: false, statusLabel: "Quote Sent", everSent: true, daysSinceLastActivity: 2, ...o });

describe("state — deterministicState (FACT-only)", () => {
  it("signed ⇒ WON, lost status ⇒ LOST (facts beat everything)", () => {
    expect(deterministicState(facts({ signed: true, statusLabel: "Contract Signed" })).state).toBe("WON");
    expect(deterministicState(facts({ signed: true, statusLabel: "Lost" })).state).toBe("LOST"); // lost status wins
    expect(deterministicState(facts({ statusLabel: "Cancelled" })).state).toBe("LOST");
  });
  it("no quote sent ⇒ NEW; long silence ⇒ DORMANT; else QUOTED", () => {
    expect(deterministicState(facts({ everSent: false, statusLabel: "New Project" })).state).toBe("NEW");
    expect(deterministicState(facts({ daysSinceLastActivity: 40 })).state).toBe("DORMANT");
    expect(deterministicState(facts({ daysSinceLastActivity: 3 })).state).toBe("QUOTED");
  });
  it("carries evidence + a FACT/INFERENCE-labelled reason", () => {
    const s = deterministicState(facts({ signed: true, statusLabel: "Contract Signed" }));
    expect(s.reason).toMatch(/FACT/);
    expect(s.evidence).toBeTruthy();
    expect(s.confidence).toBe(1);
  });
});

describe("state — foldReply", () => {
  const base: ResolvedState = { state: "QUOTED", confidence: 0.7, evidence: "quote sent", source: "goodshuffle", reason: "FACT" };
  it("a confident reply classification refines the state (INFERENCE)", () => {
    const r = foldReply(base, { state: "COMPETITOR_COMPARISON", confidence: 0.8, evidenceQuote: "still comparing a few vendors" });
    expect(r.state).toBe("COMPETITOR_COMPARISON");
    expect(r.source).toBe("inbound_reply");
    expect(r.reason).toMatch(/INFERENCE/);
    expect(r.evidence).toMatch(/comparing/);
  });
  it("ignores a low-confidence reply and never overrides a WON/LOST fact", () => {
    expect(foldReply(base, { state: "READY_TO_BOOK", confidence: 0.2, evidenceQuote: "hm" }).state).toBe("QUOTED");
    const won: ResolvedState = { ...base, state: "WON", confidence: 1 };
    expect(foldReply(won, { state: "PRICE_OBJECTION", confidence: 0.95, evidenceQuote: "too pricey" }).state).toBe("WON");
  });
});

describe("nba — next best action v2", () => {
  it("a price objection is handled, never discounted", () => {
    const n = nextBestAction({ state: "PRICE_OBJECTION", value: 3000, daysToEvent: 40, repliedMinutesAgo: 20 });
    expect(n.action).toBe("HANDLE_OBJECTION");
    expect(n.doNot).toMatch(/discount/i);
    expect(n.objective).toBeTruthy();
  });
  it("evaluating / comparing ⇒ CALL_NOW to understand criteria", () => {
    expect(nextBestAction({ state: "EVALUATING", value: 5000, daysToEvent: 30, repliedMinutesAgo: 10 }).action).toBe("CALL_NOW");
    expect(nextBestAction({ state: "COMPETITOR_COMPARISON", value: 5000, daysToEvent: 30, repliedMinutesAgo: 10 }).action).toBe("CALL_NOW");
  });
  it("a big deal that just replied outranks a small untouched one", () => {
    const hot = nextBestAction({ state: "EVALUATING", value: 12000, daysToEvent: 20, repliedMinutesAgo: 15 });
    const cold = nextBestAction({ state: "QUOTED", value: 800, daysToEvent: 200, repliedMinutesAgo: null });
    expect(hot.priority).toBeGreaterThan(cold.priority);
    expect(hot.factors.some((f) => f.label === "Just replied")).toBe(true);
  });
  it("won ⇒ no action", () => {
    expect(nextBestAction({ state: "WON", value: 5000, daysToEvent: 5, repliedMinutesAgo: null }).action).toBe("NO_ACTION");
  });
});
