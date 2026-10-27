import { describe, it, expect, afterEach } from "vitest";
import { checkGustoRunnerToken, gustoRunnerConfigured } from "./gustoRunnerAuth";

const ORIG = process.env.GUSTO_RUNNER_TOKEN;
afterEach(() => {
  if (ORIG === undefined) delete process.env.GUSTO_RUNNER_TOKEN;
  else process.env.GUSTO_RUNNER_TOKEN = ORIG;
});

describe("gustoRunnerAuth", () => {
  it("fails CLOSED when the token env is unset (unconfigured → 503)", () => {
    delete process.env.GUSTO_RUNNER_TOKEN;
    expect(checkGustoRunnerToken("anything")).toBe("unconfigured");
    expect(checkGustoRunnerToken(null)).toBe("unconfigured");
    expect(gustoRunnerConfigured()).toBe(false);
  });

  it("accepts an exact match and rejects everything else when configured", () => {
    process.env.GUSTO_RUNNER_TOKEN = "s3cret-token";
    expect(checkGustoRunnerToken("s3cret-token")).toBe("ok");
    expect(checkGustoRunnerToken("wrong")).toBe("forbidden");
    expect(checkGustoRunnerToken("")).toBe("forbidden");
    expect(checkGustoRunnerToken(null)).toBe("forbidden");
    expect(checkGustoRunnerToken(undefined)).toBe("forbidden");
    expect(gustoRunnerConfigured()).toBe(true);
  });
});
