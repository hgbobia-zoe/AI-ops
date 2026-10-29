import { afterEach, describe, expect, it } from "vitest";
import {
  coerceEnvironment,
  originForEnvironment,
  websiteEnvUrls,
  websiteRepoSlug,
  websiteDeployBranch,
  websiteAutoMerge,
  workingBranchPrefix,
  workingBranchForJob,
  DEFAULT_WEBSITE_PROD_URL,
  DEFAULT_WEBSITE_LOCAL_URL,
  DEFAULT_WEBSITE_REPO_SLUG,
  DEFAULT_WEBSITE_DEPLOY_BRANCH,
  DEFAULT_WEBSITE_AUTO_MERGE,
} from "./config";

const ENV_KEYS = [
  "WEBSITE_PROD_URL",
  "WEBSITE_LOCAL_URL",
  "WEBSITE_PREVIEW_URL",
  "WEBSITE_REPO_SLUG",
  "WEBSITE_DEPLOY_BRANCH",
  "WEBSITE_WORKING_BRANCH_PREFIX",
  "WEBSITE_AUTO_MERGE",
] as const;

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

  describe("branch / merge model", () => {
    it("defaults the target repo to the Zoe website repo and honors WEBSITE_REPO_SLUG", () => {
      expect(websiteRepoSlug()).toBe(DEFAULT_WEBSITE_REPO_SLUG);
      expect(DEFAULT_WEBSITE_REPO_SLUG).toBe("hgbobia-zoe/zoe-event-rentals");
      process.env.WEBSITE_REPO_SLUG = "  someone/other-repo  ";
      expect(websiteRepoSlug()).toBe("someone/other-repo"); // trimmed
    });

    it("defaults the deploy branch to master and honors WEBSITE_DEPLOY_BRANCH", () => {
      expect(websiteDeployBranch()).toBe(DEFAULT_WEBSITE_DEPLOY_BRANCH);
      expect(DEFAULT_WEBSITE_DEPLOY_BRANCH).toBe("master");
      process.env.WEBSITE_DEPLOY_BRANCH = "release";
      expect(websiteDeployBranch()).toBe("release");
    });

    it("builds a deterministic, clearly-non-master working branch for a job", () => {
      expect(workingBranchPrefix()).toBe("website-studio/");
      expect(workingBranchForJob("WJ-123")).toBe("website-studio/WJ-123");
      // The working branch is never the deploy branch.
      expect(workingBranchForJob("WJ-123")).not.toBe(websiteDeployBranch());
    });

    it("honors + normalizes WEBSITE_WORKING_BRANCH_PREFIX (always a single trailing slash)", () => {
      process.env.WEBSITE_WORKING_BRANCH_PREFIX = "marketing/site///";
      expect(workingBranchPrefix()).toBe("marketing/site/");
      expect(workingBranchForJob("WJ-9")).toBe("marketing/site/WJ-9");

      process.env.WEBSITE_WORKING_BRANCH_PREFIX = "   ";
      expect(workingBranchPrefix()).toBe("website-studio/"); // blank falls back to the default
    });

    describe("websiteAutoMerge (default = immediate merge; opt-in to native auto-merge)", () => {
      it("defaults to false (immediate merge) when WEBSITE_AUTO_MERGE is unset", () => {
        expect(DEFAULT_WEBSITE_AUTO_MERGE).toBe(false);
        expect(websiteAutoMerge()).toBe(false);
      });

      it("opts into GitHub native auto-merge for truthy values", () => {
        for (const v of ["1", "true", "TRUE", "yes", "on", " on ", "On"]) {
          process.env.WEBSITE_AUTO_MERGE = v;
          expect(websiteAutoMerge()).toBe(true);
        }
      });

      it("stays immediate (false) for 0/false/no/off and any other value", () => {
        for (const v of ["0", "false", "no", "off", "", "   ", "maybe", "2"]) {
          process.env.WEBSITE_AUTO_MERGE = v;
          expect(websiteAutoMerge()).toBe(false);
        }
      });
    });
  });
});
