import { describe, it, expect } from "vitest";
import { buildLeadScoreboard, leadChannel, isTestLead, type LeadRecord } from "./leadSources";

const TZ = "America/New_York";
const TODAY = "2026-11-03";

function rec(receivedAt: string, channel: string, email = "", phone = "", name = "Client", isTest = false): LeadRecord {
  return { receivedAt, channel, email, phone, name, isTest };
}

function ch(sb: ReturnType<typeof buildLeadScoreboard>, key: string) {
  return sb.channels.find((c) => c.key === key)!;
}

describe("leadChannel", () => {
  it("maps source tags onto channels", () => {
    expect(leadChannel("yelp")?.key).toBe("yelp");
    expect(leadChannel("google_ads")?.key).toBe("google");
    expect(leadChannel("web")?.key).toBe("website");
    expect(leadChannel("contact_form")?.key).toBe("website");
    expect(leadChannel("wishlist")?.key).toBe("wishlist");
    expect(leadChannel("zoeeventsdmv.com")?.key).toBe("website");
    expect(leadChannel("www.zoeeventsdmv.com")?.key).toBe("website");
  });

  it("leaves out intakes typed in by sales", () => {
    expect(leadChannel("manual")).toBeNull();
    expect(leadChannel("quo")).toBeNull();
    expect(leadChannel(null)).toBeNull();
  });

  it("keeps an unknown source as its own channel", () => {
    expect(leadChannel("the_knot")).toEqual({ key: "the_knot", label: "The Knot" });
  });
});

describe("isTestLead", () => {
  it("catches the team's real test submissions", () => {
    expect(isTestLead({ name: "Pat Staff", email: "pat.staff@zoeeventsdmv.com", message: "wedding venue" })).toBe(true);
    expect(isTestLead({ name: "Zoetest Webform", email: "someone@example.com" })).toBe(true);
    expect(isTestLead({ name: "Sam Owner", email: "someone@gmail.com", message: "test" })).toBe(true);
    expect(isTestLead({ name: "Pat Staff", email: "x@gmail.com", message: "hello test" })).toBe(true);
    expect(isTestLead({ name: "H G", email: "x@gmail.com", message: "Test event automation" })).toBe(true);
  });

  it("does not flag real customers", () => {
    expect(isTestLead({ name: "Dana Rivers", email: "dana.rivers@mail.com", message: "Approximately 75 guests" })).toBe(false);
    expect(isTestLead({ name: "Lee K.", email: "leadsapi+abc123@messaging.yelp.com", message: "Yelp request: chairs" })).toBe(false);
  });
});

