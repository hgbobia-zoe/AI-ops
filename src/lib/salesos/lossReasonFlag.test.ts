import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posts: { domain: string; message: unknown }[] = [];
vi.mock("@/lib/notify/channels", () => ({
  notify: async (domain: string, message: unknown) => {
    posts.push({ domain, message });
    return { ok: true } as const;
  },
}));

import { getDb } from "@/lib/db";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import {
  saveBookings,
  saveLeadNotes,
  setLossReason,
  enqueueGsOp,
  listPendingGsOps,
  getBookingById,
  lossNoteWatchIds,
  type BookingRecord,
} from "@/lib/db/repo";
import {
  runLossReasonFlags,
  lossFlagState,
  noteLossReason,
  lossFlagMessage,
  fillKnownLossReasons,
  queueLossReasonNote,
  LOSS_TASK_TITLE,
  DEFAULT_FALLBACK_GS_USER_ID,
} from "./lossReasonFlag";
import { classifyLossReason, LOSS_REASONS, SALES_BOT_LOSS_REASON } from "./lossReasons";
import { queueMarkLost } from "./markLost";

// Tue 2026-11-10, 11:00 ET: inside default business hours.
const NOW = new Date("2026-11-10T16:00:00Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const booking = (id: string, statusLabel: string, over: Partial<BookingRecord> = {}): BookingRecord => ({
  bookingId: id,
  eventName: `Event ${id}`,
  eventDate: "2026-12-01",
  statusLabel,
  signed: false,
  grandTotal: 1500,
  clientName: "Client",
  clientEmail: `${id}@x.com`,
  clientPhone: "",
  quoteSentDate: "2026-10-01",
  dateCreated: "2025-01-15",
  salesLead: "Cindy Gbobia",
  ...over,
});

const col = (id: string, c: string): string | null =>
  (getDb().prepare(`SELECT ${c} AS v FROM bookings WHERE booking_id = ?`).get(id) as { v: string | null }).v;
const setTrackAt = (id: string, at: string) => getDb().prepare("UPDATE bookings SET loss_track_at = ? WHERE booking_id = ?").run(at, id);
const taskOps = (id?: string) =>
  listPendingGsOps(500).filter((o) => o.op === "create_gs_task" && (!id || o.transactionId === id));

/** An open quote that the next pull sees as Lost (the live path), tracked 25h before NOW. */
function lostQuote(id: string, notes: string | null = null, trackAgoH = 25): void {
  saveBookings([booking(id, "Quote Sent")]);
  if (notes) saveLeadNotes([{ bookingId: id, internalNotes: notes }]);
  saveBookings([booking(id, "Lost")]);
  setTrackAt(id, iso(NOW.getTime() - trackAgoH * H));
}

beforeEach(() => {
  for (const t of ["bookings", "gs_outbox", "history_changes"]) getDb().prepare(`DELETE FROM ${t}`).run();
  posts.length = 0;
  delete process.env.LOSS_REASON_FLAGS;
});
afterEach(() => {
  delete process.env.LOSS_REASON_FLAGS;
});

