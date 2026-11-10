import { describe, it, expect } from "vitest";
import { buildCallProposals, parseEmailDraft, smsFromEmail, mentionsQuote, digits10, askerLabel, callLabel } from "./actOnCall";
import type { CallEventView, BookingView } from "@/lib/db/repo";
import type { CallRecap } from "@/lib/coach/recap";

function call(over: Partial<CallEventView> = {}): CallEventView {
  return {
    id: "CALL-1",
    providerId: "op-1",
    eventType: "call.completed",
    direction: "inbound",
    fromPhone: "+1 (301) 555-0199",
    toPhone: "+1 (301) 291-5296",
    contactName: "Dana Smith",
    durationSec: 420,
    transcript: "…full transcript…",
    summary: "Quo summary",
    sentiment: null,
    score: null,
    method: null,
    reasons: [],
    llmModel: null,
    alertedAt: null,
    noteLoggedAt: null,
    coachingAttemptedAt: null,
    occurredAt: "2026-10-19T14:00:00.000Z",
    ts: "2026-10-19T14:00:00.000Z",
    ...over,
  };
}

function recap(over: Partial<CallRecap> = {}): CallRecap {
  return {
    executive: "Dana wants 3 generators for a Sept 14 wedding and asked about delivery timing.",
    keyPoints: ["3 generators", "Sept 14 wedding", "asked about delivery window"],
    actionItems: ["Send delivery window options", "Confirm generator availability"],
    customerConcerns: [],
    objections: [],
    followUpEmail: "Subject: Your generators for Sept 14\n\nHi Dana,\n\nGreat talking just now. I will send the delivery window options today and confirm the generators.\n\nBest,\nZoe",
    coachingNotes: [],
    nextStep: "Send the delivery options and confirm availability.",
    model: "test-model",
    generatedAt: "2026-10-19T14:05:00.000Z",
    ...over,
  };
}

function booking(over: Partial<BookingView> = {}): BookingView {
  return {
    bookingId: "TX-555",
    eventName: "Smith Wedding",
    eventDate: "2026-09-14",
    statusLabel: "Quote",
    signed: false,
    grandTotal: 500000,
    contractTotal: 500000,
    amountPaid: 0,
    amountDue: 500000,
    clientName: "Dana Smith",
    clientEmail: "dana@example.com",
    clientPhone: "+1 (301) 555-0199",
    quoteSentDate: null,
    quoteSentAt: null,
    quoteOpenedAt: null,
    dateCreated: null,
    lossReason: null,
    venue: null,
    location: null,
    internalNotes: null,
    clientNotes: null,
    lastSentDate: null,
    lineItems: null,
    archived: false,
    ...over,
  } as BookingView;
}

describe("parseEmailDraft", () => {
  it("splits the Subject line from the body", () => {
    const r = parseEmailDraft("Subject: Hello there\n\nBody line one.\nBody line two.");
    expect(r.subject).toBe("Hello there");
    expect(r.body).toContain("Body line one.");
    expect(r.body).not.toMatch(/^subject:/i);
  });
  it("falls back to a default subject when none is present", () => {
    const r = parseEmailDraft("Just a body, no subject.");
    expect(r.subject).toBe("Following up on our call");
    expect(r.body).toBe("Just a body, no subject.");
  });
});

describe("smsFromEmail", () => {
  it("distills a short, dashless text from the email body", () => {
    const sms = smsFromEmail("Subject: X\n\nHi Dana,\n\nI will send the delivery options today and confirm the generators.");
    expect(sms.length).toBeGreaterThan(0);
    expect(sms).not.toMatch(/subject:/i);
    expect(sms).not.toMatch(/ - /); // house rule: no dashes in comms
    expect(sms.length).toBeLessThanOrEqual(321);
  });
});

describe("mentionsQuote", () => {
  it("is true when pricing/quote came up", () => {
    expect(mentionsQuote(recap({ nextStep: "Send a revised quote with the discount." }))).toBe(true);
    expect(mentionsQuote(recap({ customerConcerns: ["The price felt high"] }))).toBe(true);
  });
  it("is false for a purely logistical call", () => {
    expect(mentionsQuote(recap({ executive: "Confirmed the delivery address and gate code.", nextStep: "Confirm the gate code.", keyPoints: ["gate code"], customerConcerns: [] }))).toBe(false);
  });
});

