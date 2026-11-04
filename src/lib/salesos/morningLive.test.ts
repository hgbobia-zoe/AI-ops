// Morning outreach LIVE: plan at 8:15, text once at the planned second, recheck before sending, mark lost,
// recap once. The planner, the SMS sender, Quo and Slack are MOCKED: no real text is ever sent.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

vi.mock("./morningOutreach", async (orig) => ({ ...(await orig<typeof import("./morningOutreach")>()), buildMorningPlan: vi.fn() }));
vi.mock("./smsSend", () => ({ sendLeadSms: vi.fn(async () => ({ ok: true, providerMsgId: "PM1" })) }));
vi.mock("./timeline", () => ({ buildLeadTimeline: vi.fn(() => []) }));
vi.mock("@/lib/comms/openphoneSync", () => ({ ensureLeadThreadSynced: vi.fn(async () => ({ inserted: 0 })) }));
vi.mock("@/lib/comms/openphone", () => ({ getOpenphoneUsers: vi.fn(async () => [{ id: "USjm", name: "Jessie Medalla", initials: "JM" }]) }));
vi.mock("@/lib/notify/aiBots", () => ({ botAnnounce: vi.fn(async () => ({ ok: true })), appUrl: () => null }));

import { getDb } from "@/lib/db";
import { saveBookings, listPendingGsOps } from "@/lib/db/repo";
import { setJson } from "@/lib/kv";
import { buildMorningPlan, type MorningPlanRow } from "./morningOutreach";
import { sendLeadSms } from "./smsSend";
import { buildLeadTimeline } from "./timeline";
import { botAnnounce } from "@/lib/notify/aiBots";
import { runMorningOutreachTick, awaitPlanning, rowsFromPlan, getMorningLiveDay, liveRecapCards, liveKey } from "./morningLive";

const DAY = "2026-11-05"; // a Thursday
const at = (et: string) => new Date(`${DAY}T${et}:00-05:00`); // EST
const row = (over: Partial<MorningPlanRow>): MorningPlanRow => ({
  leadId: "L1", eventName: "Chang Party", clientName: "Holly Chang", stageLabel: "Follow up", subStatusLabel: "Needs follow-up", value: 2000,
  whereWeAre: ["Quote for $2,000."], context: { quoTexts: 1, quoCalls: 0, liveCalls: 0, emails: 0, notes: 0 },
  send: true, lose: false, reason: null, draft: "Hi Holly, this is Jessie from Zoe Events. Just checking in.", caution: null, draftSource: "template",
  sendAt: `${DAY}T14:14:37.000Z`, salesLead: "Jessie Medalla", signedAs: "Jessie", ...over,
});
const send = sendLeadSms as unknown as Mock;
const plan = buildMorningPlan as unknown as Mock;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  send.mockClear();
  plan.mockClear();
  (botAnnounce as unknown as Mock).mockClear();
  (buildLeadTimeline as unknown as Mock).mockReset().mockReturnValue([]);
  setJson(liveKey(DAY), null);
  getDb().prepare("DELETE FROM gs_outbox").run();
  getDb().prepare("DELETE FROM bookings").run();
  saveBookings([
    { bookingId: "L1", eventName: "Chang Party", eventDate: "2027-05-01", statusLabel: "Quote Sent", signed: false, grandTotal: 2000, clientName: "Holly Chang", clientEmail: "h@example.com", clientPhone: "+13015550111" },
    { bookingId: "L2", eventName: "Late Event", eventDate: "2026-11-07", statusLabel: "Quote Sent", signed: false, grandTotal: 900, clientName: "Pat Lee", clientEmail: "p@example.com", clientPhone: "+13015550112" },
  ]);
  plan.mockResolvedValue({
    dryRun: true, generatedAt: "", sendDay: DAY, posted: false,
    rows: [row({}), row({ leadId: "L2", clientName: "Pat Lee", eventName: "Late Event", send: false, lose: true, draft: null, sendAt: null, reason: "The event is in 2 days and the quote is not signed. Mark it lost and archive it." })],
  });
  delete process.env.MORNING_OUTREACH_LIVE;
});
afterEach(() => vi.useRealTimers());

