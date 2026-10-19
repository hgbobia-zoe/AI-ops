import { describe, it, expect } from "vitest";
import {
  parseIcs,
  icsDateToYmd,
  splitLocation,
  deriveAttributesFromText,
  veventToRaw,
  icsTextToRecords,
  icsFeedsFromEnv,
  icsEventSourceFromText,
  type IcsFeedConfig,
} from "./ics";
import { runSource } from "../ingest";
import { getEvents, getEvent, getEventCount, setEventStatus } from "../store";
import { viewFor } from "../service";
import { syncEventOpportunities } from "@/lib/opportunity/eventBridge";
import { getOpportunityByDedupe, setOpportunityStage } from "@/lib/opportunity/store";
import { singleView } from "@/lib/opportunity/service";

const FEED: IcsFeedConfig = { id: "ics:test-1", name: "Test venue calendar", url: "https://calendar.example.org/events.ics", region: "DMV" };

// A realistic ICS document that exercises folding, DATE vs DATE-TIME, escaping, ORGANIZER CN, a missing
// SUMMARY (must be dropped), and a long-past event (stale).
const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example//Calendar//EN",
  "BEGIN:VEVENT",
  "UID:chd-2027@example.org",
  "SUMMARY:CHD Clinical Conference 2027",
  "DESCRIPTION:National congenital heart disease conference with an exhibit h",
  " all and an evening reception.",
  "DTSTART;VALUE=DATE:20270917",
  "DTEND;VALUE=DATE:20270920",
  "LOCATION:Grand Hyatt Washington\\, 1000 H St NW\\, Washington\\, DC",
  "URL:https://example.org/chd-2027",
  "ORGANIZER;CN=Congenital Heart Disease Alliance:mailto:info@example.org",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:webinar-2027@example.org",
  "SUMMARY:Leadership Online Webinar",
  "DTSTART:20270512T130000Z",
  "DTEND:20270512T150000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:nameless-2027@example.org",
  "DTSTART;VALUE=DATE:20270601",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:past-2020@example.org",
  "SUMMARY:Old Expo 2020",
  "DTSTART;VALUE=DATE:20200110",
  "LOCATION:Baltimore Convention Center, Baltimore, MD",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcs", () => {
  const events = parseIcs(ICS);
  it("extracts every VEVENT (including the nameless one)", () => {
    expect(events).toHaveLength(4);
  });
  it("unfolds RFC 5545 folded lines", () => {
    const chd = events[0];
    expect(chd.description).toBe("National congenital heart disease conference with an exhibit hall and an evening reception.");
  });
  it("captures UID, SUMMARY, URL and the ORGANIZER CN", () => {
    const chd = events[0];
    expect(chd.uid).toBe("chd-2027@example.org");
    expect(chd.summary).toBe("CHD Clinical Conference 2027");
    expect(chd.url).toBe("https://example.org/chd-2027");
    expect(chd.organizer).toBe("Congenital Heart Disease Alliance");
  });
  it("distinguishes DATE from DATE-TIME", () => {
    expect(events[0].dtStartIsDate).toBe(true);
    expect(events[1].dtStartIsDate).toBe(false); // the webinar's datetime
  });
  it("unescapes escaped commas in LOCATION", () => {
    expect(events[0].location).toBe("Grand Hyatt Washington, 1000 H St NW, Washington, DC");
  });
  it("returns [] for non-calendar text", () => {
    expect(parseIcs("just some text")).toEqual([]);
    expect(parseIcs("")).toEqual([]);
  });
});

describe("icsDateToYmd", () => {
  it("parses DATE and DATE-TIME forms", () => {
    expect(icsDateToYmd("20270917")).toBe("2027-09-17");
    expect(icsDateToYmd("20270512T130000Z")).toBe("2027-05-12");
  });
  it("rejects garbage", () => {
    expect(icsDateToYmd("May 2027")).toBeNull();
    expect(icsDateToYmd(null)).toBeNull();
    expect(icsDateToYmd("20271399")).toBeNull();
  });
});

describe("splitLocation", () => {
  it("splits venue / city / state", () => {
    expect(splitLocation("Grand Hyatt Washington, 1000 H St NW, Washington, DC")).toMatchObject({ venue: "Grand Hyatt Washington", city: "Washington", state: "DC" });
    expect(splitLocation("Baltimore Convention Center, Baltimore, MD")).toMatchObject({ city: "Baltimore", state: "MD" });
  });
  it("is honest when there is too little to parse", () => {
    expect(splitLocation(null)).toEqual({ venue: null, city: null, state: null });
    expect(splitLocation("Online")).toEqual({ venue: "Online", city: null, state: null });
  });
});

describe("deriveAttributesFromText", () => {
  it("marks only keywords that literally appear (PRESENT, never ABSENT)", () => {
    const a = deriveAttributesFromText("Evening reception with exhibitors and an outdoor tent");
    expect(a.reception).toBe("PRESENT");
    expect(a.exhibitors).toBe("PRESENT");
    expect(a.outdoor).toBe("PRESENT");
    expect(a.gala).toBeUndefined(); // not mentioned → not fabricated
  });
  it("flags a virtual-only event", () => {
    expect(deriveAttributesFromText("Leadership webinar online only").virtual).toBe("PRESENT");
  });
});

