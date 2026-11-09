// Blank Goodshuffle drafts: the pure predicate, its SQL twin (row-for-row parity against the real in-memory
// SQLite), the repo readers that must exclude them, and the runaway-create burst finder.

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import {
  saveBookings,
  saveLeadNotes,
  getOpenLeads,
  getPipelineLeads,
  getAllBookings,
  getRecentBookings,
  getQuoteStageSnapshot,
  getLostQuotes,
  type BookingRecord,
} from "@/lib/db/repo";
import {
  isBlankDraft,
  isUnnamedProjectName,
  withoutBlankDrafts,
  BLANK_DRAFT_SQL,
  findBlankDraftBursts,
  blankDraftBurstMessage,
  type BlankDraftInput,
} from "./blankDraft";

// A blank draft exactly as an allProjects=true pull delivers one (GS gives no name, no client, $0).
const BLANK: BlankDraftInput = { eventName: "", signed: false, clientName: "", clientEmail: "", clientPhone: "", grandTotal: 0, contractTotal: 0, amountPaid: 0, lineItems: null };

describe("isUnnamedProjectName", () => {
  it("matches empty and GS placeholder names, case and whitespace insensitive", () => {
    for (const n of [null, undefined, "", "   ", "Unnamed Project", "unnamed project (231976120)", "  UNNAMED PROJECT  "]) expect(isUnnamedProjectName(n)).toBe(true);
  });
  it("does not match real names", () => {
    for (const n of ["Gbobia - other", "Smith Wedding", "Project Unnamed"]) expect(isUnnamedProjectName(n)).toBe(false);
  });
});

describe("isBlankDraft", () => {
  it("flags the blank shell (empty or Unnamed name, no client, no money, no items)", () => {
    expect(isBlankDraft(BLANK)).toBe(true);
    expect(isBlankDraft({ ...BLANK, eventName: "Unnamed Project (231976212)" })).toBe(true);
    expect(isBlankDraft({ ...BLANK, grandTotal: null, contractTotal: null, amountPaid: null })).toBe(true);
    expect(isBlankDraft({ ...BLANK, lineItems: [] })).toBe(true);
    expect(isBlankDraft({})).toBe(true); // nothing known at all is still nothing
  });
  it("never drops a real lead: any one sign of life keeps it", () => {
    expect(isBlankDraft({ ...BLANK, eventName: "Gbobia - other" })).toBe(false);
    expect(isBlankDraft({ ...BLANK, clientName: "Ann Murtlow" })).toBe(false);
    expect(isBlankDraft({ ...BLANK, clientEmail: "a@b.com" })).toBe(false);
    expect(isBlankDraft({ ...BLANK, clientPhone: "3015550100" })).toBe(false);
    expect(isBlankDraft({ ...BLANK, grandTotal: 120 })).toBe(false);
    expect(isBlankDraft({ ...BLANK, contractTotal: 99 })).toBe(false);
    expect(isBlankDraft({ ...BLANK, amountPaid: 50 })).toBe(false);
    expect(isBlankDraft({ ...BLANK, lineItems: ["Chiavari chair"] })).toBe(false);
    expect(isBlankDraft({ ...BLANK, signed: true })).toBe(false);
  });
  it("withoutBlankDrafts filters a list", () => {
    expect(withoutBlankDrafts([BLANK, { ...BLANK, eventName: "Real" }]).map((r) => r.eventName)).toEqual(["Real"]);
  });
});

// ── DB: SQL twin parity + the readers ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  getDb().prepare("DELETE FROM bookings").run();
});

// Fixtures covering every clause. `blank` is what isBlankDraft says; the SQL must agree on each.
const FIXTURES: Array<{ rec: BookingRecord; lineItems?: string[] | null }> = [
  { rec: { bookingId: "231976120", eventName: "", statusLabel: "New Project", grandTotal: 0, contractTotal: 0, amountPaid: 0, archived: true, dateCreated: "2026-10-31" } },
  { rec: { bookingId: "231976121", eventName: "Unnamed Project", statusLabel: "New Project", archived: false, dateCreated: "2026-10-31" } },
  { rec: { bookingId: "231976122", eventName: "Unnamed Project", statusLabel: "New Project", archived: false }, lineItems: [] },
  { rec: { bookingId: "R-NAMED", eventName: "Gbobia - other", statusLabel: "New Project", dateCreated: "2026-11-01" } },
  { rec: { bookingId: "R-CLIENT", eventName: "", clientName: "Ann Murtlow", statusLabel: "New Project" } },
  { rec: { bookingId: "R-EMAIL", eventName: "", clientEmail: "x@y.com", statusLabel: "New Project" } },
  { rec: { bookingId: "R-PHONE", eventName: "", clientPhone: "3015550100", statusLabel: "New Project" } },
  { rec: { bookingId: "R-MONEY", eventName: "Unnamed Project", grandTotal: 250, statusLabel: "Quote Sent" } },
  { rec: { bookingId: "R-PAID", eventName: "Unnamed Project", amountPaid: 10, statusLabel: "Quote Sent" } },
  { rec: { bookingId: "R-SIGNED", eventName: "", signed: true, statusLabel: "Contract Signed" } },
  { rec: { bookingId: "R-ITEMS", eventName: "", statusLabel: "New Project" }, lineItems: ["Linen"] },
  { rec: { bookingId: "R-LOST", eventName: "Jones Party", statusLabel: "Lost", clientName: "Jones" } },
  { rec: { bookingId: "B-LOST", eventName: "", statusLabel: "Lost" } },
];