describe("morning outreach live", () => {
  it("plans at 8:15, texts once at the planned second as Jessie with a Sales Bot note, marks the late one lost, recaps once", async () => {
    vi.setSystemTime(at("08:00"));
    expect((await runMorningOutreachTick(at("08:00"))).detail).toContain("waiting for 8:15");
    expect(plan).not.toHaveBeenCalled();

    vi.setSystemTime(at("08:20"));
    await runMorningOutreachTick(at("08:20"));
    await awaitPlanning();
    const d = getMorningLiveDay(DAY)!;
    expect(d.status).toBe("ready");
    expect(d.rows.map((r) => [r.leadId, r.status])).toEqual([["L1", "pending"], ["L2", "lost_queued"]]);
    expect(listPendingGsOps().filter((o) => o.op === "mark_lost").map((o) => o.transactionId)).toEqual(["L2"]);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(Date.parse(`${DAY}T14:14:38Z`) - Date.now()); // the timer fires at 9:14:37
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ id: "L1", body: expect.stringContaining("this is Jessie"), userId: "USjm", initials: "Sales Bot" });

    await runMorningOutreachTick(at("09:30"));
    await runMorningOutreachTick(at("09:45"));
    expect(send).toHaveBeenCalledTimes(1); // never twice
    expect(getMorningLiveDay(DAY)!.rows[0].status).toBe("sent");
    expect(getMorningLiveDay(DAY)!.recapPosted).toBe(true);
    const titles = (botAnnounce as unknown as Mock).mock.calls.map((c) => c[1].title);
    expect(titles).toEqual(["Morning outreach: 1 texted, 1 marked lost", "Chang Party - Holly Chang", "Late Event - Pat Lee"]);
  });

  it("skips a client who wrote back since the plan", async () => {
    vi.setSystemTime(at("08:20"));
    await runMorningOutreachTick(at("08:20"));
    await awaitPlanning();
    (buildLeadTimeline as unknown as Mock).mockReturnValue([{ at: `${DAY}T14:00:00Z`, channel: "sms", direction: "in", detail: "Can we add chairs?" }]);
    await vi.advanceTimersByTimeAsync(Date.parse(`${DAY}T14:14:38Z`) - Date.now());
    expect(send).not.toHaveBeenCalled();
    expect(getMorningLiveDay(DAY)!.rows[0]).toMatchObject({ status: "skipped", detail: expect.stringContaining("reached out since the plan") });
  });

  it("after a restart it catches up a missed send before 11, and calls it missed after", async () => {
    vi.setSystemTime(at("08:20"));
    await runMorningOutreachTick(at("08:20"));
    await awaitPlanning();
    vi.clearAllTimers(); // the restart: timers are gone
    (globalThis as unknown as { __morningTimers: Map<string, unknown> }).__morningTimers.clear();
    vi.setSystemTime(at("11:05"));
    await runMorningOutreachTick(at("11:05"));
    expect(send).not.toHaveBeenCalled();
    expect(getMorningLiveDay(DAY)!.rows[0].status).toBe("missed");
  });

  it("does nothing with the kill switch, or on Sunday", async () => {
    process.env.MORNING_OUTREACH_LIVE = "false";
    expect((await runMorningOutreachTick(at("08:20"))).detail).toBe("MORNING_OUTREACH_LIVE off");
    delete process.env.MORNING_OUTREACH_LIVE;
    expect((await runMorningOutreachTick(new Date("2026-11-08T13:20:00Z"))).detail).toContain("Sunday");
    expect(plan).not.toHaveBeenCalled();
  });

  it("caps the texts per day, earliest send time first", () => {
    const rows = rowsFromPlan([row({ leadId: "A", sendAt: `${DAY}T14:16:00Z` }), row({ leadId: "B", sendAt: `${DAY}T14:12:30Z` }), row({ leadId: "C", send: false, draft: null, sendAt: null, reason: "next on Nov 27" })], 1);
    expect(rows.map((r) => [r.leadId, r.status])).toEqual([["A", "held"], ["B", "pending"], ["C", "held"]]);
    expect(rows[0].reason).toContain("Daily cap of 1");
    expect(liveRecapCards({ ymd: DAY, status: "ready", startedAt: "", rows }).at(-1)?.title).toBe("Held back (3)");
  });
});
