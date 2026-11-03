import { describe, it, expect } from "vitest";
import { parseLeadPost, type SlackPostLike } from "./slackLeads";

// Text as the Slack API returns it (Slack escaping intact), in the shapes #new-leads posts use. All people,
// emails and numbers below are made up.
function post(text: string, username: string | null = "New Web form Submission", botId: string | null = "B123"): SlackPostLike {
  return { ts: "1793740852.000100", text, username, botId };
}

describe("parseLeadPost", () => {
  it("reads a website form post", () => {
    const p = parseLeadPost(
      post(
        "Reminder: Webform inquiries are time sensitive. We recommend sending clients a message ASAP, even if the quote isn't quite ready to send.\n\nName: Morgan Lake\nEvent Type: private\nEvent Date: 2026-11-26\nEmail: <mailto:morgan.lake@mail.com|morgan.lake@mail.com>\nPhone Number: 2025550100\nMessage: Long table &amp; chairs for 12",
      ),
    );
    expect(p).toMatchObject({ channel: "website", name: "Morgan Lake", email: "morgan.lake@mail.com", phone: "2025550100", isTest: false });
    expect(p?.receivedAt).toBe(new Date(1793740852000).toISOString());
  });

  it("reads a plain upper-case email and a tel link", () => {
    const p = parseLeadPost(post("Reminder: Webform inquiries are time sensitive.\n\nName: Ari Moss\nEmail: ARI.MOSS@MAIL.COM\nPhone Number: <tel:(202)555-0101|(202) 555-0101>\nMessage: tent"));
    expect(p).toMatchObject({ email: "ari.moss@mail.com", phone: "(202) 555-0101" });
  });

  it("reads a Goodshuffle wishlist post", () => {
    const p = parseLeadPost(
      post("Congrats! Robin Hale submitted a new Wishlist 'Hale - Community Hall' #231000001'./n/nA new project has been created in your account.\n\nReminder: Wishlist inquiries are time sensitive."),
    );
    expect(p).toMatchObject({ channel: "wishlist", name: "Robin Hale", ref: "231000001", email: "" });
  });

  it("reads the old Google Business Profile post", () => {
    const p = parseLeadPost(post("Reminder: Google Profile Lead inquiries are time sensitive.\n\nName : Casey Fox\nPhone Number: +12025550102\nEmail: <mailto:casey.fox@mail.com|casey.fox@mail.com>"));
    expect(p).toMatchObject({ channel: "google", name: "Casey Fox", email: "casey.fox@mail.com" });
  });

  it("reads the app's own Yelp and Google posts by their sender name", () => {
    const yelp = parseLeadPost(
      post(
        "Name: Lee K.\nEmail: <mailto:leadsapi+abc123@messaging.yelp.com|leadsapi+abc123@messaging.yelp.com> (Yelp relay address, replies reach the customer in Yelp)\nMessage: Yelp request: Party equipment rental",
        "New Yelp Lead",
      ),
    );
    expect(yelp).toMatchObject({ channel: "yelp", name: "Lee K.", email: "leadsapi+abc123@messaging.yelp.com" });
    const google = parseLeadPost(post("Name: Jo Park\nEmail: jo.park@mail.com\nPhone Number: 2025550103", "New Google Lead"));
    expect(google?.channel).toBe("google");
  });

  it("flags test submissions", () => {
    const p = parseLeadPost(
      post("Reminder: Webform inquiries are time sensitive.\n\nName: Zoetest Webform\nEmail: <mailto:check@example.com|check@example.com>\nMessage: TEST lead from a create check. Please ignore"),
    );
    expect(p?.isTest).toBe(true);
  });

  it("still reads a Zap post sent as a person", () => {
    const p = parseLeadPost(post("Reminder: Webform inquiries are time sensitive.\n\nName: Ari Moss\nEmail: ari.moss@mail.com", null, null));
    expect(p?.channel).toBe("website");
  });

  it("ignores team chat, forwarded emails and bot notices", () => {
    expect(parseLeadPost(post("Hale (#231000001)", null, null))).toBeNull(); // a person typing
    expect(parseLeadPost(post("Name: Someone\nEmail: a@b.com", null, null))).toBeNull(); // pasted by a person
    expect(parseLeadPost(post("<tel:(202)555-0199|(202) 555-0199> | example.com ---------- Forwarded message ---------"))).toBeNull();
    expect(parseLeadPost(post("<@U000> has joined the channel", "Viktor"))).toBeNull();
    expect(parseLeadPost(post("Received. I created the Goodshuffle project for Jo. Here is the link", "Viktor"))).toBeNull();
  });
});