describe("digits10", () => {
  it("returns the last 10 digits, or null when too short", () => {
    expect(digits10("+1 (301) 555-0199")).toBe("3015550199");
    expect(digits10("555-0199")).toBeNull();
    expect(digits10(null)).toBeNull();
  });
});

describe("buildCallProposals (linked to a Goodshuffle project)", () => {
  const props = buildCallProposals(call(), recap({ customerConcerns: ["worried about the price"] }), booking());
  const byType = (t: string) => props.filter((p) => p.actionType === t && !p.skipReason);

  it("proposes an executable follow-up email into the project thread", () => {
    const email = byType("send_email")[0];
    expect(email).toBeTruthy();
    expect(email.payload.transactionId).toBe("TX-555");
    expect(email.payload.subject).toBe("Your generators for Sept 14");
    expect(String(email.payload.body)).not.toMatch(/^subject:/i);
  });

  it("proposes a note and tasks (capped) on the project", () => {
    expect(byType("append_note").length).toBe(1);
    expect(byType("append_note")[0].payload.transactionId).toBe("TX-555");
    const tasks = byType("create_gs_task");
    expect(tasks.length).toBe(2); // two action items in the recap
    expect(tasks.every((t) => t.payload.transactionId === "TX-555")).toBe(true);
    expect(tasks[0].idempotencyKey).not.toBe(tasks[1].idempotencyKey); // unique per task
  });

  it("proposes a held SMS draft because a phone is known", () => {
    const sms = byType("send_sms")[0];
    expect(sms).toBeTruthy();
    expect(sms.payload.phone).toBeTruthy();
  });

  it("proposes a quote-prep card marked financial (never auto-executes)", () => {
    const quote = byType("modify_quote")[0];
    expect(quote).toBeTruthy();
    expect(quote.financial).toBe(true);
    expect(quote.payload.transactionId).toBe("TX-555");
  });

  it("keeps idempotency keys scoped to the call + action", () => {
    expect(byType("send_email")[0].idempotencyKey).toBe("act-on-call:CALL-1:send_email");
    expect(byType("append_note")[0].idempotencyKey).toBe("act-on-call:CALL-1:append_note");
  });
});

describe("buildCallProposals (NOT linked to a project)", () => {
  // No booking (phone matched nothing) → actions needing a Goodshuffle target are reported as skipped.
  const props = buildCallProposals(call(), recap(), null);

  it("skips email + note with a clear reason instead of creating untargeted actions", () => {
    const email = props.find((p) => p.actionType === "send_email");
    const note = props.find((p) => p.actionType === "append_note");
    expect(email?.skipReason).toMatch(/linked to a Goodshuffle project/i);
    expect(note?.skipReason).toMatch(/linked to a Goodshuffle project/i);
  });

  it("creates no tasks and no quote card without a project", () => {
    expect(props.some((p) => p.actionType === "create_gs_task" && !p.skipReason)).toBe(false);
    expect(props.some((p) => p.actionType === "modify_quote")).toBe(false);
  });

  it("still offers an SMS draft (phone-based, needs no project)", () => {
    const sms = props.find((p) => p.actionType === "send_sms" && !p.skipReason);
    expect(sms).toBeTruthy();
  });
});

describe("Slack labels", () => {
  it("askerLabel mentions a Slack user id and leaves a name plain", () => {
    expect(askerLabel("U0123ABCD")).toBe("<@U0123ABCD>");
    expect(askerLabel("Jessie")).toBe("Jessie");
    expect(askerLabel("  ")).toBeNull();
    expect(askerLabel(undefined)).toBeNull();
  });

  it("callLabel shows direction and ops-timezone time", () => {
    expect(callLabel({ direction: "inbound", occurredAt: "2026-11-10T19:05:00.000Z" })).toBe("Inbound call, Nov 10, 2:05 PM");
    expect(callLabel({ direction: "outbound", occurredAt: null })).toBe("Outbound call");
    expect(callLabel({ direction: null, occurredAt: "not a date" })).toBe("Call");
  });
});
