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
  noteReasonText,
  lossFlagMessage,
  ensureLossBackfill,
  detectLossReasonNotes,
  LOSS_TASK_TITLE,
  DEFAULT_FALLBACK_GS_USER_ID,
} from "./lossReasonFlag";

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
  getDb().prepare("DELETE FROM settings WHERE key = 'lossReason.backfillDone'").run();
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

  it("one-time backfill covers the 30 days before ship, from change history or the created date", () => {
    saveBookings([
      booking("HIST10", "Lost"),
      booking("HIST40", "Lost"),
      booking("NEW5", "Lost", { dateCreated: shiftYmd(todayInOpsTz(NOW), -5) }),
      booking("ANCIENT", "Lost"),
      booking("OPEN", "Quote Sent", { dateCreated: shiftYmd(todayInOpsTz(NOW), -2) }),
    ]);
    const ins = getDb().prepare("INSERT INTO history_changes (id, ts, kind, entity_id, change_key) VALUES (?, ?, 'booking_cancelled', ?, ?)");
    const tenDaysAgo = iso(NOW.getTime() - 10 * 24 * H);
    ins.run("h1", tenDaysAgo, "HIST10", "cancelled|HIST10");
    ins.run("h2", iso(NOW.getTime() - 40 * 24 * H), "HIST40", "cancelled|HIST40");

    expect(ensureLossBackfill(NOW)).toBe(2);
    expect(col("HIST10", "lost_at")).toBe(tenDaysAgo);
    expect(col("HIST10", "loss_track_at")).toBe(NOW.toISOString());
    expect(col("NEW5", "loss_track_at")).toBe(NOW.toISOString());
    expect(col("HIST40", "loss_track_at")).toBeNull();
    expect(col("ANCIENT", "loss_track_at")).toBeNull();
    expect(col("OPEN", "loss_track_at")).toBeNull();
    expect(ensureLossBackfill(NOW)).toBeNull(); // once only
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
    getDb().prepare("UPDATE settings SET value = 'true' WHERE key = 'lossReason.backfillDone'").run();
    await runLossReasonFlags(NOW);
    expect(taskOps()).toHaveLength(0);
  });
});

describe("clear rule: a tag or a GS note written after the loss", () => {
  it("a tag in the app clears it", async () => {
    lostQuote("TAG");
    setLossReason("TAG", "Price — too expensive");
    expect((await runLossReasonFlags(NOW)).flagged).toBe(0);
    expect(getBookingById("TAG")?.lossFlagAt).toBeNull();
  });

  it("a new GS internal note line clears it and is kept as the reason text", async () => {
    lostQuote("NOTE", "3/2 sent quote");
    saveLeadNotes([{ bookingId: "NOTE", internalNotes: "3/2 sent quote\nClient booked a cheaper vendor" }]);
    const r = await runLossReasonFlags(NOW);
    expect(r.flagged).toBe(0);
    expect(r.notesFound).toBe(1);
    const b = getBookingById("NOTE");
    expect(b?.lossNoteText).toBe("Client booked a cheaper vendor");
    expect(lossFlagState(b!, NOW.getTime())).toBe("noted");
  });

  it("lines Zoe appended itself (call and text logs) do not count as a reason", async () => {
    lostQuote("ZOE", "3/2 sent quote");
    const line = "11/10 SB: Sales Bot texted the client a follow up";
    enqueueGsOp({ op: "note_append", transactionId: "ZOE", payload: { line } });
    saveLeadNotes([{ bookingId: "ZOE", internalNotes: `3/2 sent quote\n\n${line}` }]);
    expect(detectLossReasonNotes(NOW)).toBe(0);
    expect((await runLossReasonFlags(NOW)).flagged).toBe(1);
  });

  it("a note added after the flag still clears it (and stops the notes re-read)", async () => {
    lostQuote("LATE", "old");
    await runLossReasonFlags(NOW);
    expect(lossNoteWatchIds(iso(NOW.getTime() - 14 * 24 * H), 25)).toContain("LATE");
    saveLeadNotes([{ bookingId: "LATE", internalNotes: "old\nThey postponed the event to next year" }]);
    detectLossReasonNotes(NOW);
    expect(lossFlagState(getBookingById("LATE")!, NOW.getTime())).toBe("noted");
    expect(lossNoteWatchIds(iso(NOW.getTime() - 14 * 24 * H), 25)).not.toContain("LATE");
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

  it("noteReasonText ignores old lines, Zoe lines and noise", () => {
    expect(noteReasonText("a line", "a line", [])).toBeNull();
    expect(noteReasonText("a line", "a line\n.", [])).toBeNull();
    expect(noteReasonText(null, "Went with another company", [])).toBe("Went with another company");
    expect(noteReasonText("x", "x\nzoe log", ["zoe log"])).toBeNull();
  });

  it("the Slack copy is short house style: no dashes, no emoji", () => {
    const b = { ...booking("S1", "Lost"), signed: false } as unknown as Parameters<typeof lossFlagMessage>[0][number];
    for (const msg of [lossFlagMessage([b], "https://app/salesos/lost"), lossFlagMessage([b, b], null)]) {
      expect(msg).not.toMatch(/[—–]| - /);
      expect(msg).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    expect(LOSS_TASK_TITLE).not.toMatch(/[—–]| - /);
  });
});
