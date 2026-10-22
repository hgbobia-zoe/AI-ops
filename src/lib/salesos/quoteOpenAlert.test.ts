import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture notifications instead of hitting the network. The quote-open alert is a SALES notification, so
// (Part C) it routes through the central domain map notify("sales", ...) — we assert the DOMAIN here so the
// routing is covered, not just the text.
const slackPosts: { domain: string; message: unknown }[] = [];
vi.mock("@/lib/notify/channels", () => ({
  notify: async (domain: string, message: unknown) => {
    slackPosts.push({ domain, message });
    return { ok: true } as const;
  },
}));
// The alert's "is Slack reachable at all" gate reads these; keep both on so the fixtures fire.
vi.mock("@/lib/notify/slack", () => ({
  slackBotConfigured: () => true,
  slackConfigured: () => true,
}));

import { saveBookings, saveLeadNotes, pendingQuoteOpenAlerts, markQuoteOpenAlerted } from "@/lib/db/repo";
import { runQuoteOpenAlerts } from "@/lib/salesos/quoteOpenAlert";

// DATABASE_PATH is ":memory:" (vitest.config.ts).
// sentDate = Goodshuffle's AUTHORITATIVE quote-sent marker (quote_sent_date). A genuine send has one; an
// unsent prepared quote (Send-To-Client never clicked) does not. sentAt = the precise message-thread
// timestamp (can be present even when nothing was really sent — that was the bug).
function seed(
  bookingId: string,
  opts: { sentDate?: string | null; sentAt?: string | null; openedAt?: string | null } = {},
): void {
  saveBookings([
    {
      bookingId,
      eventName: "Jane · Wedding",
      clientName: "Jane Doe",
      eventDate: "2027-06-20",
      location: "Bethesda, MD",
      quoteSentDate: opts.sentDate ?? null,
    },
  ]);
  saveLeadNotes([{ bookingId, quoteSentAt: opts.sentAt ?? null, quoteOpenedAt: opts.openedAt ?? null }]);
}
const has = (id: string): boolean => pendingQuoteOpenAlerts().some((c) => c.bookingId === id);

describe("pendingQuoteOpenAlerts", () => {
  it("flags an open more than an hour after a VERIFIED send, with client/context", () => {
    seed("QO-1", { sentDate: "2027-01-01", sentAt: "2027-01-01T10:00:00.000Z", openedAt: "2027-01-01T13:00:00.000Z" });
    const c = pendingQuoteOpenAlerts().find((x) => x.bookingId === "QO-1");
    expect(c).toBeTruthy();
    expect(c?.clientName).toBe("Jane Doe");
    expect(c?.eventName).toBe("Jane · Wedding");
    expect(c?.quoteSentAt).toBe("2027-01-01T10:00:00.000Z");
  });

  it("ignores an open within an hour of send (too early to ping)", () => {
    seed("QO-2", { sentDate: "2027-01-01", sentAt: "2027-01-01T10:00:00.000Z", openedAt: "2027-01-01T10:30:00.000Z" });
    expect(has("QO-2")).toBe(false);
  });

  it("ignores a quote that was never opened", () => {
    seed("QO-3", { sentDate: "2027-01-01", sentAt: "2027-01-01T10:00:00.000Z", openedAt: null });
    expect(has("QO-3")).toBe(false);
  });

  it("stops flagging once alerted, then re-qualifies on a newer open", () => {
    seed("QO-4", { sentDate: "2027-01-01", sentAt: "2027-01-01T10:00:00.000Z", openedAt: "2027-01-01T13:00:00.000Z" });
    expect(has("QO-4")).toBe(true);
    markQuoteOpenAlerted("QO-4", "2027-01-01T13:00:00.000Z");
    expect(has("QO-4")).toBe(false);
    saveLeadNotes([{ bookingId: "QO-4", quoteOpenedAt: "2027-01-02T09:00:00.000Z" }]);
    expect(has("QO-4")).toBe(true);
  });

  // Regression — the proven prod false-positive (2026-10-19). A NEW PROJECT that was never sent to the
  // client has NO authoritative send marker (quote_sent_date / last_sent_date), yet the pull had captured a
  // precise quote_sent_at from a prepared-but-unsent quote email plus an (internal) open. OLD logic fired;
  // honest logic must stay silent — there was no send, so there can be no "Nh after we sent it".
  it("does NOT flag an open when there is no verified send (unsent NEW PROJECT)", () => {
    seed("QO-UNSENT", { sentDate: null, sentAt: "2027-02-01T10:00:00.000Z", openedAt: "2027-02-01T14:00:00.000Z" });
    expect(has("QO-UNSENT")).toBe(false);
  });

  it("flags on last_sent_date alone when the precise timestamp is missing", () => {
    // Authoritative send exists (dateLastSent) but no precise quote_sent_at — anchor falls back to the date.
    saveBookings([{ bookingId: "QO-LSD", clientName: "Lee", eventName: "Gala" }]);
    saveLeadNotes([{ bookingId: "QO-LSD", lastSentDate: "2027-03-01", quoteOpenedAt: "2027-03-03T10:00:00.000Z" }]);
    const c = pendingQuoteOpenAlerts().find((x) => x.bookingId === "QO-LSD");
    expect(c).toBeTruthy();
    expect(c?.quoteSentAt).toBe("2027-03-01T00:00:00Z");
  });

  it("does NOT flag an open at or before the verified send", () => {
    seed("QO-BEFORE", { sentDate: "2027-04-01", sentAt: "2027-04-01T10:00:00.000Z", openedAt: "2027-04-01T09:00:00.000Z" });
    expect(has("QO-BEFORE")).toBe(false);
  });
});

