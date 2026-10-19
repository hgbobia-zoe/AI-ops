import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture what the drafter sends to the model, and feed back a canned JSON — no real LLM calls.
const captured: { system: string; user: string }[] = [];
let cannedText = '{"sms":"Hi Melissa, this is Hermann from Zoe Events. No rush at all, just checking in to see if you and your husband have had a chance to talk things through. Happy to help whenever you are ready.","callStrategy":"Gentle check-in.","cadence":"In a day or two.","caution":""}';

vi.mock("@/lib/llm", () => ({
  llmConfigured: () => true,
  llmModel: () => "test-model",
  chat: async (messages: { role: string; content: string }[]) => {
    captured.push({
      system: messages.find((m) => m.role === "system")?.content ?? "",
      user: messages.find((m) => m.role === "user")?.content ?? "",
    });
    return { ok: true, text: cannedText, model: "test-model" } as const;
  },
}));

// Stub the lead + timeline reads so the test is pure (no DB). getLead/buildLeadTimeline are deterministic
// here; the drafter under test is the thing we exercise.
import type { TimelineEntry } from "./timeline";
let leadFixture: Record<string, unknown> | null = null;
let timelineFixture: TimelineEntry[] = [];

vi.mock("./service", () => ({
  getLead: () => leadFixture,
}));
vi.mock("./timeline", () => ({
  buildLeadTimeline: () => timelineFixture,
}));

import { draftLeadOutreach } from "./outreachService";

function nelsonLead(): Record<string, unknown> {
  return {
    id: "GS-NELSON",
    clientName: "Melissa Nelson",
    clientPhone: "3015550000",
    clientEmail: "melissa@example.com",
    eventName: "Nelson — 9715 The Corral Dr",
    eventDate: "2026-12-05",
    stage: "follow_up",
    internalNotes: "10/16 - husband is travelling, will go through details together and get back in a day or so",
    clientNotes: null,
    signals: { daysToEvent: 47 },
  };
}

const NELSON_TIMELINE: TimelineEntry[] = [
  { at: "2026-10-17T15:00:00Z", channel: "call", direction: "out", actor: null, title: "Call to client", detail: "Jessie Medalla from Zoe spoke with Melissa. Melissa will talk to her husband tomorrow to come up with a plan.", source: "call_events" },
  { at: "2026-10-16T18:30:00Z", channel: "sms", direction: "in", actor: null, title: "Text from client", detail: "I need to go through the details with my husband, he is travelling, I will get back to you in a day or so.", source: "comms_events" },
  { at: "2026-10-14T12:00:00Z", channel: "quote", direction: "out", actor: null, title: "Quote emailed", source: "bookings" },
];

beforeEach(() => {
  captured.length = 0;
  delete process.env.OUTREACH_LLM;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("draftLeadOutreach — context-aware drafting", () => {
  it("assembles the full conversation (incl. the latest inbound) and passes it to the model", async () => {
    leadFixture = nelsonLead();
    timelineFixture = NELSON_TIMELINE;

    await draftLeadOutreach("GS-NELSON", "Hermann");
    expect(captured).toHaveLength(1);
    const payload = JSON.parse(captured[0].user) as { conversation: string; latestCustomerMessage: string; commsHistory: string };

    // The customer's "talk to my husband" message reaches the model, verbatim, as the latest statement.
    expect(payload.latestCustomerMessage).toMatch(/husband/i);
    expect(payload.latestCustomerMessage).toMatch(/travelling/i);
    // The two-way thread carries the inbound text AND the Oct 17 call summary.
    expect(payload.conversation).toMatch(/Customer text: I need to go through the details with my husband/);
    expect(payload.conversation).toMatch(/Zoe call: .*talk to her husband/);
    // The internal note is still passed as history.
    expect(payload.commsHistory).toMatch(/husband is travelling/);
  });

  it("the prompt forbids inventing a comparison frame and respects explicit blockers", async () => {
    leadFixture = nelsonLead();
    timelineFixture = NELSON_TIMELINE;

    await draftLeadOutreach("GS-NELSON", "Hermann");
    const sys = captured[0].system;
    // No invented "apples to apples" / comparison frame unless the customer said so.
    expect(sys).toMatch(/apples to apples/i);
    expect(sys).toMatch(/do NOT invent a situation/i);
    expect(sys).toMatch(/spouse, partner, or family/i);
    // Regression guard: the no-sign-off instruction (Goodshuffle appends the signature) is still there.
    expect(sys).toMatch(/Do NOT add a closing sign-off/i);
    // The canned acknowledgement flows through to the draft.
    const r = await draftLeadOutreach("GS-NELSON", "Hermann");
    expect(r?.draft.sms).toMatch(/husband/i);
    expect(r?.draft.source).toBe("ai");
  });

  it("a genuinely comparing customer's own words are carried through (comparison is real, not invented)", async () => {
    leadFixture = nelsonLead();
    timelineFixture = [
      { at: "2026-10-16T10:00:00Z", channel: "sms", direction: "in", actor: null, title: "Text from client", detail: "Still comparing a few rental companies, can you beat the other quote?", source: "comms_events" },
    ];
    await draftLeadOutreach("GS-NELSON", "Hermann");
    const payload = JSON.parse(captured[0].user) as { latestCustomerMessage: string; conversation: string };
    expect(payload.latestCustomerMessage).toMatch(/comparing a few rental companies/i);
    expect(payload.conversation).toMatch(/Customer text: Still comparing/);
  });

  it("with no conversation and no notes, passes honest 'none' markers (neutral follow-up, no fabrication)", async () => {
    leadFixture = { ...nelsonLead(), internalNotes: null, clientNotes: null };
    timelineFixture = [];
    await draftLeadOutreach("GS-NELSON", "Hermann");
    const payload = JSON.parse(captured[0].user) as { conversation: string; latestCustomerMessage: string; commsHistory: string };
    expect(payload.conversation).toBe("(no two-way conversation captured)");
    expect(payload.latestCustomerMessage).toBe("");
    expect(payload.commsHistory).toBe("(no prior contact logged)");
  });
});
