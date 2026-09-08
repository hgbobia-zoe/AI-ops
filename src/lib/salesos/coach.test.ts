import { describe, it, expect, beforeEach } from "vitest";
import { saveBookings, listPendingGsOps, getCommsForLead } from "@/lib/db/repo";
import { coachBrief, coachResolveLead, applyCoachDebrief, coachAuthOk } from "./coach";

// These exercise the coach bridge against the in-memory DB (DATABASE_PATH=":memory:" in vitest).
// No LLM is configured under test, so debriefCall folds to the deterministic state — which is exactly
// the honest fallback we want to verify (a call still lands on the timeline + queues a note).

const seedLead = (over: Partial<Parameters<typeof saveBookings>[0][number]> = {}): string => {
  const id = over.bookingId ?? "TEST-COACH-1";
  saveBookings([
    {
      bookingId: id,
      eventName: "Ashford Wedding",
      eventDate: "2027-06-12",
      statusLabel: "Quote Sent",
      signed: false,
      grandTotal: 850000,
      clientName: "Dana Ashford",
      clientPhone: "(301) 555-0142",
      quoteSentDate: "2026-09-01",
      ...over,
    },
  ]);
  return id;
};

describe("coach bridge — auth", () => {
  it("is fail-closed: no token configured ⇒ never authorized", () => {
    delete process.env.COACH_API_TOKEN;
    const req = new Request("https://x/api/coach/brief", { headers: { authorization: "Bearer whatever" } });
    expect(coachAuthOk(req)).toBe(false);
  });

  it("accepts the bearer or x-coach-token header when the token is set", () => {
    process.env.COACH_API_TOKEN = "secret-123";
    expect(coachAuthOk(new Request("https://x", { headers: { authorization: "Bearer secret-123" } }))).toBe(true);
    expect(coachAuthOk(new Request("https://x", { headers: { "x-coach-token": "secret-123" } }))).toBe(true);
    expect(coachAuthOk(new Request("https://x", { headers: { authorization: "Bearer nope" } }))).toBe(false);
    delete process.env.COACH_API_TOKEN;
  });
});

describe("coach bridge — brief", () => {
  beforeEach(() => seedLead());

  it("assembles a state-keyed brief with the customer's first name interpolated", () => {
    const b = coachBrief("TEST-COACH-1");
    expect(b).not.toBeNull();
    expect(b!.clientFirstName).toBe("Dana");
    expect(b!.opening).toContain("Dana");
    expect(b!.opening).not.toContain("{first}");
    expect(b!.watchFor.length).toBeGreaterThan(0);
    expect(b!.state).toBeTruthy();
    expect(b!.stateLabel).toBeTruthy();
  });

  it("resolves a lead by phone (last 10 digits) when no id is given", () => {
    const byPhone = coachResolveLead(null, "+1 301-555-0142");
    expect(byPhone?.bookingId).toBe("TEST-COACH-1");
  });

  it("returns null for an unknown lead", () => {
    expect(coachBrief("NOPE")).toBeNull();
  });
});

describe("coach bridge — debrief", () => {
  beforeEach(() => seedLead());

  it("no matching lead ⇒ matched:false, nothing written", async () => {
    const r = await applyCoachDebrief({ phone: "202-555-9999", summary: "Talked it over." });
    expect(r.matched).toBe(false);
    expect(r.onTimeline).toBe(false);
  });

  it("a conversation lands on the timeline + queues a Goodshuffle note, and is idempotent on sessionId", async () => {
    const r1 = await applyCoachDebrief({
      leadId: "TEST-COACH-1",
      sessionId: "sess-abc",
      summary: "Customer asked about delivery windows and seemed positive.",
      durationSec: 300,
    });
    expect(r1.matched).toBe(true);
    expect(r1.onTimeline).toBe(true);
    expect(r1.noteQueued).toBe(true);

    // Timeline shows the call.
    const comms = getCommsForLead("TEST-COACH-1", 10);
    expect(comms.some((c) => c.channel === "call")).toBe(true);

    // A Goodshuffle note was queued for the office pull.
    const ops = listPendingGsOps(50).filter((o) => o.transactionId === "TEST-COACH-1" && o.op === "note_append");
    expect(ops.length).toBe(1);

    // Re-post with the same session id ⇒ no duplicate timeline row.
    const r2 = await applyCoachDebrief({ leadId: "TEST-COACH-1", sessionId: "sess-abc", summary: "dup", durationSec: 300 });
    expect(r2.onTimeline).toBe(false);
  });
});