describe("buildLeadScoreboard", () => {
  it("always lists the four core channels; an empty channel has no start date", () => {
    const sb = buildLeadScoreboard([], TODAY, TZ);
    expect(sb.channels.map((c) => c.key)).toEqual(["website", "wishlist", "yelp", "google"]);
    expect(sb.hasData).toBe(false);
    expect(ch(sb, "yelp")).toMatchObject({ since: null, prev7: null, allTime: 0 });
    expect(sb.months).toHaveLength(12);
    expect(sb.months[11]).toBe("2026-11");
    expect(sb.months[0]).toBe("2025-12");
  });

  it("buckets by the office day, not the UTC day", () => {
    const sb = buildLeadScoreboard(
      [rec("2026-11-04T03:00:00Z", "website", "a@x.com"), rec("2026-10-28T03:00:00Z", "website", "b@x.com")],
      TODAY,
      TZ,
    );
    expect(ch(sb, "website")).toMatchObject({ last7: 1, prev7: 1 });
  });

  it("counts 7 days, prior 7, 30 days, all time and months", () => {
    const sb = buildLeadScoreboard(
      [
        rec("2026-08-10T15:00:00Z", "website", "old@x.com"),
        rec("2026-10-10T15:00:00Z", "website", "d@x.com"),
        rec("2026-10-25T15:00:00Z", "website", "c@x.com"),
        rec("2026-11-01T15:00:00Z", "website", "b@x.com"),
        rec("2026-11-03T15:00:00Z", "website", "a@x.com"),
      ],
      TODAY,
      TZ,
    );
    const w = ch(sb, "website");
    expect(w).toMatchObject({ last7: 2, prev7: 1, last30: 4, allTime: 5, since: "2026-08-10" });
    expect(w.monthly[11]).toBe(2); // Nov
    expect(w.monthly[10]).toBe(2); // Oct
    expect(w.monthly[8]).toBe(1); // Aug
    expect(sb.total.allTime).toBe(5);
  });

  it("shows the week before a channel's record began as unknown, not zero", () => {
    // Yelp only started reaching the log on Nov 2.
    const sb = buildLeadScoreboard([rec("2026-11-02T23:41:00Z", "yelp", "leadsapi+abc123@messaging.yelp.com")], TODAY, TZ);
    expect(ch(sb, "yelp")).toMatchObject({ last7: 1, prev7: null, since: "2026-11-02" });
  });

  it("counts the same lead once when both Slack and the intake log saw it", () => {
    const sb = buildLeadScoreboard(
      [
        rec("2026-11-03T18:54:52Z", "website", "morgan.lake@mail.com"), // Slack post
        rec("2026-11-03T18:54:55Z", "website", "morgan.lake@mail.com"), // intake row
      ],
      TODAY,
      TZ,
    );
    expect(ch(sb, "website").last7).toBe(1);
    expect(sb.repeatsAll).toBe(1);
  });

  it("merges a wishlist sent twice by the same person by name", () => {
    const sb = buildLeadScoreboard(
      [rec("2026-10-22T22:38:17Z", "wishlist", "", "", "Robin Hale"), rec("2026-10-22T22:44:33Z", "wishlist", "", "", "Robin Hale")],
      TODAY,
      TZ,
    );
    expect(ch(sb, "wishlist").allTime).toBe(1);
  });

  it("counts the same person again after a day, and on another channel", () => {
    const sb = buildLeadScoreboard(
      [
        rec("2026-11-01T14:00:00Z", "website", "same@x.com"),
        rec("2026-11-01T15:00:00Z", "yelp", "same@x.com"),
        rec("2026-11-03T15:00:00Z", "website", "same@x.com"),
      ],
      TODAY,
      TZ,
    );
    expect(ch(sb, "website").allTime).toBe(2);
    expect(ch(sb, "yelp").allTime).toBe(1);
  });

  it("leaves test leads out and counts them", () => {
    const sb = buildLeadScoreboard([rec("2026-11-02T15:00:00Z", "website", "pat@zoeeventsdmv.com", "", "Pat Staff", true)], TODAY, TZ);
    expect(sb.total.allTime).toBe(0);
    expect(sb.testsAll).toBe(1);
    expect(sb.tests30).toBe(1);
  });

  it("never treats leads with no contact or name as repeats", () => {
    const sb = buildLeadScoreboard([rec("2026-11-02T14:00:00Z", "yelp", "", "", ""), rec("2026-11-02T14:01:00Z", "yelp", "", "", "")], TODAY, TZ);
    expect(ch(sb, "yelp").allTime).toBe(2);
  });

  it("lists extra sources after the core channels, busiest first", () => {
    const sb = buildLeadScoreboard(
      [rec("2026-11-01T15:00:00Z", "the_knot", "a@x.com"), rec("2026-11-01T15:00:00Z", "instagram", "b@x.com"), rec("2026-11-02T15:00:00Z", "instagram", "c@x.com")],
      TODAY,
      TZ,
    );
    expect(sb.channels.map((c) => c.key)).toEqual(["website", "wishlist", "yelp", "google", "instagram", "the_knot"]);
  });

  it("ignores future-dated and unparseable rows", () => {
    const sb = buildLeadScoreboard([rec("2026-11-05T15:00:00Z", "website", "a@x.com"), rec("nope", "website", "b@x.com")], TODAY, TZ);
    expect(sb.total.allTime).toBe(0);
  });
});