describe("cutoff: which lost quotes get tracked", () => {
  it("tracks a quote the pull sees flip to lost, and snapshots its notes", () => {
    saveBookings([booking("FLIP", "Quote Sent")]);
    saveLeadNotes([{ bookingId: "FLIP", internalNotes: "called, left vm" }]);
    expect(col("FLIP", "loss_track_at")).toBeNull();
    saveBookings([booking("FLIP", "Lost")]);
    expect(col("FLIP", "loss_track_at")).not.toBeNull();
    expect(col("FLIP", "lost_at")).not.toBeNull();
    expect(col("FLIP", "lost_notes_snapshot")).toBe("called, left vm");
  });

  it("never tracks historical lost quotes (already lost when first seen, created long ago)", () => {
    saveBookings([booking("OLD", "Lost")]);
    saveBookings([booking("OLD", "Lost")]); // re-pulled in the same state: no flip
    saveBookings([booking("OLD2", "Cancelled", { dateCreated: "2026-01-02" })]);
    expect(col("OLD", "loss_track_at")).toBeNull();
    expect(col("OLD2", "loss_track_at")).toBeNull();
  });

  it("tracks a brand new project that was created and lost between two pulls", () => {
    saveBookings([booking("FAST", "Lost", { dateCreated: todayInOpsTz() })]);
    expect(col("FAST", "loss_track_at")).not.toBeNull();
  });

  it("never tracks quotes already lost at launch, however recent (owner: ignore the past ones)", () => {
    saveBookings([booking("RECENT", "Lost", { dateCreated: shiftYmd(todayInOpsTz(), -10) })]);
    expect(col("RECENT", "loss_track_at")).toBeNull();
  });

  it("keeps the captured notes through the move to lost and asks the pull to re-read them", () => {
    lostQuote("KEEP", "11/2 sent quote, client comparing vendors", 1);
    expect(getBookingById("KEEP")?.internalNotes).toBe("11/2 sent quote, client comparing vendors");
    expect(lossNoteWatchIds(iso(NOW.getTime() - 14 * 24 * H), 25)).toContain("KEEP");
  });
});