function seed(): void {
  saveBookings(FIXTURES.map((f) => f.rec));
  saveLeadNotes(FIXTURES.filter((f) => f.lineItems !== undefined).map((f) => ({ bookingId: f.rec.bookingId, lineItems: f.lineItems })));
}

const expectedBlank = (f: (typeof FIXTURES)[number]): boolean =>
  isBlankDraft({ ...f.rec, lineItems: f.lineItems ?? null });

describe("BLANK_DRAFT_SQL", () => {
  it("agrees with isBlankDraft row for row", () => {
    seed();
    const sqlBlank = new Set(
      (getDb().prepare(`SELECT booking_id FROM bookings WHERE ${BLANK_DRAFT_SQL}`).all() as { booking_id: string }[]).map((r) => r.booking_id),
    );
    for (const f of FIXTURES) expect([f.rec.bookingId, sqlBlank.has(f.rec.bookingId)]).toEqual([f.rec.bookingId, expectedBlank(f)]);
    expect([...sqlBlank].sort()).toEqual(["231976120", "231976121", "231976122", "B-LOST"]);
  });
});

describe("repo readers exclude blank drafts", () => {
  const blanks = ["231976120", "231976121", "231976122", "B-LOST"];
  const ids = (rows: { bookingId: string }[]) => rows.map((r) => r.bookingId);

  it("Sales OS open + pipeline leads", () => {
    seed();
    const open = ids(getOpenLeads("2026-11-08"));
    const pipe = ids(getPipelineLeads("2026-11-08"));
    for (const b of blanks) {
      expect(open).not.toContain(b);
      expect(pipe).not.toContain(b);
    }
    expect(open).toContain("R-NAMED");
    expect(pipe).toContain("R-SIGNED");
  });

  it("all bookings (trends, customers, lost analysis), recent picker, lost quotes", () => {
    seed();
    const all = ids(getAllBookings());
    for (const b of blanks) expect(all).not.toContain(b);
    expect(all).toHaveLength(FIXTURES.length - blanks.length);
    for (const b of blanks) expect(ids(getRecentBookings(100))).not.toContain(b);
    expect(ids(getLostQuotes())).toEqual(["R-LOST"]);
  });

  it("the active quote stage snapshot no longer counts unarchived blanks as New", () => {
    seed();
    const snap = getQuoteStageSnapshot();
    // Unarchived, non-lost, non-blank "New Project" rows: R-NAMED, R-CLIENT, R-EMAIL, R-PHONE, R-ITEMS.
    expect(snap.stageNew).toBe(5);
  });
});

// ── Burst finder ──────────────────────────────────────────────────────────────────────────────────────

describe("findBlankDraftBursts", () => {
  const mk = (n: number, date: string, start = 231976120) =>
    Array.from({ length: n }, (_, i) => ({ bookingId: String(start + i), dateCreated: date, eventName: "", statusLabel: "New Project" }));

  it("reports a day with more than the threshold of blanks, ids sorted", () => {
    const rows = [...mk(6, "2026-11-08").reverse(), { bookingId: "999", dateCreated: "2026-11-08", eventName: "Real lead" }];
    const bursts = findBlankDraftBursts(rows, "2026-11-07", 5);
    expect(bursts).toEqual([{ date: "2026-11-08", count: 6, ids: mk(6, "2026-11-08").map((r) => r.bookingId) }]);
  });

  it("stays quiet at or under the threshold, for old days, and for undated rows", () => {
    expect(findBlankDraftBursts(mk(5, "2026-11-08"), "2026-11-07", 5)).toEqual([]);
    expect(findBlankDraftBursts(mk(66, "2026-10-31"), "2026-11-07", 5)).toEqual([]); // the archived incident
    expect(findBlankDraftBursts(mk(10, "").map((r) => ({ ...r, dateCreated: null })), "2026-11-07", 5)).toEqual([]);
  });

  it("message follows house style (no dashes, no emoji) and names the id range", () => {
    const msg = blankDraftBurstMessage({ date: "2026-11-08", count: 6, ids: ["231976120", "231976125"] });
    expect(msg).toContain("ids 231976120 to 231976125");
    expect(msg).not.toMatch(/[–—]| - /);
    expect(msg).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
