import { describe, it, expect } from "vitest";
import {
  autoStatus,
  daysSinceContactDays,
  STATE_FILTERS,
  BOARD_COLUMNS,
  FOLLOWUP_SILENCE_DAYS,
  type AutoStatusFacts,
  type AutoStatusSignals,
} from "./boardTypes";

// The classifier (autoStatus) is THE signal behind the four header state filters. These tests lock the
// mapping: New / Quote Sent / Action Needed / Signed each come from a state the code already computes.
const facts = (over: Partial<AutoStatusFacts> = {}): AutoStatusFacts => ({ signed: false, statusLabel: "", quoteSentDate: null, ...over });
const sig = (over: Partial<AutoStatusSignals> = {}): AutoStatusSignals => ({ state: "QUOTED", nbaAction: "WAIT", repliedMinutesAgo: null, daysSinceContact: null, ...over });

describe("salesos boardTypes — STATE_FILTERS (the four requested header filters)", () => {
  it("offers exactly New / Quote Sent / Action Needed / Signed, in that order", () => {
    expect(STATE_FILTERS.map((s) => s.label)).toEqual(["New", "Quote Sent", "Action Needed", "Signed"]);
    expect(STATE_FILTERS.map((s) => s.key)).toEqual(["new", "quote_sent", "action_needed", "signed"]);
  });

  it("every header filter key is a real board column (no invented states)", () => {
    const columnKeys = new Set(BOARD_COLUMNS.map((c) => c.key));
    for (const f of STATE_FILTERS) expect(columnKeys.has(f.key)).toBe(true);
  });
});

describe("salesos boardTypes — autoStatus mapping onto the filter labels", () => {
  it("Signed: a signed booking is Signed regardless of other signals", () => {
    expect(autoStatus(facts({ signed: true }), sig({ nbaAction: "CALL_NOW" }))).toBe("signed");
  });

  it("New: no quote sent and nothing else urgent → New", () => {
    expect(autoStatus(facts({ quoteSentDate: null, statusLabel: "Draft" }), sig({ state: "NEW" }))).toBe("new");
  });

  it("Quote Sent: a sent quote sitting quietly within the follow-up window → Quote Sent", () => {
    expect(autoStatus(facts({ quoteSentDate: "2026-10-18" }), sig({ state: "QUOTED", daysSinceContact: 1 }))).toBe("quote_sent");
  });

  it("Action Needed: the customer just replied (within 24h) → Action Needed", () => {
    expect(autoStatus(facts({ quoteSentDate: "2026-10-01" }), sig({ repliedMinutesAgo: 30 }))).toBe("action_needed");
  });

  it("Action Needed: an urgent next-best-action → Action Needed", () => {
    expect(autoStatus(facts({ quoteSentDate: "2026-10-01" }), sig({ nbaAction: "HANDLE_OBJECTION" }))).toBe("action_needed");
  });

  it("Action Needed: an objection / ready-to-book customer state → Action Needed", () => {
    expect(autoStatus(facts({ quoteSentDate: "2026-10-01" }), sig({ state: "READY_TO_BOOK" }))).toBe("action_needed");
  });

  it("follow_up (not a header filter, still classified): sent but silent past the window → Need Follow-up", () => {
    expect(autoStatus(facts({ quoteSentDate: "2026-09-01" }), sig({ state: "QUOTED", daysSinceContact: FOLLOWUP_SILENCE_DAYS + 2 }))).toBe("follow_up");
  });

  it("archived: a lost/cancelled status drops off the board", () => {
    expect(autoStatus(facts({ statusLabel: "Lost" }), sig())).toBe("archived");
    expect(autoStatus(facts({ statusLabel: "Cancelled" }), sig())).toBe("archived");
  });
});

describe("salesos boardTypes — daysSinceContactDays", () => {
  it("prefers the last-contact date over the quote-sent date", () => {
    expect(daysSinceContactDays("2026-10-15", "2026-10-01", "2026-10-19")).toBe(4);
  });
  it("falls back to the quote-sent date when there is no contact", () => {
    expect(daysSinceContactDays(null, "2026-10-01", "2026-10-19")).toBe(18);
  });
  it("is null when neither signal exists", () => {
    expect(daysSinceContactDays(null, null, "2026-10-19")).toBeNull();
  });
});