describe("veventToRaw", () => {
  const raws = icsTextToRecords(ICS, FEED);
  it("drops the nameless VEVENT and keeps the rest", () => {
    expect(raws).toHaveLength(3);
    expect(raws.map((r) => r.name)).not.toContain(undefined);
  });
  it("never fabricates attendance and records the listing as a signal (NOT_YET_VERIFIED)", () => {
    const chd = raws.find((r) => r.externalId === "ics:chd-2027@example.org")!;
    expect(chd.expectedAttendance).toBeNull();
    expect(chd.attendanceConfidence).toBe("UNKNOWN");
    expect(chd.verificationStatus).toBe("NOT_YET_VERIFIED");
  });
  it("derives category and a stable dedupe externalId from the UID", () => {
    const chd = raws.find((r) => r.externalId === "ics:chd-2027@example.org")!;
    expect(chd.category).toBe("MEDICAL"); // "clinical" / "heart disease" classifies as a medical conference
    expect(chd.venue).toBe("Grand Hyatt Washington");
    expect(chd.city).toBe("Washington");
    expect(chd.sourceUrl).toBe("https://example.org/chd-2027");
    expect(chd.organization?.name).toBe("Congenital Heart Disease Alliance");
  });
  it("treats an all-day DTEND as exclusive (3-day span, not 4)", () => {
    const chd = raws.find((r) => r.externalId === "ics:chd-2027@example.org")!;
    expect(chd.startDate).toBe("2027-09-17");
    expect(chd.endDate).toBe("2027-09-19"); // DTEND 20270920 pulled back one day
  });
  it("leaves endDate null for a same-day datetime event", () => {
    const web = raws.find((r) => r.externalId === "ics:webinar-2027@example.org")!;
    expect(web.startDate).toBe("2027-05-12");
    expect(web.endDate).toBeNull();
  });
});

describe("icsFeedsFromEnv", () => {
  it("parses a JSON array of feed objects", () => {
    const feeds = icsFeedsFromEnv('[{"id":"ics:a","name":"A","url":"https://a.org/e.ics","region":"DC"}]');
    expect(feeds).toEqual([{ id: "ics:a", name: "A", url: "https://a.org/e.ics", region: "DC" }]);
  });
  it("parses a delimited list and auto-ids bare URLs", () => {
    const feeds = icsFeedsFromEnv("https://venue.example.org/cal.ics\nBaltimore CC | https://bcc.example.org/feed.ics | BALTIMORE");
    expect(feeds).toHaveLength(2);
    expect(feeds[0].url).toBe("https://venue.example.org/cal.ics");
    expect(feeds[1]).toMatchObject({ name: "Baltimore CC", url: "https://bcc.example.org/feed.ics", region: "BALTIMORE" });
  });
  it("is dormant and skips malformed entries", () => {
    expect(icsFeedsFromEnv(undefined)).toEqual([]);
    expect(icsFeedsFromEnv("")).toEqual([]);
    expect(icsFeedsFromEnv("not-a-url")).toEqual([]);
    expect(icsFeedsFromEnv("[bad json")).toEqual([]);
  });
});

describe("ICS pipeline (ingest + derived views)", () => {
  const today = "2026-10-19";

  it("stores normalized events and collapses duplicates on a re-pull (stable UID)", async () => {
    const src = icsEventSourceFromText(FEED, ICS);
    const first = await runSource(src);
    expect(first.discovered).toBe(3); // nameless dropped before storage
    expect(first.stored).toBe(3);
    const afterFirst = getEventCount();

    // Re-pull the identical feed: the UID dedupe key updates in place, never duplicates.
    await runSource(icsEventSourceFromText(FEED, ICS));
    expect(getEventCount()).toBe(afterFirst);
  });

  it("flags stale data honestly (a long-past event derives PAST timing)", () => {
    const past = getEvents().find((e) => e.dedupeKey === "ics:test-1:ics:past-2020@example.org")!;
    expect(past).toBeTruthy();
    const view = viewFor(past, today);
    expect(view.timing.phase).toBe("PAST");
  });

  it("handles missing fields without inventing them (no LOCATION → UNKNOWN region + unknown signals)", () => {
    const web = getEvents().find((e) => e.dedupeKey === "ics:test-1:ics:webinar-2027@example.org")!;
    expect(web.region).toBe("UNKNOWN");
    expect(web.expectedAttendance).toBeNull();
    const view = viewFor(web, today);
    // region + attendance surface as explicit unknowns, not as absent/zero
    expect(view.qualification.unknowns.some((u) => u.key === "attendance")).toBe(true);
    expect(view.qualification.unknowns.some((u) => u.key === "region")).toBe(true);
  });

  it("tempers low-confidence events: commercial score < rental-fit score when facts are unknown", () => {
    const chd = getEvents().find((e) => e.dedupeKey === "ics:test-1:ics:chd-2027@example.org")!;
    const view = viewFor(chd, today);
    expect(view.qualification.rentalFitScore).toBeGreaterThan(0);
    expect(view.qualification.commercialOpportunityScore).toBeLessThan(view.qualification.rentalFitScore);
  });

  it("bridges events into the Opportunity layer and lets a reviewer dismiss one (LOST is terminal)", () => {
    const chd = getEvents().find((e) => e.dedupeKey === "ics:test-1:ics:chd-2027@example.org")!;
    syncEventOpportunities();
    const opp = getOpportunityByDedupe(`event:${chd.id}`)!;
    expect(opp).toBeTruthy();

    setOpportunityStage(opp.id, "LOST");
    const view = singleView(opp.id, today)!;
    expect(view.stage).toBe("LOST");

    // A later re-pull/re-bridge must not resurrect a dismissed opportunity.
    syncEventOpportunities();
    expect(singleView(opp.id, today)!.stage).toBe("LOST");
  });

  it("archives a radar event when a reviewer dismisses it at the event level", () => {
    const chd = getEvents().find((e) => e.dedupeKey === "ics:test-1:ics:chd-2027@example.org")!;
    expect(setEventStatus(chd.id, "ARCHIVED")).toBe(true);
    expect(getEvent(chd.id)!.eventStatus).toBe("ARCHIVED");
  });
});
