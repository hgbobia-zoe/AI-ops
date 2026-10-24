import { afterEach, describe, expect, it } from "vitest";
import {
  coerceEnvironment,
  originForEnvironment,
  websiteEnvUrls,
  DEFAULT_WEBSITE_PROD_URL,
  DEFAULT_WEBSITE_LOCAL_URL,
} from "./config";

const ENV_KEYS = ["WEBSITE_PROD_URL", "WEBSITE_LOCAL_URL", "WEBSITE_PREVIEW_URL"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("website config", () => {
  it("coerceEnvironment only accepts 'local'; everything else is 'production'", () => {
    expect(coerceEnvironment("local")).toBe("local");
    expect(coerceEnvironment("production")).toBe("production");
    expect(coerceEnvironment("staging")).toBe("production");
    expect(coerceEnvironment(undefined)).toBe("production");
    expect(coerceEnvironment(null)).toBe("production");
    expect(coerceEnvironment(42)).toBe("production");
  });

  it("falls back to the in-code defaults when nothing is configured", () => {
    const urls = websiteEnvUrls();
    expect(urls.production).toBe(DEFAULT_WEBSITE_PROD_URL);
    expect(urls.local).toBe(DEFAULT_WEBSITE_LOCAL_URL);
  });

  it("honors env overrides and strips trailing slashes", () => {
    process.env.WEBSITE_PROD_URL = "https://example.com/";
    process.env.WEBSITE_LOCAL_URL = "http://my.local:8080///";
    const urls = websiteEnvUrls();
    expect(urls.production).toBe("https://example.com");
    expect(urls.local).toBe("http://my.local:8080");
  });

  it("local falls back to WEBSITE_PREVIEW_URL (the runner's origin) when WEBSITE_LOCAL_URL is unset", () => {
    process.env.WEBSITE_PREVIEW_URL = "http://zoe.preview.local";
    expect(websiteEnvUrls().local).toBe("http://zoe.preview.local");
  });

  it("originForEnvironment resolves the right origin", () => {
    const urls = { production: "https://p.example", local: "http://l.example" };
    expect(originForEnvironment("production", urls)).toBe("https://p.example");
    expect(originForEnvironment("local", urls)).toBe("http://l.example");
  });
});
