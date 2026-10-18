import { afterEach, describe, expect, it } from "vitest";
import { BOTS, channelFor, botForAgent, appUrl, type BotId } from "./aiBots";

const ENV_KEYS = ["SLACK_CHANNEL_SCHEDULING", "SLACK_AI_CHANNEL", "PUBLIC_BASE_URL"];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("aiBots channel routing", () => {
  it("every bot has a persona (name + icon) and a default channel", () => {
    for (const [id, cfg] of Object.entries(BOTS)) {
      expect(cfg.name, id).toBeTruthy();
      expect(cfg.icon, id).toMatch(/^:.+:$/); // a Slack emoji shortcode
      expect(cfg.defaultChannel, id).toBeTruthy();
    }
  });

  it("defaults the scheduling bot to #finalized-delivery-schedules", () => {
    expect(channelFor("scheduling")).toBe("finalized-delivery-schedules");
  });

  it("an env override wins over the default", () => {
    process.env.SLACK_CHANNEL_SCHEDULING = "crew-ops";
    expect(channelFor("scheduling")).toBe("crew-ops");
  });

  it("falls back to SLACK_AI_CHANNEL only when a bot has no default (none do, so this is belt-and-suspenders)", () => {
    // Sanity: the known bots all resolve without SLACK_AI_CHANNEL set.
    const ids: BotId[] = ["scheduling", "pricing", "sales", "reviews", "inventory", "hiring", "data", "ops"];
    for (const id of ids) expect(channelFor(id)).toBeTruthy();
  });
});

describe("botForAgent", () => {
  it("routes sales proposers to the sales bot and unknowns to ops", () => {
    expect(botForAgent("outreach")).toBe("sales");
    expect(botForAgent("lost-quote")).toBe("sales");
    expect(botForAgent("hiring")).toBe("hiring");
    expect(botForAgent("something-unmapped")).toBe("ops");
  });
});

describe("appUrl (card 'View in app' links)", () => {
  it("builds an absolute URL from PUBLIC_BASE_URL, or null when unset so the button drops", () => {
    expect(appUrl("/scheduling")).toBeNull(); // unset → no button
    process.env.PUBLIC_BASE_URL = "https://zoe-dispatch.fly.dev/";
    expect(appUrl("/scheduling")).toBe("https://zoe-dispatch.fly.dev/scheduling");
    expect(appUrl("ai-org/approvals")).toBe("https://zoe-dispatch.fly.dev/ai-org/approvals");
  });
});
