// Connecteam user-provisioning client (the REAL People-Lifecycle automation). Mocks fetch to verify the
// exact create/archive requests, the userId parse, the sendActivation DEFAULT-FALSE guard, and that a 403
// is surfaced as scopeMissing (never faked as success).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveConnecteamUser, connecteamWriteProbe, createConnecteamUser } from "./connecteam";

beforeEach(() => {
  process.env.CONNECTEAM_API_KEY = "test-key";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONNECTEAM_API_KEY;
});

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", fn);
  return fn;
}

const USER = { firstName: "Pat", lastName: "Driver", phoneNumber: "+12025550123", userType: "user" as const };

describe("createConnecteamUser", () => {
  it("POSTs a JSON ARRAY (even for one), parses the userId, and does NOT send activation by default", async () => {
    const fn = mockFetch(200, { data: { results: [{ userId: 7788 }] } });
    const r = await createConnecteamUser([USER]);
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(7788);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/users/v1/users");
    expect(url).not.toContain("sendActivation"); // default FALSE — no SMS during provisioning/tests
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body));
    expect(Array.isArray(sent)).toBe(true);
    expect(sent[0].phoneNumber).toBe(USER.phoneNumber);
    expect(sent[0].userType).toBe("user");
  });

  it("adds ?sendActivation=true only when explicitly asked", async () => {
    const fn = mockFetch(200, { data: { results: [{ userId: 1 }] } });
    await createConnecteamUser([USER], { sendActivation: true });
    const [url] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("sendActivation=true");
  });

  it("surfaces a 403 as scopeMissing (never fakes success)", async () => {
    mockFetch(403, { message: "forbidden" });
    const r = await createConnecteamUser([USER]);
    expect(r.ok).toBe(false);
    expect(r.scopeMissing).toBe(true);
    expect(r.userId).toBeUndefined();
  });

  it("is honest when Connecteam is not configured (no call)", async () => {
    delete process.env.CONNECTEAM_API_KEY;
    const fn = mockFetch(200, {});
    const r = await createConnecteamUser([USER]);
    expect(r.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("archiveConnecteamUser", () => {
  it("DELETEs with deletionType=archive and reports ok", async () => {
    const fn = mockFetch(200, {});
    const r = await archiveConnecteamUser(7788);
    expect(r.ok).toBe(true);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/users/v1/users/7788");
    expect(url).toContain("deletionType=archive");
    expect(init.method).toBe("DELETE");
  });

  it("surfaces a 403 as scopeMissing", async () => {
    mockFetch(403, { message: "forbidden" });
    const r = await archiveConnecteamUser(7788);
    expect(r.ok).toBe(false);
    expect(r.scopeMissing).toBe(true);
  });
});

describe("connecteamWriteProbe", () => {
  it("POSTs an EMPTY array (creates nothing) and reports scope present on a non-403", async () => {
    const fn = mockFetch(400, { message: "no users supplied" });
    const r = await connecteamWriteProbe();
    expect(JSON.parse(String((fn.mock.calls[0] as [string, RequestInit])[1].body))).toEqual([]);
    expect(r.scopeMissing).toBe(false);
    expect(r.ok).toBe(true); // allowed to write (just sent nothing)
  });

  it("reports scopeMissing on a 403", async () => {
    mockFetch(403, {});
    const r = await connecteamWriteProbe();
    expect(r.scopeMissing).toBe(true);
    expect(r.ok).toBe(false);
  });
});
