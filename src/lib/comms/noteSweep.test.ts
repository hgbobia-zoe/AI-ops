// Note sweep: texts sent in the Quo app and calls whose webhook never arrived still get a Goodshuffle
// note, once. Quo is MOCKED (no network).

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("./openphone", async (orig) => ({
  ...(await orig<typeof import("./openphone")>()),
  listOpenphoneCalls: vi.fn(async () => ({ calls: [], nextPageToken: null })),
  getCallSummary: vi.fn(async () => null),
  openphoneUserInitials: vi.fn(async (id?: string | null) => (id === "USjm" ? "JM" : null)),
}));

import { getDb } from "@/lib/db";
import { insertMessage, listPendingGsOps, type CommsEventView } from "@/lib/db/repo";
import { listOpenphoneCalls, getCallSummary } from "./openphone";
import { noteRecentTexts, noteRecentCalls, callOutcome, inSweepWindow, NOTE_SWEEP_HOURS } from "./noteSweep";

const NOW = Date.parse("2026-11-04T20:00:00Z");
const LEAD = { bookingId: "B1", clientName: "Andrina Stephens", clientPhone: "+13015550123" };
const NUMBERS = [{ id: "PN1", number: "+13012915296" }];
const msg = (over: Partial<CommsEventView>): CommsEventView => ({
  id: "M1", providerId: "M1", leadId: null, direction: "outbound", channel: "sms", fromPhone: null, toPhone: null,
  body: "Hi Andrina! This is Jessie from Zoe Events.", actor: "JM", occurredAt: "2026-11-04T18:27:00Z", ts: "2026-11-04T18:27:00Z", ...over,
});
const notes = () => listPendingGsOps().filter((o) => o.op === "note_append").map((o) => (o.payload as { line: string }).line);

beforeEach(() => {
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM messages").run();
  (listOpenphoneCalls as unknown as Mock).mockReset().mockResolvedValue({ calls: [], nextPageToken: null });
  (getCallSummary as unknown as Mock).mockReset().mockResolvedValue(null);
});

describe("texts sent in the Quo app", () => {
  it("get one note each, attributed to the rep, and only within the look back window", () => {
    const thread = [
      msg({}),
      msg({ id: "M0", providerId: "M0", direction: "inbound", body: "Thanks", actor: "Customer" }),
      msg({ id: "OLD", providerId: "OLD", occurredAt: new Date(NOW - (NOTE_SWEEP_HOURS + 1) * 3_600_000).toISOString() }),
    ];
    expect(noteRecentTexts(LEAD, thread, NOW)).toBe(1);
    expect(noteRecentTexts(LEAD, thread, NOW)).toBe(0); // second run: already noted
    expect(notes()).toEqual(['11/4 - JM texted Andrina Stephens: "Hi Andrina! This is Jessie from Zoe Events."']);
  });

  it("skip texts the app sent itself (they write their own note) and say Zoe team when the rep is unknown", () => {
    insertMessage({ channel: "sms", provider: "openphone", toPhone: LEAD.clientPhone, body: "x", providerMsgId: "APP1", status: "sent" });
    expect(noteRecentTexts(LEAD, [msg({ id: "APP1", providerId: "APP1" }), msg({ id: "M2", providerId: "M2", actor: "Zoe" })], NOW)).toBe(1);
    expect(notes()[0]).toMatch(/^11\/4 - Zoe team texted Andrina Stephens/);
  });
});

describe("calls read from Quo", () => {
  it("note a finished call with its summary once, wait for a fresh one to settle, skip old ones", async () => {
    (listOpenphoneCalls as unknown as Mock).mockResolvedValue({
      calls: [
        { id: "AC1", direction: "outgoing", participants: [], durationSec: 34, occurredAt: "2026-11-04T18:27:42Z", userId: "USjm", status: "completed" },
        { id: "AC2", direction: "outgoing", participants: [], durationSec: 20, occurredAt: new Date(NOW - 2 * 60_000).toISOString(), userId: "USjm", status: "completed" },
        { id: "AC3", direction: "outgoing", participants: [], durationSec: 20, occurredAt: "2026-10-28T18:27:42Z", userId: "USjm", status: "completed" },
      ],
      nextPageToken: null,
    });
    (getCallSummary as unknown as Mock).mockResolvedValue("Jessie called for the weekly follow up; no decision yet.");
    expect(await noteRecentCalls(LEAD, NUMBERS, NOW)).toBe(1);
    expect(await noteRecentCalls(LEAD, NUMBERS, NOW)).toBe(0);
    expect(getCallSummary).toHaveBeenCalledTimes(1); // the second run skips the API read for a noted call
    expect(notes()).toEqual(["11/4 - JM called Andrina Stephens — Jessie called for the weekly follow up; no decision yet."]);
  });

  it("an unanswered outgoing call reads as a voicemail left, like the webhook path", async () => {
    (listOpenphoneCalls as unknown as Mock).mockResolvedValue({
      calls: [{ id: "AC4", direction: "outgoing", participants: [], durationSec: 0, occurredAt: "2026-11-04T15:00:00Z", userId: "USjm", status: "no-answer" }],
      nextPageToken: null,
    });
    await noteRecentCalls(LEAD, NUMBERS, NOW);
    expect(notes()).toEqual(["11/4 - JM called Andrina Stephens, left voicemail"]);
  });

  it("outcome and window rules", () => {
    expect(callOutcome({ direction: "incoming", durationSec: 0 }, null)).toBe("voicemail_received");
    expect(callOutcome({ direction: "outgoing", durationSec: 40 }, null)).toBe("conversation");
    expect(callOutcome({ direction: "outgoing", durationSec: 0 }, "Talked about chairs")).toBe("conversation");
    expect(inSweepWindow("2026-11-04T19:55:00Z", NOW, 10 * 60_000)).toBe(false);
    expect(inSweepWindow(null, NOW)).toBe(false);
  });
});
