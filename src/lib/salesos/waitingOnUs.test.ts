// "Waiting on us" pauses the 3 day auto lost (owner, 2026-11-14): a rep's mark, or detection from the
// conversation (the client wrote last, an open ask we have not answered, the board's Action Needed flag).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/comms/openphoneSync", () => ({ ensureLeadThreadSynced: vi.fn() }));
vi.mock("@/lib/comms/openphone", () => ({ getOpenphonePhoneNumbers: vi.fn(), listOpenphoneCalls: vi.fn(), openphoneApiKey: () => null }));
vi.mock("@/lib/notify/aiBots", () => ({ botAnnounce: vi.fn(), appUrl: () => null }));

import { getDb } from "@/lib/db";
import { saveBookings, type BookingRecord } from "@/lib/db/repo";
import { gateLead, type GateInput } from "./morningOutreach";
import type { TimelineEntry } from "./timeline";
import { markWaiting, clearWaiting, getWaitingMark, markLine } from "./waitingOnUs";
import { queueMarkLost } from "./markLost";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const e = (over: Partial<TimelineEntry>): TimelineEntry => ({ at: null, channel: "sms", direction: null, actor: null, title: "", source: "comms_events", ...over });
const ourTextYesterday = e({ at: "2026-11-13T15:00:00Z", direction: "out", detail: "Hi, just checking in" });
const gate = (over: Partial<GateInput> = {}): GateInput => ({ hasPhone: true, daysToEvent: 2, subStatus: "follow_up", timeline: [ourTextYesterday], liveCalls: [], now: NOW, ...over });
const mark = { markedBy: "Jessie Medalla", markedAt: "2026-11-14T14:00:00Z", note: "sending a revised quote" };

describe("gateLead: waiting on us pauses auto lost", () => {
  it("still marks an unsigned quote lost at 3 days when nobody is waiting", () => {
    expect(gateLead(gate())).toMatchObject({ lose: true, kind: "lose" });
  });

  it("a rep's mark pauses it and names who marked it", () => {
    const r = gateLead(gate({ waitingMark: mark }));
    expect(r.lose).toBeFalsy();
    expect(r.kind).toBe("lose_waiting");
    expect(r.reason).toBe("The event is in 2 days and Jessie Medalla marked it waiting on us (sending a revised quote). A person should answer before it is marked lost.");
  });

  it("an open ask we have not answered pauses it", () => {
    const r = gateLead(gate({ openAsks: [{ summary: "Wants a bigger tent", quote: "Can we do a 20x40 instead?" }] }));
    expect(r).toMatchObject({ kind: "lose_waiting", said: "Can we do a 20x40 instead?" });
    expect(r.lose).toBeFalsy();
  });

  it("the client writing last pauses it (unchanged)", () => {
    const tl = [e({ at: "2026-11-14T12:00:00Z", direction: "in", detail: "Can you send the quote again?" }), ourTextYesterday];
    expect(gateLead(gate({ timeline: tl })).kind).toBe("lose_waiting");
  });

  it("further out, a mark or an open ask holds the morning text for a person", () => {
    const far = { daysToEvent: 40, timeline: [e({ at: "2026-10-01T15:00:00Z", direction: "out" })] };
    expect(gateLead(gate(far)).send).toBe(true);
    expect(gateLead(gate({ ...far, waitingMark: mark }))).toMatchObject({ send: false, kind: "waiting" });
    expect(gateLead(gate({ ...far, openAsks: [{ summary: "s", quote: "Do you deliver on Sunday?" }] }))).toMatchObject({ send: false, kind: "waiting" });
  });

  it("the hard gate still wins over a mark", () => {
    expect(gateLead(gate({ waitingMark: mark, block: { kind: "archived", reason: "The project is archived in Goodshuffle." } })).kind).toBe("archived");
  });
});

describe("the mark store and queueMarkLost", () => {
  const booking = (id: string, over: Partial<BookingRecord> = {}): BookingRecord => ({ bookingId: id, eventName: `Q ${id}`, eventDate: "2026-11-16", statusLabel: "Quote Sent", signed: false, clientName: "Pat Doe", ...over });

  beforeEach(() => {
    const db = getDb();
    for (const t of ["bookings", "sales_waiting_on_us", "gs_outbox"]) db.prepare(`DELETE FROM ${t}`).run();
  });

  it("records who marked it, re-marks, and clears", () => {
    expect(getWaitingMark("W1")).toBeNull();
    markWaiting("W1", "Jessie Medalla", "  needs a revised quote ", new Date(NOW));
    expect(getWaitingMark("W1")).toMatchObject({ markedBy: "Jessie Medalla", note: "needs a revised quote" });
    expect(markLine(getWaitingMark("W1")!)).toBe("Jessie Medalla marked it waiting on us on Nov 14 (needs a revised quote)");
    expect(clearWaiting("W1", "Hermann Gbobia")).toBe(true);
    expect(getWaitingMark("W1")).toBeNull();
    expect(clearWaiting("W1", "Hermann Gbobia")).toBe(false);
    markWaiting("W1", "Cindy", null);
    expect(getWaitingMark("W1")).toMatchObject({ markedBy: "Cindy", note: null });
  });

  it("never queues mark lost for a marked lead, even when the plan said lose", () => {
    saveBookings([booking("W2"), booking("W3")]);
    markWaiting("W2", "Jessie Medalla", null);
    expect(queueMarkLost("W2", "3 days out")).toEqual({ queued: false, reason: "waiting_on_us" });
    expect(queueMarkLost("W3", "3 days out")).toMatchObject({ queued: true });
  });
});
