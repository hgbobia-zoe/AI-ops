import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/comms/openphoneSync", () => ({ ensureLeadThreadSynced: vi.fn() }));
vi.mock("@/lib/comms/openphone", () => ({ getOpenphonePhoneNumbers: vi.fn(), listOpenphoneCalls: vi.fn(), openphoneApiKey: () => null }));
vi.mock("@/lib/notify/aiBots", () => ({ botAnnounce: vi.fn(), appUrl: () => null }));

import { nextSendDay, senderFirstName, randomSendTime, clockLabel, gateLead, whereWeAre, projectCard, type GateInput, type MorningPlanRow } from "./morningOutreach";
import type { TimelineEntry } from "./timeline";

const NOW = Date.parse("2026-11-03T20:00:00Z"); // Tue 3pm ET
const e = (over: Partial<TimelineEntry>): TimelineEntry => ({ at: null, channel: "sms", direction: null, actor: null, title: "", source: "comms_events", ...over });
const gate = (over: Partial<GateInput> = {}): GateInput => ({ hasPhone: true, daysToEvent: 30, subStatus: "follow_up", timeline: [], liveCalls: [], now: NOW, ...over });

describe("send time", () => {
  it("is the next Monday to Saturday morning once today's window has passed, never Sunday", () => {
    expect(nextSendDay(new Date("2026-11-03T20:00:00Z"))).toBe("2026-11-04"); // Tue 3pm -> Wed
    expect(nextSendDay(new Date("2026-11-03T13:00:00Z"))).toBe("2026-11-03"); // Tue 8am -> today
    expect(nextSendDay(new Date("2026-11-06T20:00:00Z"))).toBe("2026-11-07"); // Fri 3pm -> Sat
    expect(nextSendDay(new Date("2026-11-07T13:00:00Z"))).toBe("2026-11-07"); // Sat 8am -> today
    expect(nextSendDay(new Date("2026-11-07T20:00:00Z"))).toBe("2026-11-09"); // Sat 3pm -> Mon
    expect(nextSendDay(new Date("2026-11-08T13:00:00Z"))).toBe("2026-11-09"); // Sun -> Mon
  });

  it("signs as the project's sales lead, else the fallback, else Zoe Events", () => {
    expect(senderFirstName("Jessie Medalla", "Pat")).toBe("Jessie");
    expect(senderFirstName(null, "Pat")).toBe("Pat");
    expect(senderFirstName("  ", null)).toBeNull();
  });

  it("always lands between 9:12:00 and 9:17:59 Eastern, across DST", () => {
    for (const day of ["2026-11-04", "2026-07-15"]) {
      for (const r of [0, 0.25, 0.5, 0.999999]) {
        const iso = randomSendTime(day, () => r);
        const label = clockLabel(iso);
        expect(label).toMatch(/^9:1[2-7]:\d\d AM$/);
        expect(iso.slice(0, 10)).toBe(day);
      }
    }
    expect(clockLabel(randomSendTime("2026-11-04", () => 0))).toBe("9:12:00 AM");
    expect(clockLabel(randomSendTime("2026-11-04", () => 0.999999))).toBe("9:17:59 AM");
  });
});

