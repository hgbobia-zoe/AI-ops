// Post-Event daily nudge — the pure digest builder (sections, service-first placement, caps, wording) and
// the once-a-day runner gates (Sunday, before the hour, window, already sent, nothing due, Slack result).
// DATABASE_PATH is ":memory:" (vitest.config.ts), so the kv "last sent" key lives in a throwaway DB.

import { describe, it, expect, beforeEach } from "vitest";
import { buildDigest, sectionFor, runPostEventDigestIfDue, DIGEST_LAST_KEY } from "./digest";
import { getDb } from "../db/index";
import type { PostEventCard, PostEventState, NextAction, Disposition } from "./types";

function card(over: Partial<PostEventCard> & { bookingId: string }): PostEventCard {
  return {
    bookingId: over.bookingId,
    state: (over.state ?? "needs_follow_up") as PostEventState,
    disposition: (over.disposition ?? null) as Disposition | null,
    nextAction: (over.nextAction ?? "call") as NextAction,
    assignedEmployee: over.assignedEmployee ?? null,
    customer: over.customer ?? `Customer ${over.bookingId}`,
    eventName: over.eventName ?? "Wedding",
    eventDate: over.eventDate ?? null,
    venue: over.venue ?? null,
    pickupAt: over.pickupAt ?? null,
    lastContactAt: null,
    lastContactOutcome: null,
    contactCount: 0,
    respondedCount: 0,
    openIssues: over.openIssues ?? 0,
    daysInStage: over.daysInStage ?? 0,
    stateReason: null,
    dueAt: over.dueAt ?? null,
    dueToday: over.dueToday ?? false,
    overdue: over.overdue ?? false,
    stale: false,
  };
}

const TODAY = "2026-11-03"; // a Tuesday

describe("sectionFor", () => {
  it("puts each card in one service-first section", () => {
    expect(sectionFor(card({ bookingId: "a", openIssues: 1, overdue: true }))).toBe("recover"); // issue beats overdue
    expect(sectionFor(card({ bookingId: "b", nextAction: "escalate" }))).toBe("recover");
    expect(sectionFor(card({ bookingId: "c", overdue: true, dueToday: false }))).toBe("overdue");
    expect(sectionFor(card({ bookingId: "d", dueToday: true }))).toBe("due_today");
    expect(sectionFor(card({ bookingId: "e", state: "experience_confirmed", nextAction: "send_review_request" }))).toBe("invite");
    expect(sectionFor(card({ bookingId: "f", nextAction: "await_response" }))).toBeNull(); // not due yet
    expect(sectionFor(card({ bookingId: "g", state: "closed", openIssues: 2 }))).toBeNull(); // closed is never work
  });
});

describe("buildDigest", () => {
  it("returns null when nothing needs us today", () => {
    expect(buildDigest([card({ bookingId: "x", nextAction: "await_response" })], TODAY)).toBeNull();
    expect(buildDigest([], TODAY)).toBeNull();
  });

  it("orders sections service-first with real counts and names the owner", () => {
    const d = buildDigest(
      [
        card({ bookingId: "1", customer: "Sarah Johnson", eventDate: "2026-10-31", overdue: true, dueAt: "2026-10-31", assignedEmployee: "Jess" }),
        card({ bookingId: "2", openIssues: 1 }),
        card({ bookingId: "3", dueToday: true, dueAt: TODAY }),
        card({ bookingId: "4", state: "experience_confirmed", nextAction: "send_review_request" }),
      ],
      TODAY,
    )!;
    expect(d.total).toBe(4);
    expect(d.sections.map((s) => s.key)).toEqual(["recover", "overdue", "due_today", "invite"]);
    const overdue = d.sections.find((s) => s.key === "overdue")!;
    expect(overdue.lines[0]).toContain("*Sarah Johnson*, Wedding (Sat, Oct 31).");
    expect(overdue.lines[0]).toContain("Next: Call.");
    expect(overdue.lines[0]).toContain("3 days overdue.");
    expect(overdue.lines[0]).toContain("Owner: Jess.");
    expect(d.sections.find((s) => s.key === "due_today")!.lines[0]).toContain("Owner: unassigned.");
    expect(d.card.subtitle).toBe("4 customers need us today: 1 service recovery, 1 overdue, 1 due today, 1 ready for a review invite.");
  });

  it("caps lines per section and says how many more", () => {
    const many = Array.from({ length: 11 }, (_, i) => card({ bookingId: `o${i}`, overdue: true, dueAt: "2026-10-30" }));
    const d = buildDigest(many, TODAY, { maxPerSection: 8 })!;
    expect(d.sections[0].lines).toHaveLength(8);
    expect(d.sections[0].more).toBe(3);
    expect(d.card.sections![0]).toContain("_and 3 more on the board_");
  });

  it("links names and sections when a base URL exists, and escapes Slack control characters", () => {
    const d = buildDigest([card({ bookingId: "9", customer: "A <b> & Co", dueToday: true })], TODAY, { link: (p) => `https://app.test${p}` })!;
    expect(d.card.sections![0]).toContain("<https://app.test/postevent/kanban?queue=due|Due today>");
    expect(d.sections[0].lines[0]).toContain("<https://app.test/postevent/project/9|A &lt;b&gt; &amp; Co>");
    expect(d.card.link?.url).toBe("https://app.test/postevent/kanban");
  });

  it("keeps the copy free of dashes", () => {
    const d = buildDigest([card({ bookingId: "1", openIssues: 2 }), card({ bookingId: "2", dueToday: true })], TODAY)!;
    const text = [d.card.title, d.card.subtitle, ...(d.card.sections ?? []), d.card.body, d.card.context].join("\n");
    expect(text).not.toMatch(/[–—]| - /);
  });
});

