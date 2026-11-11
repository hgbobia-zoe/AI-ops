import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture Slack posts instead of hitting the network.
const posts: { to: string; card?: unknown; text: string }[] = [];
let channelPostOk = true;
vi.mock("@/lib/notify/slack", () => ({
  slackBotConfigured: () => true,
  slackConfigured: () => true,
  slackPostAs: async (channel: string, _persona: unknown, text: string) => {
    posts.push({ to: channel, text });
    return channelPostOk ? { ok: true } : { ok: false, error: "post: not_in_channel" };
  },
}));
vi.mock("@/lib/notify/aiBots", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    botAnnounce: async (bot: string, card: unknown) => {
      posts.push({ to: `bot:${bot}`, card, text: "" });
      return { ok: true };
    },
  };
});

import { getDb } from "@/lib/db";
import { saveBookings, saveLeadNotes, type BookingRecord } from "@/lib/db/repo";
import { buildSignedCard, isTestProject, runSignedAlerts, weekStartYmd } from "./signedAlert";
import { todayInOpsTz } from "@/lib/dates";

// DATABASE_PATH is ":memory:" (vitest.config.ts).
function project(id: string, over: Partial<BookingRecord> = {}): BookingRecord {
  return {
    bookingId: id,
    eventName: "Rivera Wedding",
    eventDate: "2099-06-12",
    statusLabel: "Quote Sent",
    signed: false,
    grandTotal: 8450,
    amountPaid: 0,
    amountDue: 8450,
    clientName: "Maria Rivera",
    venue: "Stone Tower Winery",
    salesLead: "Jessie Medalla",
    quoteSentDate: "2026-11-05",
    dateCreated: "2026-10-01",
    ...over,
  };
}
const sign = (id: string, over: Partial<BookingRecord> = {}) =>
  saveBookings([project(id, { statusLabel: "Contract Signed", signed: true, amountPaid: 4225, amountDue: 4225, ...over })]);

beforeEach(() => {
  posts.length = 0;
  channelPostOk = true;
  getDb().prepare("DELETE FROM bookings").run();
});
afterEach(() => {
  delete process.env.SIGNED_CARD;
});

describe("contract signed card", () => {
  it("posts once when a quote becomes signed", async () => {
    saveBookings([project("S1")]);
    sign("S1");
    expect(await runSignedAlerts()).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].to).toBe("quote-signed");
    expect(posts[0].text).toContain("🎉 Contract signed: Rivera Wedding");
    expect(posts[0].text).toContain("Jessie Medalla closed it.");
    // Later pulls, and the project flipping back and signing again, never post twice.
    sign("S1");
    saveBookings([project("S1")]);
    sign("S1");
    expect(await runSignedAlerts()).toBe(0);
    expect(posts).toHaveLength(1);
  });

  it("never announces projects that were already signed when first seen", async () => {
    sign("OLD1"); // first time we see it, created long ago
    sign("OLD1");
    expect(await runSignedAlerts()).toBe(0);
  });

  it("announces a brand new project created and signed between two pulls", async () => {
    sign("NEW1", { dateCreated: todayInOpsTz() });
    expect(await runSignedAlerts()).toBe(1);
  });

  it("skips TEST 1/2/3", async () => {
    saveBookings([project("T1", { eventName: "TEST 3" })]);
    sign("T1", { eventName: "TEST 3" });
    expect(await runSignedAlerts()).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it("falls back to the Sales Bot channel when #quote-signed can't be reached", async () => {
    channelPostOk = false;
    saveBookings([project("F1")]);
    sign("F1");
    expect(await runSignedAlerts()).toBe(1);
    expect(posts.map((p) => p.to)).toEqual(["quote-signed", "bot:sales"]);
  });

  it("has a kill switch", async () => {
    process.env.SIGNED_CARD = "false";
    saveBookings([project("K1")]);
    sign("K1");
    expect(await runSignedAlerts()).toBe(0);
  });

  it("stamps an old signing silently instead of posting it late", async () => {
    saveBookings([project("ST1")]);
    sign("ST1");
    const threeDaysLater = new Date(Date.now() + 3 * 86_400_000);
    expect(await runSignedAlerts(threeDaysLater)).toBe(0);
    expect(await runSignedAlerts()).toBe(0);
  });
});

