// Email checks (bounce protection). Made-up addresses and keys.
import { describe, expect, it, vi } from "vitest";
import { mapInstantly, checkVerdict, checkState, isFresh, domainTakesMail, verifyEmails, getCheck, VERIFY_TTL_DAYS } from "./verify";

const mxOk = async () => [{ exchange: "mx.example", priority: 1 }];

describe("reading Instantly's answer", () => {
  it("maps verified, invalid, catch-all and pending", () => {
    expect(mapInstantly({ verification_status: "verified", catch_all: false })).toBe("valid");
    expect(mapInstantly({ verification_status: "verified", catch_all: true })).toBe("catch_all");
    expect(mapInstantly({ verification_status: "verified", catch_all: "pending" })).toBe("pending");
    expect(mapInstantly({ verification_status: "invalid", catch_all: false })).toBe("invalid");
    expect(mapInstantly({ verification_status: "pending" })).toBe("pending");
  });
});

describe("what can be sent", () => {
  it("only verified addresses, and catch-all only when a list opts in", () => {
    expect(checkVerdict("valid").sendable).toBe(true);
    expect(checkVerdict("catch_all").sendable).toBe(false);
    expect(checkVerdict("catch_all", true).sendable).toBe(true);
    for (const s of ["invalid", "no_mail_server", "pending", "unchecked"] as const) expect(checkVerdict(s).sendable).toBe(false);
  });

  it("an old result counts as unchecked", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const old = { email: "a@x.example", result: "valid" as const, detail: null, provider: "instantly", creditsUsed: 1, checkedAt: new Date(now.getTime() - (VERIFY_TTL_DAYS + 1) * 86400_000).toISOString() };
    expect(isFresh(old, now)).toBe(false);
    expect(checkState(old, now)).toBe("unchecked");
    expect(checkState({ ...old, checkedAt: now.toISOString() }, now)).toBe("valid");
  });
});

describe("domain check", () => {
  it("no MX or no such domain means no mail; a DNS timeout is unknown", async () => {
    expect(await domainTakesMail("a.example", mxOk)).toBe(true);
    expect(await domainTakesMail("b.example", async () => [{ exchange: ".", priority: 0 }])).toBe(false); // null MX
    expect(await domainTakesMail("c.example", () => Promise.reject(Object.assign(new Error(), { code: "ENOTFOUND" })))).toBe(false);
    expect(await domainTakesMail("d.example", () => Promise.reject(Object.assign(new Error(), { code: "ETIMEOUT" })))).toBe(null);
  });
});

describe("verifyEmails", () => {
  it("sends the key as a bearer token, keeps it out of errors, and does not check an address twice", async () => {
    const f = vi.fn(async (_url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      expect(init?.headers?.Authorization).toBe("Bearer SECRETKEY");
      const { email } = JSON.parse(init!.body!);
      if (email === "boom@v.example") throw new Error("socket closed SECRETKEY");
      return { ok: true, status: 200, json: async () => ({ email, verification_status: "verified", catch_all: false, credits: 10, credits_used: 1 }) };
    });
    const run = await verifyEmails(["One@V.example", "one@v.example", "boom@v.example"], { key: "SECRETKEY", fetchImpl: f, mxLookup: mxOk });
    expect(run).toMatchObject({ checked: 1, remaining: 1, creditsLeft: 10, creditsUsed: 1 });
    expect(run.errors.join(" ")).not.toContain("SECRETKEY");
    expect(getCheck("one@v.example")?.result).toBe("valid");
    const again = await verifyEmails(["one@v.example"], { key: "SECRETKEY", fetchImpl: f, mxLookup: mxOk });
    expect(again.checked).toBe(0);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("without a key only the free domain check runs", async () => {
    const f = vi.fn();
    const mx = async (d: string) => (d === "nomail.example" ? Promise.reject(Object.assign(new Error(), { code: "ENODATA" })) : mxOk());
    const run = await verifyEmails(["a@nomail.example", "b@fine.example"], { key: null, fetchImpl: f, mxLookup: mx });
    expect(run.counts.no_mail_server).toBe(1);
    expect(run.remaining).toBe(1);
    expect(run.stopped).toContain("Instantly API key");
    expect(f).not.toHaveBeenCalled();
  });
});