describe("runPostEventDigestIfDue", () => {
  // 2026-11-03 is a Tuesday; 14:30Z = 9:30 ET (EST, UTC-5).
  const TUE_930 = new Date("2026-11-03T14:30:00Z");
  const due = () => [card({ bookingId: "1", dueToday: true })];

  beforeEach(() => {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(DIGEST_LAST_KEY);
    delete process.env.POSTEVENT_DAILY_DIGEST;
    delete process.env.POSTEVENT_DIGEST_HOUR;
  });

  it("sends once per day inside the morning window", async () => {
    let sent = 0;
    const announce = async () => ((sent++), { ok: true });
    const r1 = await runPostEventDigestIfDue(TUE_930, { cards: due, announce });
    expect(r1).toEqual({ ok: true, detail: "sent: 1 customer needs follow up" });
    const r2 = await runPostEventDigestIfDue(new Date("2026-11-03T15:00:00Z"), { cards: due, announce });
    expect(r2.detail).toContain("already sent");
    expect(sent).toBe(1);
  });

  it("waits before the hour, skips Sunday, and skips a missed window", async () => {
    let sent = 0;
    const announce = async () => ((sent++), { ok: true });
    expect((await runPostEventDigestIfDue(new Date("2026-11-03T13:00:00Z"), { cards: due, announce })).detail).toBe("waiting for 9:00 ET");
    expect((await runPostEventDigestIfDue(new Date("2026-11-08T15:00:00Z"), { cards: due, announce })).detail).toBe("Sunday, no digest");
    expect((await runPostEventDigestIfDue(new Date("2026-11-03T20:00:00Z"), { cards: due, announce })).detail).toContain("window missed");
    expect(sent).toBe(0);
  });

  it("posts nothing when nothing is due, and honors the kill switch", async () => {
    let sent = 0;
    const announce = async () => ((sent++), { ok: true });
    expect((await runPostEventDigestIfDue(TUE_930, { cards: () => [], announce })).detail).toBe("nothing due today, no post");
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(DIGEST_LAST_KEY);
    process.env.POSTEVENT_DAILY_DIGEST = "false";
    expect((await runPostEventDigestIfDue(TUE_930, { cards: due, announce })).detail).toContain("turned off");
    expect(sent).toBe(0);
  });

  it("retries after a failed post but not when Slack is unconfigured", async () => {
    const fail = await runPostEventDigestIfDue(TUE_930, { cards: due, announce: async () => ({ ok: false, error: "slack 500" }) });
    expect(fail.ok).toBe(false);
    const retry = await runPostEventDigestIfDue(TUE_930, { cards: due, announce: async () => ({ ok: true }) });
    expect(retry.detail).toContain("sent");

    getDb().prepare("DELETE FROM settings WHERE key = ?").run(DIGEST_LAST_KEY);
    const skipped = await runPostEventDigestIfDue(TUE_930, { cards: due, announce: async () => ({ ok: false, skipped: true }) });
    expect(skipped).toEqual({ ok: false, detail: "Slack not configured, digest not sent" });
    expect((await runPostEventDigestIfDue(TUE_930, { cards: due, announce: async () => ({ ok: true }) })).detail).toContain("already sent");
  });

  it("respects a custom send hour", async () => {
    process.env.POSTEVENT_DIGEST_HOUR = "10";
    expect((await runPostEventDigestIfDue(TUE_930, { cards: due, announce: async () => ({ ok: true }) })).detail).toBe("waiting for 10:00 ET");
  });
});
