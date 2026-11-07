import { afterEach, describe, expect, it } from "vitest";
import { checkMachineToken, configuredTokens, presentedToken, requireMachineToken } from "./machineToken";

const ENV = "TEST_MACHINE_TOKEN";

afterEach(() => {
  delete process.env[ENV];
});

describe("checkMachineToken", () => {
  it("is unconfigured (never open) when the env var is unset or blank", () => {
    expect(checkMachineToken(ENV, "anything")).toBe("unconfigured");
    process.env[ENV] = "  ,  ";
    expect(checkMachineToken(ENV, "anything")).toBe("unconfigured");
  });

  it("rejects a missing or wrong token", () => {
    process.env[ENV] = "s3cret";
    expect(checkMachineToken(ENV, null)).toBe("forbidden");
    expect(checkMachineToken(ENV, "")).toBe("forbidden");
    expect(checkMachineToken(ENV, "s3cre")).toBe("forbidden");
    expect(checkMachineToken(ENV, "s3cret-extra")).toBe("forbidden");
  });

  it("accepts the right token, and any of several during a rotation", () => {
    process.env[ENV] = "old-token, new-token";
    expect(configuredTokens(ENV)).toEqual(["old-token", "new-token"]);
    expect(checkMachineToken(ENV, "old-token")).toBe("ok");
    expect(checkMachineToken(ENV, " new-token ")).toBe("ok");
  });
});

describe("requireMachineToken", () => {
  const req = (headers: Record<string, string> = {}, url = "https://x.test/api/thing") => new Request(url, { method: "POST", headers });

  it("answers 503 when the server has no token", async () => {
    const res = requireMachineToken(req({ "x-t": "abc" }), { env: ENV, header: "x-t" });
    expect(res?.status).toBe(503);
    expect(JSON.stringify(await res!.json())).not.toContain("abc");
  });

  it("answers 401 for a wrong token and ignores a token in the query string", () => {
    process.env[ENV] = "abc";
    expect(requireMachineToken(req({ "x-t": "nope" }), { env: ENV, header: "x-t" })?.status).toBe(401);
    expect(requireMachineToken(req({}, "https://x.test/api/thing?token=abc"), { env: ENV, header: "x-t" })?.status).toBe(401);
  });

  it("passes with the header, or a Bearer token when allowed", () => {
    process.env[ENV] = "abc";
    expect(requireMachineToken(req({ "x-t": "abc" }), { env: ENV, header: "x-t" })).toBeNull();
    expect(requireMachineToken(req({ authorization: "Bearer abc" }), { env: ENV, header: "x-t", bearer: true })).toBeNull();
    expect(requireMachineToken(req({ authorization: "Bearer abc" }), { env: ENV, header: "x-t" })?.status).toBe(401);
    expect(presentedToken(req({ authorization: "bearer abc" }), { header: "x-t", bearer: true })).toBe("abc");
  });
});
