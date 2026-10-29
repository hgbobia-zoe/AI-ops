// Tests for the Communications queue view logic — the filter/sort/label contract the redesigned table
// and mobile list rely on. These guard the honesty rules (unresolved ≠ resolved, caller vs customer
// search) and the filter semantics preserved from the original client code.

import { describe, it, expect } from "vitest";
import type { QueueRow } from "./types";
import {
  filterRows,
  sortRows,
  activeFilterCount,
  anyFilterActive,
  EMPTY_FILTERS,
  channelDescriptor,
  dispositionText,
  statusTone,
  statusText,
  handledText,
  type QueueFilters,
} from "./queueView";

function row(over: Partial<QueueRow>): QueueRow {
  return {
    id: "c1",
    providerId: "p1",
    occurredAt: "2026-10-28T15:00:00.000Z",
    ts: "2026-10-28T15:00:00.000Z",
    direction: "incoming",
    callerName: "Alex Caller",
    callerPhone: "+13015551234",
    customerName: null,
    customerId: null,
    eventName: null,
    eventDate: null,
    reason: "SALES_INQUIRY",
    reasonConfidence: 0.5,
    reasonMethod: "heuristic",
    channel: "call",
    handledBy: "HUMAN",
    status: "COMPLETED",
    disposition: "UNKNOWN",
    sentiment: null,
    identityConfidence: "CONFIRMED",
    durationSec: 120,
    riskCount: 0,
    ...over,
  };
}

const f = (over: Partial<QueueFilters>): QueueFilters => ({ ...EMPTY_FILTERS, ...over });
const TODAY = "2026-10-28";
const YESTERDAY = "2026-10-27";

describe("filterRows", () => {
  const rows = [
    row({ id: "a", handledBy: "HUMAN", disposition: "ESCALATED", reason: "BILLING", channel: "call", occurredAt: "2026-10-28T10:00:00Z" }),
    row({ id: "b", handledBy: "TRANSFERRED", disposition: "UNKNOWN", reason: "SALES_INQUIRY", channel: "sms", occurredAt: "2026-10-27T10:00:00Z" }),
    row({ id: "c", handledBy: "HUMAN", disposition: "UNKNOWN", reason: "DELIVERY_STATUS", channel: "call", occurredAt: "2026-10-28T12:00:00Z" }),
  ];

  it("filters by handled-by", () => {
    expect(filterRows(rows, f({ handled: "TRANSFERRED" }), "", TODAY, YESTERDAY).map((r) => r.id)).toEqual(["b"]);
  });

  it("ESCALATED state keeps only escalated rows", () => {
    expect(filterRows(rows, f({ disposition: "ESCALATED" }), "", TODAY, YESTERDAY).map((r) => r.id)).toEqual(["a"]);
  });

  it("UNRESOLVED state means disposition UNKNOWN (never equates to resolved)", () => {
    expect(filterRows(rows, f({ disposition: "UNRESOLVED" }), "", TODAY, YESTERDAY).map((r) => r.id).sort()).toEqual(["b", "c"]);
  });

  it("filters by desk via the reason routing table", () => {
    // BILLING reason → BILLING desk
    expect(filterRows(rows, f({ desk: "BILLING" }), "", TODAY, YESTERDAY).map((r) => r.id)).toEqual(["a"]);
    // SALES_INQUIRY → SALES, DELIVERY_STATUS → OPERATIONS
    expect(filterRows(rows, f({ desk: "OPERATIONS" }), "", TODAY, YESTERDAY).map((r) => r.id)).toEqual(["c"]);
  });

  it("filters by channel (primary quick filter)", () => {
    expect(filterRows(rows, f({ channel: "sms" }), "", TODAY, YESTERDAY).map((r) => r.id)).toEqual(["b"]);
  });

  it("filters by day", () => {
    expect(filterRows(rows, f({ day: "yesterday" }), "", TODAY, YESTERDAY).map((r) => r.id)).toEqual(["b"]);
    expect(filterRows(rows, f({ day: "today" }), "", TODAY, YESTERDAY).map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("search matches caller, phone, customer and event — keeping caller vs customer both searchable", () => {
    const r1 = row({ id: "caller", callerName: "Jordan Planner", customerName: "Zoe Bride", eventName: "Smith Wedding" });
    const set = [r1];
    expect(filterRows(set, f({}), "planner", TODAY, YESTERDAY)).toHaveLength(1); // caller
    expect(filterRows(set, f({}), "zoe bride", TODAY, YESTERDAY)).toHaveLength(1); // matched customer
    expect(filterRows(set, f({}), "smith", TODAY, YESTERDAY)).toHaveLength(1); // event
    expect(filterRows(set, f({}), "nobody", TODAY, YESTERDAY)).toHaveLength(0);
  });
});

describe("sortRows", () => {
  const rows = [
    row({ id: "old", occurredAt: "2026-10-26T10:00:00Z", callerName: "Bob", reason: "BILLING", riskCount: 1 }),
    row({ id: "new", occurredAt: "2026-10-28T10:00:00Z", callerName: "Ann", reason: "DAMAGE", riskCount: 3 }),
  ];
  it("time desc puts newest first", () => {
    expect(sortRows(rows, "time", "desc").map((r) => r.id)).toEqual(["new", "old"]);
  });
  it("caller asc sorts alphabetically", () => {
    expect(sortRows(rows, "caller", "asc").map((r) => r.callerName)).toEqual(["Ann", "Bob"]);
  });
  it("risk desc sorts by open-risk count", () => {
    expect(sortRows(rows, "risk", "desc").map((r) => r.riskCount)).toEqual([3, 1]);
  });
  it("does not mutate the input array", () => {
    const before = rows.map((r) => r.id);
    sortRows(rows, "caller", "asc");
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe("filter accounting", () => {
  it("counts only the four secondary filters", () => {
    expect(activeFilterCount(f({ handled: "HUMAN", desk: "SALES", channel: "sms" }))).toBe(2);
  });
  it("anyFilterActive includes the channel primary filter", () => {
    expect(anyFilterActive(f({ channel: "sms" }))).toBe(true);
    expect(anyFilterActive(EMPTY_FILTERS)).toBe(false);
  });
});

describe("label helpers", () => {
  it("channelDescriptor expands abbreviations and names direction", () => {
    expect(channelDescriptor(row({ channel: "call", direction: "incoming" }))).toEqual({ short: "Incoming call", full: "Incoming phone call" });
    expect(channelDescriptor(row({ channel: "sms" })).short).toBe("SMS");
  });
  it("dispositionText never says resolved for an unknown outcome", () => {
    expect(dispositionText("UNKNOWN")).toBe("Outcome unknown");
    expect(dispositionText("ESCALATED")).toBe("Escalated");
  });
  it("statusTone maps missed→critical, completed→positive", () => {
    expect(statusTone("MISSED")).toBe("critical");
    expect(statusTone("COMPLETED")).toBe("positive");
    expect(statusTone("RINGING")).toBe("attention");
  });
  it("statusText and handledText humanise the enums", () => {
    expect(statusText("IN_PROGRESS")).toBe("In progress");
    expect(handledText("TRANSFERRED")).toBe("Transferred");
  });
});