describe("buildSignedCard", () => {
  const now = new Date("2026-11-11T19:14:00Z"); // Wed, 2:14 PM Eastern
  const base = {
    bookingId: "231000001",
    eventName: "Rivera Wedding",
    eventDate: "2027-06-12",
    clientName: "Maria Rivera",
    venue: "Stone Tower Winery",
    location: "Leesburg, VA",
    salesLead: "Jessie Medalla",
    grandTotal: 8450,
    amountPaid: 4225,
    amountDue: 4225,
    quoteSentDate: "2026-11-05",
    delivers: null,
    eventStart: null,
    signedAt: now.toISOString(),
  };

  it("shows who closed it, the facts, and the weekly tally", () => {
    const card = buildSignedCard(base, { count: 3, total: 21300 }, now);
    expect(card.title).toBe("Contract signed: Rivera Wedding");
    expect(card.emoji).toBe("🎉");
    expect(card.subtitle).toBe("Jessie Medalla closed it. Quote sent Thu, Nov 5, signed today (6 days).");
    expect(card.fields).toEqual([
      { label: "Client", value: "Maria Rivera" },
      { label: "Delivery / pickup", value: "Sat, Jun 12, 2027 (213 days out)" },
      { label: "Venue", value: "Stone Tower Winery" },
      { label: "Contract total", value: "$8,450" },
    ]);
    expect(card.body).toBe("Nice work, Jessie. That makes 3 signed this week for $21,300.");
    expect(card.link?.url).toBe("https://pro.goodshuffle.com/app/project/detail?id=231000001");
  });

  it("never shows the deposit or balance, and handles the first signing of the week", () => {
    const card = buildSignedCard({ ...base, amountPaid: 0, amountDue: 8450 }, { count: 1, total: 8450 }, now);
    expect(card.fields?.map((f) => f.label)).toEqual(["Client", "Delivery / pickup", "Venue", "Contract total"]);
    expect(card.body).toBe("Nice work, Jessie. That's the first one signed this week.");
  });

  it("works without a sales lead or quote date", () => {
    const card = buildSignedCard({ ...base, salesLead: null, quoteSentDate: null }, { count: 2, total: 9000 }, now);
    expect(card.subtitle).toBe("Signed today.");
    expect(card.body).toBe("That makes 2 signed this week for $9,000.");
  });
});

describe("amounts and dates", () => {
  it("a pull that can't see pricing never blanks the stored amounts, so the card keeps its total", async () => {
    saveBookings([project("A1")]);
    // A sync from a Goodshuffle login without pricing: same project, no amounts.
    sign("A1", { grandTotal: undefined, contractTotal: undefined, amountPaid: undefined, amountDue: undefined });
    expect(await runSignedAlerts()).toBe(1);
    expect(posts[0].text).toContain("Contract total: $8,450");
    // A second signing: the weekly tally adds the real totals, never $0.
    saveBookings([project("A2")]);
    sign("A2", { grandTotal: undefined, contractTotal: undefined, amountPaid: undefined, amountDue: undefined });
    expect(await runSignedAlerts()).toBe(1);
    expect(posts[1].text).toContain("That makes 2 signed this week for $16,900.");
  });

  it("labels the date by what it is", () => {
    const c = { bookingId: "1", eventName: "X", eventDate: "2027-06-12", clientName: "C", venue: null, location: null, salesLead: null, grandTotal: 100, amountPaid: 0, amountDue: 100, quoteSentDate: null, eventStart: null, signedAt: new Date().toISOString() };
    const label = (delivers: number | null) => buildSignedCard({ ...c, delivers }, { count: 1, total: 100 }).fields?.[1].label;
    expect(label(1)).toBe("Delivery");
    expect(label(0)).toBe("Customer pickup");
    expect(label(null)).toBe("Delivery / pickup");
  });

  it("leads with the real event date and time, then the logistics day when it differs", () => {
    const now = new Date("2026-11-11T22:14:00Z");
    const c = { bookingId: "1", eventName: "X", eventDate: "2026-11-13", clientName: "C", venue: null, location: null, salesLead: null, grandTotal: 108.01, amountPaid: 0, amountDue: 0, quoteSentDate: null, delivers: null, signedAt: now.toISOString() };
    const card = buildSignedCard({ ...c, eventStart: "2026-11-14T15:30:00.000Z" }, { count: 1, total: 108.01 }, now);
    expect(card.fields?.slice(1, 3)).toEqual([
      { label: "Event date", value: "Sat, Nov 14, 2026, 10:30 AM (3 days out)" },
      { label: "Delivery / pickup", value: "Fri, Nov 13" },
    ]);
    // Same day as the logistics date: just the event line.
    const same = buildSignedCard({ ...c, eventDate: "2026-11-14", eventStart: "2026-11-14T23:00:00.000Z" }, { count: 1, total: 1 }, now);
    expect(same.fields?.map((f) => f.label)).toEqual(["Client", "Event date", "Contract total"]);
    expect(same.fields?.[1].value).toBe("Sat, Nov 14, 2026, 6:00 PM (3 days out)");
  });

  it("the event date captured with the lead notes reaches the card, and a later empty capture keeps it", async () => {
    saveBookings([project("E1", { eventDate: "2099-06-11" })]);
    saveLeadNotes([{ bookingId: "E1", eventStart: "2099-06-12T22:00:00.000Z", eventEnd: "2099-06-13T03:00:00.000Z" }]);
    saveLeadNotes([{ bookingId: "E1", eventStart: null }]); // a capture without the project dates
    sign("E1", { eventDate: "2099-06-11" });
    expect(await runSignedAlerts()).toBe(1);
    expect(posts[0].text).toContain("Event date: Fri, Jun 12, 2099, 6:00 PM");
    expect(posts[0].text).toContain("Delivery / pickup: Thu, Jun 11");
  });
});

describe("helpers", () => {
  it("weeks start on Monday", () => {
    expect(weekStartYmd("2026-11-11")).toBe("2026-11-09"); // Wed
    expect(weekStartYmd("2026-11-09")).toBe("2026-11-09"); // Mon
    expect(weekStartYmd("2026-11-15")).toBe("2026-11-09"); // Sun
  });
  it("spots test projects", () => {
    expect(isTestProject("TEST 1")).toBe(true);
    expect(isTestProject("test 2")).toBe(true);
    expect(isTestProject("Testa Wedding")).toBe(false);
    expect(isTestProject("Rivera Wedding")).toBe(false);
  });
});