describe("detection + dedupe", () => {
  it("waits out the grace period, then flags once: one Slack post, one assigned task", async () => {
    lostQuote("Q1", null, 2); // 2h ago: inside the 24h grace
    let r = await runLossReasonFlags(NOW);
    expect(r.flagged).toBe(0);
    expect(taskOps()).toHaveLength(0);

    setTrackAt("Q1", iso(NOW.getTime() - 25 * H));
    r = await runLossReasonFlags(NOW);
    expect(r.flagged).toBe(1);
    const ops = taskOps("Q1");
    expect(ops).toHaveLength(1);
    const p = ops[0].payload as Record<string, unknown>;
    expect(p.transactionID).toBe("Q1");
    expect(p.title).toBe(LOSS_TASK_TITLE);
    expect(p.assigneeName).toBe("Cindy Gbobia");
    expect(p.fallbackUserID).toBe(DEFAULT_FALLBACK_GS_USER_ID);
    expect(p.dueDate).toBe(shiftYmd(todayInOpsTz(NOW), 2));
    expect(p.dedupeKey).toBe("lossreason|Q1");
    expect(posts).toHaveLength(1);
    expect(posts[0].domain).toBe("sales");
    expect(String(posts[0].message)).toContain("id=Q1");
    expect(col("Q1", "loss_flag_at")).toBe(NOW.toISOString());

    // Forever once: later runs, and even a reopen + lose again, never ask twice.
    await runLossReasonFlags(new Date(NOW.getTime() + 48 * H));
    saveBookings([booking("Q1", "Quote Sent")]);
    saveBookings([booking("Q1", "Lost")]);
    await runLossReasonFlags(new Date(NOW.getTime() + 72 * H));
    expect(taskOps("Q1")).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  it("several due at once go out as one digest post", async () => {
    lostQuote("A");
    lostQuote("B");
    const r = await runLossReasonFlags(NOW);
    expect(r.flagged).toBe(2);
    expect(taskOps()).toHaveLength(2);
    expect(posts).toHaveLength(1);
    expect(String(posts[0].message)).toMatch(/^2 lost quotes/);
  });

  it("holds outside business hours without marking anything", async () => {
    lostQuote("NIGHT");
    const sundayNight = new Date("2026-11-09T03:00:00Z"); // Sun 22:00 ET
    const r = await runLossReasonFlags(sundayNight);
    expect(r.flagged).toBe(0);
    expect(r.detail).toMatch(/held/);
    expect(col("NIGHT", "loss_flag_at")).toBeNull();
    expect((await runLossReasonFlags(NOW)).flagged).toBe(1);
  });

  it("the kill switch turns it all off", async () => {
    process.env.LOSS_REASON_FLAGS = "false";
    lostQuote("OFF");
    const r = await runLossReasonFlags(NOW);
    expect(r.flagged).toBe(0);
    expect(taskOps()).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("never flags a historical lost quote even when the job runs", async () => {
    saveBookings([booking("HIST", "Lost")]);
    await runLossReasonFlags(NOW);
    expect(taskOps()).toHaveLength(0);
  });
});


describe("where the reason lives: Zoe tag and GS note, both ways", () => {
  it("a tag in the app clears the flag", async () => {
    lostQuote("TAG");
    setLossReason("TAG", "Price — too expensive");
    expect((await runLossReasonFlags(NOW)).flagged).toBe(0);
    expect(getBookingById("TAG")?.lossFlagAt).toBeNull();
    expect(getBookingById("TAG")?.lossReasonSource).toBe("app");
  });

  it("a tagged reason is queued into the GS note once, attributed, in the team's note format", () => {
    expect(queueLossReasonNote("P1", "Price — too expensive", "Jessie Medalla", NOW)).toBe(true);
    expect(queueLossReasonNote("P1", "Price — too expensive", "Jessie Medalla", NOW)).toBe(false); // same reason: no double write
    const ops = listPendingGsOps(50).filter((o) => o.op === "note_append" && o.transactionId === "P1");
    expect(ops).toHaveLength(1);
    expect((ops[0].payload as { line: string }).line).toBe("JM(by SalesOS) - 11/10 - Lost reason: Price, too expensive");
    expect(queueLossReasonNote("P1", "Budget cut", "Jessie Medalla", NOW)).toBe(true); // a changed reason is written
  });

  it("a note written after the loss fills the tag from the note, so nobody tags twice", async () => {
    lostQuote("NOTE", "3/2 sent quote");
    saveLeadNotes([{ bookingId: "NOTE", internalNotes: "3/2 sent quote\nClient booked with another company" }]);
    const r = await runLossReasonFlags(NOW);
    expect(r.flagged).toBe(0);
    expect(r.filled).toBe(1);
    const b = getBookingById("NOTE")!;
    expect(b.lossReason).toBe("Went with a competitor");
    expect(b.lossReasonSource).toBe("gs_note");
    expect(b.lossNoteText).toBe("Client booked with another company");
    expect(lossFlagState(b, NOW.getTime())).toBe("tagged");
    // Filled from GS, so nothing is written back to GS.
    expect(listPendingGsOps(50).filter((o) => o.op === "note_append")).toHaveLength(0);
  });

  it("a 'lost' line already in the notes before the flip counts too", async () => {
    lostQuote("PRE", "JA - 11/8 - Lost, too far for delivery", 25);
    await runLossReasonFlags(NOW);
    expect(getBookingById("PRE")?.lossReason).toBe("Out of service area");
    expect(taskOps("PRE")).toHaveLength(0);
  });

  it("an unrecognised reason in the note is kept as Other with the note text", async () => {
    lostQuote("ODD", "old line");
    saveLeadNotes([{ bookingId: "ODD", internalNotes: "old line\nFamily decided to do it themselves" }]);
    await runLossReasonFlags(NOW);
    const b = getBookingById("ODD")!;
    expect(b.lossReason).toBe("Other");
    expect(b.lossNoteText).toBe("Family decided to do it themselves");
  });

  it("lines Zoe appended itself (call and text logs) do not count as a reason", async () => {
    lostQuote("ZOE", "3/2 sent quote");
    const line = "HG(by SalesOS) - 11/10 - Sent text: following up on your quote";
    enqueueGsOp({ op: "note_append", transactionId: "ZOE", payload: { line } });
    saveLeadNotes([{ bookingId: "ZOE", internalNotes: `3/2 sent quote\n\n${line}\nSalesOS - 11/10 - Got voicemail, lost signal` }]);
    expect(fillKnownLossReasons(NOW)).toBe(0);
    expect((await runLossReasonFlags(NOW)).flagged).toBe(1);
  });

  it("a note added after the flag still fills the tag (and stops the notes re-read)", async () => {
    lostQuote("LATE", "old");
    await runLossReasonFlags(NOW);
    expect(lossNoteWatchIds(iso(NOW.getTime() - 14 * 24 * H), 25)).toContain("LATE");
    saveLeadNotes([{ bookingId: "LATE", internalNotes: "old\nThey postponed the event to next year" }]);
    fillKnownLossReasons(NOW);
    expect(getBookingById("LATE")?.lossReason).toBe("Date/event changed or cancelled");
    expect(lossNoteWatchIds(iso(NOW.getTime() - 14 * 24 * H), 25)).not.toContain("LATE");
  });

  it("a quote the Sales Bot marked lost gets its reason filled and written to the GS note, no nag", async () => {
    saveBookings([booking("BOT", "Quote Sent")]);
    expect(queueMarkLost("BOT", "unsigned 3 days before the event").queued).toBe(true);
    saveBookings([booking("BOT", "Lost")]);
    setTrackAt("BOT", iso(NOW.getTime() - 25 * H));
    expect((await runLossReasonFlags(NOW)).flagged).toBe(0);
    const b = getBookingById("BOT")!;
    expect(b.lossReason).toBe(SALES_BOT_LOSS_REASON);
    expect(b.lossReasonSource).toBe("sales_bot");
    const note = listPendingGsOps(50).find((o) => o.op === "note_append" && o.transactionId === "BOT");
    expect((note?.payload as { line: string }).line).toBe("SalesOS - 11/10 - Lost reason: Not signed by the cutoff");
  });
});

describe("pure helpers", () => {
  it("lossFlagState covers every state", () => {
    const t = NOW.getTime();
    const base = { lossReason: null, lossTrackAt: null, lossFlagAt: null, lossNoteAt: null };
    expect(lossFlagState(base, t)).toBe("untracked");
    expect(lossFlagState({ ...base, lossTrackAt: iso(t - H) }, t)).toBe("waiting");
    expect(lossFlagState({ ...base, lossTrackAt: iso(t - 30 * H) }, t)).toBe("due");
    expect(lossFlagState({ ...base, lossTrackAt: iso(t - 30 * H), lossFlagAt: iso(t) }, t)).toBe("flagged");
    expect(lossFlagState({ ...base, lossTrackAt: iso(t - 30 * H), lossFlagAt: iso(t), lossNoteAt: iso(t) }, t)).toBe("noted");
    expect(lossFlagState({ ...base, lossTrackAt: iso(t - 30 * H), lossReason: "Budget cut" }, t)).toBe("tagged");
  });

  it("noteLossReason ignores old lines, Zoe lines and noise", () => {
    expect(noteLossReason("a line", "a line", [])).toBeNull();
    expect(noteLossReason("a line", "a line\n.", [])).toBeNull();
    expect(noteLossReason("x", "x\nzoe log here", ["zoe log here"])).toBeNull();
    expect(noteLossReason(null, "Went with another company", [])).toEqual({ text: "Went with another company", reason: "Went with a competitor" });
  });

  it("classifyLossReason maps common rep wording onto the vocabulary", () => {
    const cases: [string, string | null][] = [
      ["Lost, went with a cheaper vendor", "Went with a competitor"],
      ["too expensive for them", "Price — too expensive"],
      ["their budget got cut", "Budget cut"],
      ["we were sold out of chiavari chairs", "Availability — we couldn't fulfill"],
      ["event cancelled", "Date/event changed or cancelled"],
      ["never heard back after 3 follow ups", "No response — ghosted"],
      ["out of our service area", "Out of service area"],
      ["duplicate of another project", "Duplicate / test"],
      ["family will do it themselves", null],
    ];
    for (const [text, want] of cases) expect(classifyLossReason(text)).toBe(want);
    for (const [, want] of cases) if (want) expect(LOSS_REASONS).toContain(want);
  });

  it("the Slack copy and task text are short house style: no dashes, no emoji", () => {
    const b = { ...booking("S1", "Lost"), signed: false } as unknown as Parameters<typeof lossFlagMessage>[0][number];
    for (const msg of [lossFlagMessage([b], "https://app/salesos/lost"), lossFlagMessage([b, b], null), LOSS_TASK_TITLE]) {
      expect(msg).not.toMatch(/[—–]| - /);
      expect(msg).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
