import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listPendingGsOps } from "@/lib/db/repo";
import {
  composeTouchpointNote,
  touchpointDedupeKey,
  syncTouchpointNote,
  noteSyncEnabled,
  type Touchpoint,
} from "./noteSync";

// Pure pieces (composer + dedupe key + gate) need no DB. syncTouchpointNote exercises the in-memory DB
// (DATABASE_PATH=":memory:" under vitest), same as the other repo-backed tests.

const base = { transactionId: "TEST-1", dateYmd: "2026-10-09" };

describe("composeTouchpointNote — house style M/D - <initials> <what happened>", () => {
  it("call, outbound conversation with a summary", () => {
    const line = composeTouchpointNote({
      kind: "call", callId: "c1", repInitials: "JM", clientName: "Sarah Lee",
      direction: "outgoing", outcome: "conversation", summary: "Discussed linens and delivery window.", ...base,
    });
    expect(line).toBe('10/9 - JM called Sarah Lee — Discussed linens and delivery window.');
  });

  it("call, outbound voicemail", () => {
    const line = composeTouchpointNote({
      kind: "call", callId: "c2", repInitials: "JM", clientName: "Sarah Lee",
      direction: "outgoing", outcome: "voicemail_left", ...base,
    });
    expect(line).toBe("10/9 - JM called Sarah Lee, left voicemail");
  });

  it("call, inbound voicemail received", () => {
    const line = composeTouchpointNote({
      kind: "call", callId: "c3", repInitials: null, clientName: "Sarah Lee",
      direction: "incoming", outcome: "voicemail_received", ...base,
    });
    expect(line).toBe("10/9 - Zoe team voicemail from Sarah Lee");
  });

  it("call, inbound conversation uses 'spoke with'", () => {
    const line = composeTouchpointNote({
      kind: "call", callId: "c4", repInitials: "HG", clientName: "Sarah Lee",
      direction: "incoming", outcome: "conversation", summary: "Confirmed date.", ...base,
    });
    expect(line).toBe("10/9 - HG spoke with Sarah Lee — Confirmed date.");
  });

  it("text clamps a long snippet", () => {
    const long = "Hi Sarah, just following up on the quote we sent over for your June wedding, let me know if you have any questions at all!";
    const line = composeTouchpointNote({ kind: "text", messageId: "m1", repInitials: "JM", clientName: "Sarah Lee", snippet: long, ...base });
    expect(line.startsWith('10/9 - JM texted Sarah Lee: "')).toBe(true);
    expect(line.length).toBeLessThan(`10/9 - JM texted Sarah Lee: "${long}"`.length);
    expect(line).toContain("…");
  });

  it("email with and without subject", () => {
    expect(composeTouchpointNote({ kind: "email", emailKey: "e1", repInitials: "JM", clientName: "Sarah Lee", subject: "Your Zoe quote", ...base }))
      .toBe("10/9 - JM emailed Sarah Lee (subject: Your Zoe quote)");
    expect(composeTouchpointNote({ kind: "email", emailKey: "e2", repInitials: "JM", clientName: "Sarah Lee", subject: null, ...base }))
      .toBe("10/9 - JM emailed Sarah Lee");
  });

  it("unknown rep → 'Zoe team', unknown client → 'the client'", () => {
    const line = composeTouchpointNote({ kind: "text", messageId: "m2", repInitials: null, clientName: null, snippet: "hi", ...base });
    expect(line).toBe('10/9 - Zoe team texted the client: "hi"');
  });
});

describe("touchpointDedupeKey", () => {
  it("is keyed per touchpoint type + id", () => {
    expect(touchpointDedupeKey({ kind: "call", callId: "c9", repInitials: null, direction: null, outcome: "conversation", ...base } as Touchpoint)).toBe("call:c9");
    expect(touchpointDedupeKey({ kind: "text", messageId: "m9", repInitials: null, snippet: "x", ...base } as Touchpoint)).toBe("sms:m9");
    expect(touchpointDedupeKey({ kind: "email", emailKey: "k9", repInitials: null, ...base } as Touchpoint)).toBe("email:k9");
  });
});

describe("syncTouchpointNote — gate + match + idempotency", () => {
  beforeEach(() => { delete process.env.GS_NOTE_SYNC_ENABLED; });
  afterEach(() => { delete process.env.GS_NOTE_SYNC_ENABLED; });

  const tp = (over: Partial<Touchpoint> = {}): Touchpoint => ({
    kind: "text", messageId: "mdup", transactionId: "TEST-SYNC-1", repInitials: "JM",
    clientName: "Sarah Lee", snippet: "hello", dateYmd: "2026-10-09", ...over,
  } as Touchpoint);

  it("does NOTHING when the gate is off (default)", () => {
    expect(noteSyncEnabled()).toBe(false);
    const res = syncTouchpointNote(tp());
    expect(res).toEqual({ enqueued: false, skipped: "disabled" });
    expect(listPendingGsOps(50).filter((o) => o.transactionId === "TEST-SYNC-1").length).toBe(0);
  });

  it("skips honestly when there is no project match", () => {
    process.env.GS_NOTE_SYNC_ENABLED = "true";
    const res = syncTouchpointNote(tp({ transactionId: "" }));
    expect(res).toEqual({ enqueued: false, skipped: "no project match" });
  });

  it("enqueues one note_append when enabled, and dedupes a repeat", () => {
    process.env.GS_NOTE_SYNC_ENABLED = "true";
    const first = syncTouchpointNote(tp({ messageId: "unique-1" }));
    expect(first.enqueued).toBe(true);

    const second = syncTouchpointNote(tp({ messageId: "unique-1" }));
    expect(second).toEqual({ enqueued: false, skipped: "duplicate" });

    const ops = listPendingGsOps(100).filter((o) => o.op === "note_append" && o.transactionId === "TEST-SYNC-1");
    expect(ops.length).toBe(1);
    const payload = ops[0].payload as { line: string; dedupeKey: string };
    expect(payload.dedupeKey).toBe("sms:unique-1");
    expect(payload.line).toBe('10/9 - JM texted Sarah Lee: "hello"');
  });
});
