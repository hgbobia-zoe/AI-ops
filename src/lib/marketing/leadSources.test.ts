import { describe, it, expect } from "vitest";
import { buildLeadScoreboard, leadChannel, type InboundLeadRow } from "./leadSources";

const TZ = "America/New_York";
const TODAY = "2026-11-03";

function row(createdAt: string, source: string | null, email = "", phone = ""): InboundLeadRow {
  return { createdAt, source, email, phone };
}

function channel(sb: ReturnType<typeof buildLeadScoreboard>, key: string) {
  return sb.channels.find((c) => c.key === key)!;
}

describe("leadChannel", () => {
  it("maps the Zap source tags onto channels", () => {
    expect(leadChannel("yelp")?.key).toBe("yelp");
    expect(leadChannel("google_ads")?.key).toBe("google");
    expect(leadChannel("Google Business Profile")?.key).toBe("google");
    expect(leadChannel("web")?.key).toBe("website");
    expect(leadChannel("website")?.key).toBe("website");
    expect(leadChannel("contact_form")?.key).toBe("website");
  });

  it("leaves out intakes typed in by sales", () => {
    expect(leadChannel("manual")).toBeNull();
    expect(leadChannel("quo")).toBeNull();
    expect(leadChannel(null)).toBeNull();
    expect(leadChannel("  ")).toBeNull();
  });

  it("keeps an unknown source as its own channel", () => {
    expect(leadChannel("the_knot")).toEqual({ key: "the_knot", label: "The Knot" });
  });
});

describe("buildLeadScoreboard", () => {
  it("always lists the three core channels, zero included", () => {
    const sb = buildLeadScoreboard([], TODAY, TZ);
    expect(sb.channels.map((c) => c.key)).toEqual(["website", "yelp", "google"]);
    expect(sb.hasData).toBe(false);
    expect(sb.total.last7).toBe(0);
    expect(sb.weekStarts).toHaveLength(8);
    expect(sb.weekStarts[7]).toBe("2026-10-28");
  });

  it("buckets by the office day, not the UTC day", () => {
    // 2026-11-04T03:00Z is still Nov 3 in New York → counts as today.
    // 2026-10-28T03:00Z is Oct 27 in New York → previous week, not this one.
    const sb = buildLeadScoreboard(
      [row("2026-11-04T03:00:00Z", "yelp", "a@x.com"), row("2026-10-28T03:00:00Z", "yelp", "b@x.com")],
      TODAY,
      TZ,
    );
    const y = channel(sb, "yelp");
    expect(y.last7).toBe(1);
    expect(y.prev7).toBe(1);
    expect(y.weekly[7]).toBe(1);
    expect(y.weekly[6]).toBe(1);
  });

  it("counts last 7, prior 7 and last 30 days per channel and in total", () => {
    const sb = buildLeadScoreboard(
      [
        row("2026-11-03T15:00:00Z", "web", "a@x.com"),
        row("2026-11-01T15:00:00Z", "web", "b@x.com"),
        row("2026-10-25T15:00:00Z", "google_ads", "c@x.com"),
        row("2026-10-10T15:00:00Z", "yelp", "d@x.com"),
        row("2026-09-01T15:00:00Z", "yelp", "e@x.com"), // before the 8-week window: not counted
      ],
      TODAY,
      TZ,
    );
    expect(channel(sb, "website")).toMatchObject({ last7: 2, prev7: 0, last30: 2 });
    expect(channel(sb, "google")).toMatchObject({ last7: 0, prev7: 1, last30: 1 });
    expect(channel(sb, "yelp")).toMatchObject({ last7: 0, prev7: 0, last30: 1 });
    expect(sb.total).toMatchObject({ last7: 2, prev7: 1, last30: 4 });
    expect(sb.total.weekly.reduce((a, b) => a + b, 0)).toBe(4);
    expect(sb.hasData).toBe(true);
  });

  it("counts the same person once per channel within a day", () => {
    const sb = buildLeadScoreboard(
      [
        row("2026-11-02T14:00:00Z", "web", "Same@X.com"),
        row("2026-11-02T14:05:00Z", "web", "same@x.com"),
        row("2026-11-02T20:00:00Z", "web", "", "(301) 555-1234"),
        row("2026-11-02T21:00:00Z", "web", "", "301-555-1234"),
        row("2026-11-02T22:00:00Z", "yelp", "same@x.com"), // other channel: counts
        row("2026-11-03T15:00:00Z", "web", "same@x.com"), // > 24h later: counts again
      ],
      TODAY,
      TZ,
    );
    expect(channel(sb, "website").last7).toBe(3);
    expect(channel(sb, "yelp").last7).toBe(1);
    expect(sb.repeats30).toBe(2);
  });

  it("never treats leads with no contact as repeats", () => {
    const sb = buildLeadScoreboard(
      [row("2026-11-02T14:00:00Z", "yelp"), row("2026-11-02T14:01:00Z", "yelp")],
      TODAY,
      TZ,
    );
    expect(channel(sb, "yelp").last7).toBe(2);
  });

  it("leaves out our own test submissions and sales-entered intakes", () => {
    const sb = buildLeadScoreboard(
      [
        row("2026-11-02T15:00:00Z", "web", "jessie.medalla@zoeeventsdmv.com"),
        row("2026-11-02T16:00:00Z", "manual", "client@x.com"),
        row("2026-11-02T17:00:00Z", null, "client2@x.com"),
      ],
      TODAY,
      TZ,
    );
    expect(sb.total.last30).toBe(0);
    expect(sb.internal30).toBe(1);
    expect(sb.hasData).toBe(false);
  });

  it("lists extra sources after the core channels, busiest first", () => {
    const sb = buildLeadScoreboard(
      [
        row("2026-11-01T15:00:00Z", "the_knot", "a@x.com"),
        row("2026-11-01T15:00:00Z", "instagram", "b@x.com"),
        row("2026-11-02T15:00:00Z", "instagram", "c@x.com"),
      ],
      TODAY,
      TZ,
    );
    expect(sb.channels.map((c) => c.key)).toEqual(["website", "yelp", "google", "instagram", "the_knot"]);
  });

  it("ignores future-dated and unparseable rows", () => {
    const sb = buildLeadScoreboard([row("2026-11-05T15:00:00Z", "web", "a@x.com"), row("not a date", "web", "b@x.com")], TODAY, TZ);
    expect(sb.total.last30).toBe(0);
  });
});
