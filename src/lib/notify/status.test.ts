import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const slack = vi.hoisted(() => ({
  botOn: false,
  postAs: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string; skipped?: boolean }),
  rich: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string; skipped?: boolean }),
}));
vi.mock("./slack", async (orig) => ({
  ...(await orig<typeof import("./slack")>()),
  slackBotConfigured: () => slack.botOn,
  slackPostAs: slack.postAs,
  slackWebhookRich: slack.rich,
}));

import {
  classifyFailure,
  cleanDetail,
  decideStatus,
  failureAlert,
  noDashes,
  postStatus,
  redactSecrets,
  statusAttachment,
  statusChannel,
  statusContext,
  statusText,
  type StatusAlert,
} from "./status";

const NOW = Date.parse("2026-11-09T19:00:00Z"); // 2:00 PM Eastern

const ignition: StatusAlert = {
  system: "Ignition",
  level: "down",
  title: "Ignition is signed out on the office computer",
  impact: "Customer tracking links fall back to the basic page.",
  fix: "Sign in at ignition.zonarsystems.com on the office computer.",
  since: "2026-11-09T18:20:00Z",
  detail: "HTTP 401",
};

describe("status card text", () => {
  it("reads as title, impact, fix, then one small context line", () => {
    const t = statusText(ignition, NOW);
    expect(t.split("\n")).toEqual([
      "Ignition is signed out on the office computer",
      "Impact: Customer tracking links fall back to the basic page.",
      "What to do: Sign in at ignition.zonarsystems.com on the office computer.",
      "Ignition | Down since 1:20 PM (40 min) | Detail: HTTP 401",
    ]);
  });

  it("says how long it was down when it recovers", () => {
    expect(statusContext({ system: "Ignition", level: "recovered", title: "back", since: "2026-11-09T17:45:00Z" }, NOW)).toBe("Ignition | Back after 1 h 15 min");
  });

  it("shows when a rate limit clears", () => {
    const c = statusContext({ system: "Connecteam", level: "degraded", title: "x", until: "2026-11-10T00:00:00Z" }, NOW);
    expect(c).toBe("Connecteam | Degraded | Clears 7:00 PM");
  });

  it("colors the card by level and keeps a button only when there is a url", () => {
    expect(statusAttachment(ignition, NOW).color).toBe("#D93F3F");
    expect(statusAttachment({ ...ignition, level: "degraded" }, NOW).color).toBe("#E8A33D");
    expect(statusAttachment({ ...ignition, level: "recovered" }, NOW).color).toBe("#2EB67D");
    const blocks = (a: StatusAlert) => statusAttachment(a, NOW).blocks as { type: string }[];
    expect(blocks(ignition).some((b) => b.type === "actions")).toBe(false);
    expect(blocks({ ...ignition, link: { text: "Open settings", url: "https://x/admin" } }).some((b) => b.type === "actions")).toBe(true);
  });

  it("never uses dashes as punctuation or emoji", () => {
    expect(noDashes("Down — sign in")).toBe("Down, sign in");
    expect(noDashes("Down - sign in")).toBe("Down, sign in");
    expect(noDashes("re-paste the sign-in")).toBe("re-paste the sign-in");
    const t = statusText({ ...ignition, title: "Ignition — signed out", impact: "Links – basic page" }, NOW);
    expect(t).not.toMatch(/[—–]| - /);
    expect(t).toMatch(/^[\x00-\x7F]+$/);
  });
});

describe("secrets never reach Slack", () => {
  it("redacts keys, tokens, bearer headers and long opaque strings", () => {
    expect(redactSecrets("GET /geocode?address=x&key=AIzaSyABCDEF123 failed")).toBe("GET /geocode?address=x&key=[redacted] failed");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop")).not.toMatch(/abcdefghijklmnop/);
    expect(redactSecrets("x-intake-token: s3cr3tvalue")).toBe("x-intake-token: [redacted]");
    expect(redactSecrets("anthropic sk-ant-api03-AAAAAAAAAAAAAAAA invalid")).not.toMatch(/AAAAAAAA/);
    expect(redactSecrets("HTTP 403")).toBe("HTTP 403");
  });

  it("cuts long detail short", () => {
    expect(cleanDetail("x ".repeat(400))!.length).toBeLessThanOrEqual(240);
    expect(cleanDetail("")).toBeNull();
  });
});

