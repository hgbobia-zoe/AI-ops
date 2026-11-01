import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const slack = vi.hoisted(() => ({
  slackBotConfigured: vi.fn(() => true),
  slackConversationsHistory: vi.fn(),
  slackJoinChannel: vi.fn(async () => ({ ok: true })),
  slackPostAs: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/notify/slack", () => slack);

import { getDb } from "@/lib/db";
import { createIntake, getIntake, updateIntake } from "./store";
import { findLeadPost, leadReplyText, replyForIntake, replyToLeadPost, runLeadSlackReplySweep } from "./leadSlackReply";
import type { SlackMessage } from "@/lib/notify/slack";

const NOW = Date.parse("2026-11-01T19:10:00Z");
const tsAt = (iso: string): string => (Date.parse(iso) / 1000).toFixed(6);

function zapPost(iso: string, name: string, email: string, phone: string): SlackMessage {
  return {
    ts: tsAt(iso),
    user: null,
    botId: "B09FN9F3UMR",
    username: null,
    text: `Reminder: Webform inquiries are time sensitive.\n\nName: ${name}\nEvent Type: private\nEmail: <mailto:${email}|${email}>\nPhone Number: ${phone}\nMessage: hi`,
  };
}

function webLead(over: { email?: string; phone?: string; createdAt?: string; source?: string } = {}) {
  const i = createIntake({ source: over.source ?? "zoeeventsdmv.com", firstName: "Ann", lastName: "Murtlow", email: over.email ?? "murts86@gmail.com", phone: over.phone ?? "3173081889" });
  getDb().prepare("UPDATE sales_intake SET created_at = ? WHERE id = ?").run(over.createdAt ?? "2026-11-01T19:00:00Z", i.id);
  updateIntake(i.id, { gsProjectId: "231976481", gsProjectUrl: "https://pro.goodshuffle.com/app/project/detail?id=231976481", status: "created", gsStatus: "created", completedAt: new Date(NOW).toISOString() });
  return getIntake(i.id)!;
}

beforeEach(() => {
  // Each test starts clean: earlier intakes count as answered, and no thread is marked as answered.
  getDb().prepare("UPDATE sales_intake SET slack_reply_at = 'old', slack_reply_ts = NULL").run();
  slack.slackPostAs.mockReset().mockResolvedValue({ ok: true });
  slack.slackConversationsHistory.mockReset();
  slack.slackBotConfigured.mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("findLeadPost", () => {
  const lead = { email: "Murts86@gmail.com", phone: "(317) 308-1889", recordedAt: "2026-11-01T19:00:00Z" };

  it("matches the email inside Slack's mailto link", () => {
    const post = zapPost("2026-11-01T18:59:50Z", "Ann Murtlow", "murts86@gmail.com", "0000000000");
    expect(findLeadPost([post], lead)?.ts).toBe(post.ts);
  });

  it("matches the phone when the email differs", () => {
    const post = zapPost("2026-11-01T18:59:50Z", "Ann Murtlow", "other@x.com", "3173081889");
    expect(findLeadPost([post], lead)?.ts).toBe(post.ts);
  });

  it("ignores another lead and posts outside the time window", () => {
    const other = zapPost("2026-11-01T18:59:50Z", "Someone Else", "else@x.com", "2025550100");
    const tooOld = zapPost("2026-10-25T12:00:00Z", "Ann Murtlow", "murts86@gmail.com", "3173081889");
    const tooLate = zapPost("2026-11-01T19:30:00Z", "Ann Murtlow", "murts86@gmail.com", "3173081889");
    expect(findLeadPost([other, tooOld, tooLate], lead)).toBeNull();
  });

  it("finds a post from the day before for a lead recorded late (backfill)", () => {
    const post = zapPost("2026-11-01T00:09:43Z", "Ann Murtlow", "murts86@gmail.com", "3173081889");
    expect(findLeadPost([post], lead)?.ts).toBe(post.ts);
  });

  it("picks the newest submission when the person sent the form twice", () => {
    const a = zapPost("2026-10-31T10:00:00Z", "Ann Murtlow", "murts86@gmail.com", "3173081889");
    const b = zapPost("2026-11-01T18:59:00Z", "Ann Murtlow", "murts86@gmail.com", "3173081889");
    expect(findLeadPost([a, b], lead)?.ts).toBe(b.ts);
  });
});

describe("leadReplyText", () => {
  it("says received, created, and links the project, with no dashes", () => {
    const t = leadReplyText(webLead());
    expect(t).toContain("Received. I created the Goodshuffle project for Ann Murtlow.");
    expect(t).toContain("<https://pro.goodshuffle.com/app/project/detail?id=231976481|Project 231976481>");
    expect(t).not.toMatch(/[–—]| - /);
  });
});

describe("replyForIntake", () => {
  const post = zapPost("2026-11-01T18:59:50Z", "Ann Murtlow", "murts86@gmail.com", "3173081889");

  it("replies once, in the post's thread, as Viktor", async () => {
    const i = webLead();
    expect((await replyForIntake(i, [post])).status).toBe("posted");
    expect(slack.slackPostAs).toHaveBeenCalledTimes(1);
    const [channel, persona, , opts] = slack.slackPostAs.mock.calls[0] as unknown as [string, { name: string }, string, { threadTs: string }];
    expect(channel).toBe("C09FMGDJE13");
    expect(persona.name).toBe("Viktor");
    expect(opts.threadTs).toBe(post.ts);
    expect((await replyForIntake(getIntake(i.id)!, [post])).status).toBe("already");
    expect(slack.slackPostAs).toHaveBeenCalledTimes(1);
  });

  it("a second intake for the same post never replies twice in the thread", async () => {
    await replyForIntake(webLead(), [post]);
    const again = await replyForIntake(webLead(), [post]);
    expect(again.status).toBe("already");
    expect(slack.slackPostAs).toHaveBeenCalledTimes(1);
  });

  it("in-app intakes are skipped (no Slack post to answer)", async () => {
    expect((await replyForIntake(webLead({ source: "manual" }), [post])).status).toBe("skipped");
    expect(slack.slackPostAs).not.toHaveBeenCalled();
  });

  it("no matching post: nothing is posted", async () => {
    expect((await replyForIntake(webLead({ email: "nobody@x.com", phone: "2025550199" }), [post])).status).toBe("not_found");
    expect(slack.slackPostAs).not.toHaveBeenCalled();
  });

  it("a failed post releases the claim so the next try can reply", async () => {
    const i = webLead();
    slack.slackPostAs.mockResolvedValueOnce({ ok: false, error: "post: ratelimited" } as never);
    expect((await replyForIntake(i, [post])).status).toBe("error");
    expect((await replyForIntake(getIntake(i.id)!, [post])).status).toBe("posted");
  });
});

describe("replyToLeadPost / sweep", () => {
  const post = zapPost("2026-11-01T18:59:50Z", "Ann Murtlow", "murts86@gmail.com", "3173081889");

  it("joins the channel once when Viktor is not a member, then replies", async () => {
    const i = webLead();
    slack.slackConversationsHistory
      .mockResolvedValueOnce({ ok: false, error: "not_in_channel", messages: [] })
      .mockResolvedValueOnce({ ok: true, messages: [post] });
    expect((await replyToLeadPost(i.id)).status).toBe("posted");
    expect(slack.slackJoinChannel).toHaveBeenCalledWith("C09FMGDJE13");
  });

  it("the sweep replies to every waiting lead with one channel read", async () => {
    webLead();
    webLead({ email: "ashleighemcgovern@gmail.com", phone: "2025946196" });
    const post2 = zapPost("2026-11-01T14:07:49Z", "Ashleigh McGovern", "ashleighemcgovern@gmail.com", "2025946196");
    slack.slackConversationsHistory.mockResolvedValue({ ok: true, messages: [post, post2] });
    const r = await runLeadSlackReplySweep(NOW);
    expect(r.detail).toBe("2 replied, 0 with no matching post, 0 failed");
    expect(slack.slackConversationsHistory).toHaveBeenCalledTimes(1);
    expect((await runLeadSlackReplySweep(NOW)).detail).toBe("no lead waiting for a Slack reply");
  });

  it("without a bot token nothing is attempted", async () => {
    webLead();
    slack.slackBotConfigured.mockReturnValue(false);
    expect((await runLeadSlackReplySweep(NOW)).detail).toContain("no Slack bot token");
    expect(slack.slackConversationsHistory).not.toHaveBeenCalled();
  });
});
