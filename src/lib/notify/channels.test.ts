import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy the transports but keep channelFor / cardToText real, so we test BOTH the channel resolution
// (sales → sales-ai) and the dispatch (which transport each domain uses).
vi.mock("@/lib/notify/aiBots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify/aiBots")>();
  return { ...actual, botAnnounce: vi.fn(async () => ({ ok: true })) };
});
vi.mock("@/lib/notify/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify/slack")>();
  return {
    ...actual,
    slackNotifyAlert: vi.fn(async () => ({ ok: true })),
    slackNotify: vi.fn(async () => ({ ok: true })),
  };
});

import { notify, DOMAIN_ROUTING, salesAiChannel } from "@/lib/notify/channels";
import { botAnnounce } from "@/lib/notify/aiBots";
import { slackNotifyAlert, slackNotify } from "@/lib/notify/slack";

beforeEach(() => {
  delete process.env.SLACK_CHANNEL_SALES;
  delete process.env.SALES_AI_SLACK_CHANNEL;
  delete process.env.SLACK_AI_CHANNEL;
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.SLACK_CHANNEL_SALES;
  delete process.env.SALES_AI_SLACK_CHANNEL;
});

describe("central routing map", () => {
  it("sales routes to the sales-ai channel by default", () => {
    expect(DOMAIN_ROUTING.sales.transport).toBe("sales-bot");
    expect(DOMAIN_ROUTING.sales.channel()).toBe("sales-ai");
    expect(salesAiChannel()).toBe("sales-ai");
  });

  it("the sales-ai channel is configurable via SALES_AI_SLACK_CHANNEL (and SLACK_CHANNEL_SALES wins)", () => {
    process.env.SALES_AI_SLACK_CHANNEL = "C-SALES-123";
    expect(salesAiChannel()).toBe("C-SALES-123");
    process.env.SLACK_CHANNEL_SALES = "C-OVERRIDE";
    expect(salesAiChannel()).toBe("C-OVERRIDE");
  });

  it("customer alerts stay on the customer-alerts transport; ops on the ops webhook", () => {
    expect(DOMAIN_ROUTING.customer.transport).toBe("customer-alerts");
    expect(DOMAIN_ROUTING.ops.transport).toBe("ops-webhook");
  });
});

describe("notify() dispatch", () => {
  it("a SALES notification goes through the Sales bot persona (→ sales-ai)", async () => {
    await notify("sales", "a sales lead update");
    expect(botAnnounce).toHaveBeenCalledWith("sales", "a sales lead update");
    expect(slackNotifyAlert).not.toHaveBeenCalled();
  });

  it("a frustrated-caller (customer) alert goes to the customer-alerts webhook", async () => {
    await notify("customer", "frustrated caller");
    expect(slackNotifyAlert).toHaveBeenCalledWith("frustrated caller");
    expect(botAnnounce).not.toHaveBeenCalled();
  });

  it("an ops alert goes to the ops webhook", async () => {
    await notify("ops", "dispatch failure");
    expect(slackNotify).toHaveBeenCalledWith("dispatch failure");
  });
});