describe("classifyFailure", () => {
  it("tells rate limits, rejected keys and outages apart", () => {
    expect(classifyFailure("HTTP 429 Too Many Requests")).toBe("rate_limit");
    expect(classifyFailure("OVER_QUERY_LIMIT")).toBe("rate_limit");
    expect(classifyFailure("REQUEST_DENIED: The provided API key is invalid")).toBe("auth");
    expect(classifyFailure("openphone 401")).toBe("auth");
    expect(classifyFailure("TypeError: fetch failed")).toBe("unreachable");
    expect(classifyFailure("HTTP 503")).toBe("unreachable");
    expect(classifyFailure("weird")).toBe("error");
  });

  it("builds a human title from the kind", () => {
    expect(failureAlert("Google Maps", "HTTP 429").title).toBe("Google Maps is rate limited");
    expect(failureAlert("Zonar GPS", "HTTP 401").title).toBe("Zonar GPS rejected our login or API key");
    expect(failureAlert("Zonar GPS", "fetch failed").title).toBe("Zonar GPS is not responding");
  });
});

describe("decideStatus (down once, recovered once)", () => {
  const H = 3_600_000;
  it("waits out the sustain window, pages once, then recovers once", () => {
    let rec = {};
    let d = decideStatus(rec, true, NOW, { sustainMs: 30 * 60_000 });
    expect(d.post).toBeNull();
    rec = d.next;
    d = decideStatus(rec, true, NOW + 31 * 60_000, { sustainMs: 30 * 60_000 });
    expect(d.post).toBe("down");
    expect(d.failingSince).toBe(new Date(NOW).toISOString());
    rec = d.next;
    expect(decideStatus(rec, true, NOW + H, { sustainMs: 30 * 60_000 }).post).toBeNull(); // cool-off
    d = decideStatus(rec, false, NOW + H);
    expect(d.post).toBe("recovered");
    expect(decideStatus(d.next, false, NOW + 2 * H).post).toBeNull();
  });

  it("a blip that recovers before paging stays silent", () => {
    const d = decideStatus({}, true, NOW, { sustainMs: 30 * 60_000 });
    expect(decideStatus(d.next, false, NOW + 60_000).post).toBeNull();
  });
});

describe("postStatus routing", () => {
  beforeEach(() => {
    slack.botOn = false;
    slack.postAs.mockReset().mockResolvedValue({ ok: true });
    slack.rich.mockReset().mockResolvedValue({ ok: true });
    delete process.env.SLACK_CHANNEL_STATUS;
    delete process.env.SLACK_STATUS_WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = "https://hooks.example/ops";
  });
  afterEach(() => {
    delete process.env.SLACK_WEBHOOK_URL;
  });

  it("posts to ai-ops-status as System Status when the bot is set up", async () => {
    slack.botOn = true;
    await postStatus(ignition, NOW);
    expect(statusChannel()).toBe("ai-ops-status");
    expect(slack.postAs).toHaveBeenCalledTimes(1);
    const [channel, persona, text, opts] = slack.postAs.mock.calls[0] as unknown as [string, { name: string }, string, { attachments: unknown[] }];
    expect(channel).toBe("ai-ops-status");
    expect(persona.name).toBe("System Status");
    expect(text).toBe("Ignition is signed out on the office computer");
    expect(opts.attachments).toHaveLength(1);
    expect(slack.rich).not.toHaveBeenCalled();
  });

  it("honors SLACK_CHANNEL_STATUS", async () => {
    slack.botOn = true;
    process.env.SLACK_CHANNEL_STATUS = "C0STATUS1";
    await postStatus(ignition, NOW);
    expect((slack.postAs.mock.calls[0] as unknown as [string])[0]).toBe("C0STATUS1");
  });

  it("falls back to the ops webhook so an outage is never silent", async () => {
    slack.botOn = true;
    slack.postAs.mockResolvedValue({ ok: false, error: "post: channel_not_found" });
    await postStatus(ignition, NOW);
    expect(slack.rich).toHaveBeenCalledWith("https://hooks.example/ops", expect.any(String), expect.objectContaining({ attachments: expect.any(Array) }));
  });

  it("prefers a dedicated status webhook over the ops one", async () => {
    process.env.SLACK_STATUS_WEBHOOK_URL = "https://hooks.example/status";
    await postStatus(ignition, NOW);
    expect(slack.rich).toHaveBeenCalledTimes(1);
    expect((slack.rich.mock.calls[0] as unknown as [string])[0]).toBe("https://hooks.example/status");
  });
});