describe("runQuoteOpenAlerts", () => {
  // Opens must be "recent" relative to `now` for the alert to fire, and the business-hours gate reads the
  // same `now` — so anchor the fixtures to a FIXED in-hours instant (Mon 12:00 PM ET = 17:00 UTC in EST),
  // making the suite deterministic regardless of the wall-clock when CI runs.
  const now = Date.parse("2026-01-05T17:00:00.000Z");
  const iso = (ms: number): string => new Date(ms).toISOString();
  const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  // The in-memory DB is shared across tests in this file, so candidates seeded by the pure-filter suite
  // above would also be picked up by runQuoteOpenAlerts. Drain them (mark alerted) so each run test sees
  // only its own fixture, and reset the captured posts.
  beforeEach(() => {
    for (const c of pendingQuoteOpenAlerts()) markQuoteOpenAlerted(c.bookingId, c.quoteOpenedAt);
    slackPosts.length = 0;
  });

  it("fires once, with the correct gap, for a verified send opened >1h later", async () => {
    const sentMs = now - 3 * 3600_000; // 3h ago
    const openedMs = now - 60_000; // ~now (recent)
    seed("RUN-OK", { sentDate: ymd(sentMs), sentAt: iso(sentMs), openedAt: iso(openedMs) });
    const sent = await runQuoteOpenAlerts(now);
    expect(sent).toBe(1);
    expect(slackPosts.length).toBe(1);
    expect(slackPosts[0].domain).toBe("sales"); // routed to sales-ai, not customer-alerts
    expect(String(slackPosts[0].message)).toContain("Jane Doe just opened their quote (3h after we sent it)");
    // Dedup — a second run with no newer open must not re-post.
    const again = await runQuoteOpenAlerts(now);
    expect(again).toBe(0);
    expect(slackPosts.length).toBe(1);
  });

  it("does NOT fire for an unsent project even with a captured timestamp and a recent open", async () => {
    const sentMs = now - 3 * 3600_000;
    const openedMs = now - 60_000;
    // No authoritative send marker → fabricated send, must stay silent.
    seed("RUN-UNSENT", { sentDate: null, sentAt: iso(sentMs), openedAt: iso(openedMs) });
    const sent = await runQuoteOpenAlerts(now);
    expect(sent).toBe(0);
    expect(slackPosts.length).toBe(0);
  });

  it("HOLDS outside business hours (no post) and does NOT drop the candidate", async () => {
    // Sunday 12:00 PM ET (17:00 UTC) — the default schedule is closed on Sunday. The alert must not post,
    // and the candidate must stay PENDING (held, not marked/dropped) so a later in-hours run can surface it.
    const sundayNow = Date.parse("2026-01-04T17:00:00.000Z");
    const sentMs = sundayNow - 3 * 3600_000;
    const openedMs = sundayNow - 60_000;
    seed("RUN-HELD", { sentDate: ymd(sentMs), sentAt: iso(sentMs), openedAt: iso(openedMs) });
    const sent = await runQuoteOpenAlerts(sundayNow);
    expect(sent).toBe(0);
    expect(slackPosts.length).toBe(0);
    expect(has("RUN-HELD")).toBe(true); // still pending — not dropped

    // The SAME candidate fires once we're inside business hours (Mon 12:00 PM ET), proving "held, not dropped".
    const mondayNow = Date.parse("2026-01-05T17:00:00.000Z");
    // Re-anchor the open to be recent relative to Monday so the recency window still qualifies it.
    saveLeadNotes([{ bookingId: "RUN-HELD", quoteOpenedAt: iso(mondayNow - 60_000) }]);
    const sentMon = await runQuoteOpenAlerts(mondayNow);
    expect(sentMon).toBe(1);
    expect(slackPosts.length).toBe(1);
  });
});