describe("gateLead", () => {
  it("texts a quiet lead with an old last touch", () => {
    const tl = [e({ at: "2026-10-28T15:00:00Z", direction: "out", channel: "sms", detail: "Hi, checking in" })];
    expect(gateLead(gate({ timeline: tl }))).toEqual({ send: true, reason: null });
  });

  it("holds back without a phone, past events and events too close", () => {
    expect(gateLead(gate({ hasPhone: false })).send).toBe(false);
    expect(gateLead(gate({ daysToEvent: -1 })).reason).toContain("passed");
    expect(gateLead(gate({ daysToEvent: 2 })).reason).toContain("in 2 days");
  });

  it("holds back when the client is waiting on us", () => {
    const tl = [
      e({ at: "2026-11-01T15:00:00Z", direction: "in", channel: "sms", detail: "Can we add 2 more tables?" }),
      e({ at: "2026-10-28T15:00:00Z", direction: "out", channel: "sms", detail: "Hi" }),
    ];
    const r = gateLead(gate({ timeline: tl }));
    expect(r.send).toBe(false);
    expect(r.reason).toContain("2 more tables");
  });

  it("treats a bare thank you as closure, not as the client waiting", () => {
    for (const thanks of ["Thank you", "Okay thank you", "ok, thanks!", "Thank you so much 🙏", "Sounds good, thank you."]) {
      const tl = [
        e({ at: "2026-10-30T15:00:00Z", direction: "in", channel: "sms", detail: thanks }),
        e({ at: "2026-10-29T15:00:00Z", direction: "out", channel: "sms", detail: "Here is your updated quote" }),
      ];
      expect(gateLead(gate({ timeline: tl })), thanks).toEqual({ send: true, reason: null });
      expect(gateLead(gate({ timeline: tl, subStatus: "action_needed" })).send, thanks).toBe(true);
    }
  });

  it("still holds when the thanks comes with a question, or follows an unanswered question", () => {
    const withQ = [e({ at: "2026-10-30T15:00:00Z", direction: "in", channel: "sms", detail: "Thank you, can we add chairs?" })];
    expect(gateLead(gate({ timeline: withQ })).reason).toContain("waiting on us");
    const afterQ = [
      e({ at: "2026-10-30T16:00:00Z", direction: "in", channel: "sms", detail: "Thank you" }),
      e({ at: "2026-10-30T15:00:00Z", direction: "in", channel: "sms", detail: "Can we add 2 more tables?" }),
      e({ at: "2026-10-29T15:00:00Z", direction: "out", channel: "sms", detail: "Hi" }),
    ];
    const r = gateLead(gate({ timeline: afterQ }));
    expect(r.send).toBe(false);
    expect(r.reason).toContain("2 more tables");
  });

  it("a thank you right after our text still waits out the recent outreach window", () => {
    const tl = [
      e({ at: "2026-11-03T15:00:00Z", direction: "in", channel: "sms", detail: "Thank you" }),
      e({ at: "2026-11-03T14:00:00Z", direction: "out", channel: "sms", detail: "Hi" }),
    ];
    expect(gateLead(gate({ timeline: tl })).reason).toContain("already reached out");
  });

  it("does not treat a quote open as the client talking", () => {
    const tl = [
      e({ at: "2026-11-01T15:00:00Z", direction: "in", channel: "quote", title: "Client opened the quote" }),
      e({ at: "2026-10-28T15:00:00Z", direction: "out", channel: "quote", title: "Quote emailed" }),
    ];
    expect(gateLead(gate({ timeline: tl })).send).toBe(true);
  });

  it("holds back after a recent outbound, including a live Quo call the stored feed missed", () => {
    expect(gateLead(gate({ liveCalls: [{ direction: "out", at: "2026-11-03T14:00:00Z", secs: 30 }] })).reason).toContain("6h ago");
    expect(gateLead(gate({ liveCalls: [{ direction: "in", at: "2026-11-03T14:00:00Z", secs: 120 }] })).reason).toContain("waiting on us");
  });

  it("trusts Quo's live direction over a stored call logged the wrong way (Ana Flores)", () => {
    const tl = [
      e({ at: "2026-10-28T18:16:38Z", direction: "in", channel: "call", detail: "This call had no actionable details to summarize." }),
      e({ at: "2026-10-23T14:50:00Z", direction: "out", channel: "sms", detail: "Hi Ana, weekly follow up" }),
      e({ at: "2026-09-24T15:00:00Z", direction: "in", channel: "sms", detail: "Are you able to resend that email?" }),
    ];
    expect(gateLead(gate({ timeline: tl })).reason).toContain("waiting on us"); // the stored row alone misleads
    const r = gateLead(gate({ timeline: tl, liveCalls: [{ direction: "out", at: "2026-10-28T18:16:10Z", secs: 20 }] }));
    expect(r).toEqual({ send: true, reason: null });
  });

  it("respects opt outs and clear no's, but not 'stop by'", () => {
    const old = "2026-10-20T15:00:00Z";
    const said = (detail: string) => gate({ timeline: [e({ at: "2026-10-25T15:00:00Z", direction: "out", detail: "Hi" }), e({ at: old, direction: "in", detail })] });
    expect(gateLead(said("STOP")).reason).toContain("stop");
    expect(gateLead(said("Thanks but we went with another company")).reason).toContain("went with another");
    expect(gateLead(said("I can stop by Friday to look")).send).toBe(true);
  });

  it("stops chasing after too many unanswered follow ups", () => {
    const tl = [1, 2, 3, 4, 5].map((d) => e({ at: `2026-10-${String(10 + d).padStart(2, "0")}T15:00:00Z`, direction: "out", detail: "Hi" })).reverse();
    expect(gateLead(gate({ timeline: tl })).reason).toContain("5 follow ups");
  });
});

describe("recap", () => {
  it("summarizes where we are from facts only", () => {
    const tl = [
      e({ at: "2026-10-28T15:00:00Z", direction: "out", channel: "sms", detail: "Hi" }),
      e({ at: "2026-10-20T15:00:00Z", direction: "in", channel: "sms", detail: "Need to check with my husband" }),
      e({ at: "2026-10-14T12:00:00Z", direction: "in", channel: "quote", title: "Client opened the quote" }),
      e({ at: null, channel: "note", rawDate: "10/21", detail: "HG 10/21 left vm" }),
    ];
    const lines = whereWeAre({ value: 4200, quoteSentDate: "2026-10-13", eventDate: "2026-11-22", daysToEvent: 19, timeline: tl, liveCalls: [], now: NOW });
    expect(lines.join(" ")).toContain("Quote for $4,200 sent Oct 13 (21 days ago), opened Oct 14");
    expect(lines.join(" ")).toContain('Last from the client: text on Oct 20, "Need to check with my husband"');
    expect(lines.join(" ")).toContain("Last from us: text on Oct 28");
    expect(lines.join(" ")).toContain("1 touch from us since they last replied");
    expect(lines.join(" ")).toContain('Latest note (10/21): "HG 10/21 left vm"');
  });

  it("renders the per project card in the owner's format", () => {
    const row: MorningPlanRow = {
      leadId: "1", eventName: "Smith Wedding", clientName: "Jane Smith", stageLabel: "Follow up", subStatusLabel: "Needs follow-up", value: 4200,
      whereWeAre: ["Quote sent."], context: { quoTexts: 3, quoCalls: 1, liveCalls: 1, emails: 2, notes: 1 },
      send: true, reason: null, draft: "Hi Jane, it's Zoe Events", caution: null, draftSource: "ai", sendAt: "2026-11-04T14:14:37Z",
      salesLead: "Jessie Medalla", signedAs: "Jessie",
    };
    const c = projectCard(row);
    expect(c.title).toBe("Smith Wedding - Jane Smith");
    expect(c.sections?.[0]).toContain("Based on context we are here");
    expect(c.sections?.[1]).toContain("Sales Bot would have sent this* (text at 9:14:37 AM, as Jessie)");
    expect(c.subtitle).toContain("Sales lead: Jessie Medalla");
    expect(projectCard({ ...row, send: false, draft: null, reason: "No phone number on file." }).sections?.[1]).toContain("would not text this one");
  });
});
